// The dashboard renders the repository's own documents, so the parser's subset has to be the whole
// of what they use (dashboard/src/data/markdownDoc.ts).
//
// The risk this pins is silent: a construct outside the subset does not throw, it comes out as the
// literal `**` or `|` of its own syntax, on a page a participant reads after a change to the
// environment. So the test renders the real file and asserts that nothing is left as markup.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  headings,
  parseInline,
  parseMarkdown,
  slug,
  splitFrontmatter,
  type Block,
  type Inline,
} from "../dashboard/src/data/markdownDoc.js";

const UPDATES = fileURLToPath(new URL("../docs/updates", import.meta.url));
const QA = fileURLToPath(new URL("../docs/qa", import.meta.url));

/** Every dated entry in docs/updates/ and every topic in docs/qa/, which is what the dashboard enumerates. */
function entryFiles(): Array<{ dir: string; name: string }> {
  const updates = readdirSync(UPDATES)
    .filter((f) => /^\d{4}-\d{2}-\d{2}(\.en)?\.md$/.test(f))
    .sort()
    .map((name) => ({ dir: UPDATES, name }));
  const qa = readdirSync(QA)
    .filter((f) => /^\d{2}-[a-z0-9-]+(\.en)?\.md$/.test(f))
    .sort()
    .map((name) => ({ dir: QA, name }));
  return [...updates, ...qa];
}

const docs = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");

/** docs/qa/genres.json: every topic's frontmatter has to name one of these. */
const genreKeys = new Set(
  (JSON.parse(readFileSync(join(QA, "genres.json"), "utf8")) as Array<{ key: string }>).map(
    (g) => g.key,
  ),
);

function plain(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.kind === "text" || n.kind === "code" ? n.text : plain(n.children)))
    .join("");
}

/** Every character of prose the renderer would put on the page, code blocks excluded. */
function rendered(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading" || b.kind === "paragraph") out.push(plain(b.inline));
    else if (b.kind === "list") out.push(...b.items.map(plain));
    else if (b.kind === "table")
      out.push(...b.head.map(plain), ...b.rows.flatMap((r) => r.map(plain)));
  }
  return out.join("\n");
}

test("the inline subset is bold, code and links, and code wins inside its own span", () => {
  assert.deepEqual(parseInline("a **b** c"), [
    { kind: "text", text: "a " },
    { kind: "strong", children: [{ kind: "text", text: "b" }] },
    { kind: "text", text: " c" },
  ]);
  // A backtick span in these documents routinely holds `**` and brackets; they stay literal.
  const code = parseInline("set `a **b** [c](d)` now");
  assert.deepEqual(code[1], { kind: "code", text: "a **b** [c](d)" });
  const link = parseInline("see [the guide](competition-start.md).");
  assert.deepEqual(link[1], {
    kind: "link",
    href: "competition-start.md",
    children: [{ kind: "text", text: "the guide" }],
  });
  // Text with none of the three survives whole, which is most of any document.
  assert.deepEqual(parseInline("plain text"), [{ kind: "text", text: "plain text" }]);
});

test("a table, a fenced block and a list each parse as themselves", () => {
  const blocks = parseMarkdown(
    [
      "| a | b |",
      "|---|---|",
      "| 1 | `x` |",
      "",
      "- one",
      "- two",
      "",
      "```bash",
      "npm run build",
      "```",
      "",
      "1. first",
      "2. second",
    ].join("\n"),
  );
  const kinds = blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ["table", "list", "code", "list"]);
  const table = blocks[0] as Extract<Block, { kind: "table" }>;
  assert.deepEqual(table.head.map(plain), ["a", "b"]);
  assert.deepEqual(table.rows[0].map(plain), ["1", "x"]);
  assert.equal((blocks[1] as Extract<Block, { kind: "list" }>).ordered, false);
  assert.equal((blocks[2] as Extract<Block, { kind: "code" }>).text, "npm run build");
  assert.equal((blocks[3] as Extract<Block, { kind: "list" }>).ordered, true);
});

