// What the inference proxy refuses inside a request body: anything that makes the provider fetch
// content by reference -- a URL, or a file stored on the provider's side -- at any depth.
//
// The proxy is the only outbound path an agent has (rules §2.3), and in the live week it forwards with
// the participant's own credential. The top-level keys it refuses (`tools`, `file_ids`,
// `previous_response_id`, ...) did not reach into the messages, so a content part could still name
// a URL for the provider to download -- OpenAI `image_url` / `input_image` / `input_file.file_url`,
// Anthropic `source: {type: "url"}` -- or a stored file by id. That is a two-way channel through a
// door that exists to have none: data leaves in the URL's query string, and whoever controls the URL
// (or the stored file) decides what the model reads next, mid-week, unrecorded and unpinnable at the
// freeze. A body the operator can replay has to carry its content inline.
//
// The rule is by reference, not by content type, so a part type added later is caught by the field
// that carries its reference. Walking every object member at any depth:
//
//   1. a stored file    a member named `file_id` / `file_ids` (any case; `_`, `-` ignored, so `fileId`
//                       too), whatever its value.
//   2. a URL            a member whose name is `url` / `uri` or ends in one (`image_url`, `file_url`,
//                       `audio_url`, `fileUri`, `image_urls`, ...), whose value is a string -- or an array
//                       holding strings, at any depth -- that is not a `data:` URI. An object value is
//                       walked instead (OpenAI's `image_url: {url, detail}` is decided at its `url`), and
//                       a number or null references nothing. A member's *name* is structure, never text,
//                       so a URL a message merely mentions -- inside `content` / `text` / `system`, any
//                       string under any other name -- is not affected.
//   3. a source         a `source` object (Anthropic's image / document blocks) whose `type` is `url` or
//                       `file`, anywhere; and, when the object holding it is a typed block, any `type`
//                       other than the inline ones (`base64`, `text`, `content`).
//   4. a stored item    an object of `type: "item_reference"` (OpenAI Responses: an input item fetched
//                       from what the provider stored, by id -- `previous_response_id` one item at a time).
//
// Rules 3 and 4 name today's shapes; 1 and 2 are what catch the next one. What they cost: a JSON schema
// (structured output, Ollama `format`) with a property named `file_id` is refused, and so is one whose
// `url` property holds a string instead of a schema; the refusal names the path, so rename it. A
// reference under a name ending in neither (a hypothetical `image: "https://..."`) is not caught: the
// name is the only signal that tells a resource field from text, and every provider the list can name
// spells its references `*_url`, `url`, `source` or `file_id`. Ollama's `images` is base64 by the API's
// definition and is left alone.
//
// The walk is iterative and bounded, like the RPC gateway's (infra/rpc-gateway/gateway.mjs
// `someString`): a body nested deeper than MAX_BODY_DEPTH or holding more than MAX_BODY_NODES values is
// refused without being inspected. A check that gives up must not forward what it skipped.

export const MAX_BODY_DEPTH = 64;
export const MAX_BODY_NODES = 100_000;

export type FetchByReference =
  // The first offending field in document order, as a JSON path (`messages[0].content[1].image_url.url`).
  | { kind: "reference"; path: string; reason: string }
  | { kind: "uninspectable"; maxDepth: number; maxNodes: number };

// What an Anthropic source may be when it sits in a typed block: the content is in the body.
const INLINE_SOURCE_TYPES = new Set(["base64", "text", "content"]);
const REFERENCE_SOURCE_TYPES = new Set(["url", "file"]);

function isFileIdKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_\-.\s]/g, "");
  return k === "fileid" || k === "fileids";
}

// `url`, `uri`, `image_url`, `file-url`, `image_urls`, `imageUrl`, `fileURI`; not `curl`.
function isUrlKey(key: string): boolean {
  return /(?:^|[_\-.\s])(?:url|uri)s?$/i.test(key) || /[a-z0-9]U[Rr][LlIi][sS]?$/.test(key);
}

// Exactly a data: URI -- no leading whitespace a provider might trim before fetching what follows.
function isDataUri(s: string): boolean {
  return /^data:/i.test(s);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

type Frame = {
  value: unknown;
  depth: number;
  // The member name or array index this value sits under; absent for the body itself.
  key?: string | number;
  parent?: Frame;
  // Set on values under a URL-named member, through arrays (not objects): a string here must be inline.
  underUrlKey: boolean;
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function pathOf(frame: Frame, suffix?: string): string {
  const parts: string[] = [];
  for (let f: Frame | undefined = frame; f?.key !== undefined; f = f.parent) {
    const k = f.key;
    parts.push(
      typeof k === "number" ? `[${k}]` : IDENTIFIER.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`,
    );
  }
  let path = parts.reverse().join("");
  if (suffix !== undefined) path += `.${suffix}`;
  return path.startsWith(".") ? path.slice(1) : path;
}

export function findFetchByReference(body: unknown): FetchByReference | null {
  const uninspectable: FetchByReference = {
    kind: "uninspectable",
    maxDepth: MAX_BODY_DEPTH,
    maxNodes: MAX_BODY_NODES,
  };
  const stack: Frame[] = [{ value: body, depth: 0, underUrlKey: false }];
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (++nodes > MAX_BODY_NODES || frame.depth > MAX_BODY_DEPTH) return uninspectable;
    const { value, key, parent } = frame;
    const holder = parent?.value;

    // Rules on the member itself, checked as it is reached so the first in document order is named.
    if (typeof key === "string") {
      if (isFileIdKey(key))
        return { kind: "reference", path: pathOf(frame), reason: "a file stored with the provider" };
      if (key === "source" && isPlainObject(value) && typeof value.type === "string") {
        const typed = isPlainObject(holder) && typeof holder.type === "string";
        if (
          REFERENCE_SOURCE_TYPES.has(value.type) ||
          (typed && !INLINE_SOURCE_TYPES.has(value.type))
        )
          return {
            kind: "reference",
            path: pathOf(frame, "type"),
            reason:
              `a source of type ${JSON.stringify(value.type.slice(0, 40))} ` +
              "(only base64, text and content are inline)",
          };
      }
    }
    if (typeof value === "string") {
      if (frame.underUrlKey && !isDataUri(value))
        return {
          kind: "reference",
          path: pathOf(frame),
          reason: "a URL for the provider to fetch (only a data: URI is inline)",
        };
      continue;
    }
    // Every value pushed is counted when it is reached, so a container whose children cannot all fit
    // under the bound is refused here, before they are queued (a 4 MiB body can hold ~10^6 values).
    const room = MAX_BODY_NODES - nodes - stack.length;
    if (Array.isArray(value)) {
      if (value.length > room) return uninspectable;
      for (let i = value.length - 1; i >= 0; i--)
        stack.push({
          value: value[i],
          depth: frame.depth + 1,
          key: i,
          parent: frame,
          underUrlKey: frame.underUrlKey,
        });
      continue;
    }
    if (isPlainObject(value)) {
      if (value.type === "item_reference")
        return {
          kind: "reference",
          path: pathOf(frame, "type"),
          reason: "an item stored with the provider",
        };
      let members = 0;
      for (const _ in value) if (++members > room) return uninspectable;
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i];
        stack.push({ value: v, depth: frame.depth + 1, key: k, parent: frame, underUrlKey: isUrlKey(k) });
      }
    }
  }
  return null;
}