for (const { dir, name } of entryFiles()) {
  test(`${name} renders with no markup left as text`, () => {
    // The page renders the body; the frontmatter (a Q&A topic's genre) never reaches the parser.
    const { meta, body: src } = splitFrontmatter(docs(dir, name));
    if (dir === QA) {
      assert.ok(
        meta.genre !== undefined && genreKeys.has(meta.genre),
        `a Q&A topic names a genre from genres.json (got ${JSON.stringify(meta.genre)})`,
      );
    }
    const blocks = parseMarkdown(src);
    const out = rendered(blocks);

    // The failure this guards: a construct outside the subset reaching the page as its own syntax.
    assert.ok(!out.includes("**"), "bold markers reached the page as text");
    assert.ok(!/^\s*\|/m.test(out), "a table row reached the page as text");
    assert.ok(!/^\s*#{1,6}\s/m.test(out), "a heading reached the page as text");
    assert.ok(!/^\s*[-*]\s/m.test(out), "a list item reached the page as text");
    assert.ok(!/\]\([^)]+\)/.test(out), "a link reached the page as text");
    assert.ok(!out.includes("```"), "a fence reached the page as text");

    // And that the page is actually the document: every non-markup line of prose is present.
    // Prose only: a fenced block's body renders inside <pre>, which `rendered` leaves out, so the
    // lines between fences are not something to look for on the prose side.
    let inFence = false;
    const prose = src.split("\n").filter((l) => {
      if (l.trimStart().startsWith("```")) {
        inFence = !inFence;
        return false;
      }
      if (inFence) return false;
      // Top-level prose only. An indented line continues a list item, which the parser folds into
      // that item rather than into a paragraph.
      return (
        !l.startsWith("#") &&
        !l.trimStart().startsWith("|") &&
        !/^\s*[-*\d]/.test(l) &&
        !/^\s+\S/.test(l)
      );
    });
    // By paragraph, not by line: the English document is hard-wrapped, so a `**` span can open on
    // one line and close on the next, and a line on its own is not something the renderer ever sees.
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of prose) {
      if (line.trim().length === 0) {
        if (current.length > 0) paragraphs.push(current.join(" "));
        current = [];
      } else current.push(line.trim());
    }
    if (current.length > 0) paragraphs.push(current.join(" "));

    assert.ok(paragraphs.length > 5, "the fixture should have prose to check");
    for (const para of paragraphs.slice(0, 30)) {
      const stripped = plain(parseInline(para));
      assert.ok(out.includes(stripped), `missing from the page: ${stripped.slice(0, 60)}`);
    }

    // The dated entries carry the page's table of contents, and their anchors have to be distinct.
    // Each entry file carries one `#` title and its sections below it; the anchors have to be
    // distinct so a link can point into a section.
    const hs = headings(blocks);
    assert.equal(hs.filter((h) => h.level === 1).length, 1, "an entry has one title");
    const slugs = hs.map((h) => slug(h.text));
    assert.equal(new Set(slugs).size, slugs.length, "two headings share an anchor");
    assert.ok(slugs.every((x) => x.length > 0), "a heading has an empty anchor");
  });
}

// The Q&A is one page, so a question's anchor has to be distinct across every topic of a language,
// not only inside its own file: the contents list links to it.
for (const locale of ["ja", "en"]) {
  test(`the ${locale} Q&A has no two questions with the same anchor`, () => {
    const seen = new Map<string, string>();
    for (const { dir, name } of entryFiles()) {
      if (dir !== QA) continue;
      if ((name.endsWith(".en.md") ? "en" : "ja") !== locale) continue;
      const { body } = splitFrontmatter(docs(dir, name));
      for (const h of headings(parseMarkdown(body)).filter((x) => x.level === 2)) {
        const id = slug(h.text);
        assert.ok(!seen.has(id), `${name} and ${seen.get(id)} share the anchor "${id}"`);
        seen.set(id, name);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The page itself, rendered to HTML
// ---------------------------------------------------------------------------
//
// The parser being right is not the same as the page coming out. This renders the real document
// through the real component, because the way that fails is quiet: a table that arrives as one long
// line, or a list that loses its items, is still a page that loads.

test("the real document renders to HTML with its tables, lists and code intact", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MarkdownView } = await import("../dashboard/src/components/markdownView.js");
  const { createElement } = await import("react");

  const blocks = parseMarkdown(docs(UPDATES, "2026-10-05.md"));
  const html = renderToStaticMarkup(createElement(MarkdownView, { blocks }));

  // The structures, not the styling: each one is a thing the subset has to produce.
  for (const tag of ["<table", "<tbody", "<td", "<ol", "<ul", "<li", "<pre", "<code", "<strong", "<h2"]) {
    assert.ok(html.includes(tag), `no ${tag} in the rendered page`);
  }
  // A heading carries its anchor, so a link into a section works.
  const h1 = headings(blocks).filter((h) => h.level === 1);
  assert.ok(html.includes(`id="${slug(h1[0].text)}"`), "the entry title has no anchor");
  // Content that must survive escaping and nesting: a measured number inside a table cell, and a
  // command inside a fenced block under a numbered list.
  assert.ok(html.includes("687,584.67"), "a measured figure is missing");
  assert.ok(html.includes("clean:vendors"), "the rebuild command is missing");
  // No markup leaked into the text nodes.
  assert.ok(!html.includes("**"), "bold markers reached the HTML");
  assert.ok(!html.includes("```"), "a fence reached the HTML");
});
