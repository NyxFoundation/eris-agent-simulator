// A document written in the repository, rendered in the dashboard.
//
// The participant guide and the environment's update history live in `docs/` and are the version a
// participant is told to read. Rendering them here rather than copying their text into the UI keeps
// one source: a second copy of a notice is a second thing to keep correct, and the one that drifts
// is always the one nobody is looking at.
//
// Parsing is deliberately small. The dashboard carries react, react-dom and a chart library and
// nothing else, and a Markdown dependency would be the fourth for one page. So this covers the
// subset those documents use -- headings, paragraphs, bold, inline code, links, tables, lists,
// fenced code, rules -- and `test/dashboardMarkdown.test.ts` renders the real file to pin that the
// subset is still the whole of it. Anything outside the subset shows as its own text rather than
// disappearing, so a new construct is visible instead of silently dropped.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] }
  | { kind: "code"; text: string; lang?: string }
  | { kind: "rule" };

// `**bold**`, `` `code` ``, `[text](href)`. Code wins over the others inside its span, which is why
// it is matched first: a backtick span in these documents routinely holds `**` and brackets.
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  const push = (text: string) => {
    if (text) out.push({ kind: "text", text });
  };
  while (rest.length > 0) {
    const m = rest.match(/(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/);
    if (!m || m.index === undefined) break;
    push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out.push({ kind: "code", text: tok.slice(1, -1) });
    else if (tok.startsWith("**"))
      out.push({ kind: "strong", children: parseInline(tok.slice(2, -2)) });
    else {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push({
        kind: "link",
        href: link[2],
        children: parseInline(link[1]),
      });
    }
    rest = rest.slice(m.index + tok.length);
  }
  push(rest);
  return out;
}

const cells = (row: string): Inline[][] =>
  row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length > 0) {
      out.push({ kind: "paragraph", inline: parseInline(para.join(" ")) });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A fence under a list item is indented, so the marker is matched after the indent and the same
    // indent is taken off the body -- otherwise every line of a command arrives with it.
    const fence = line.match(/^(\s*)```(.*)$/);
    if (fence) {
      flush();
      const indent = fence[1].length;
      const lang = fence[2].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        body.push(lines[i++].slice(indent));
      out.push({
        kind: "code",
        text: body.join("\n"),
        ...(lang ? { lang } : {}),
      });
      continue;
    }

    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flush();
      out.push({ kind: "rule" });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      out.push({
        kind: "heading",
        level: heading[1].length,
        inline: parseInline(heading[2]),
      });
      continue;
    }

    // A table is a header row, a separator of dashes, then rows until the block ends.
    if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line.trim());
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++].trim()));
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      flush();
      const ordered = numbered !== null;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const b = lines[i].match(/^\s*[-*]\s+(.*)$/);
        const n = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        const m = ordered ? n : b;
        if (!m) {
          // A continuation line is indented under its item; a fenced block under one ends the list,
          // because the renderer puts code outside the list rather than losing it.
          if (/^\s+\S/.test(lines[i]) && items.length > 0 && !/^\s*```/.test(lines[i])) {
            const last = items[items.length - 1];
            items[items.length - 1] = [
              ...last,
              { kind: "text", text: " " },
              ...parseInline(lines[i].trim()),
            ];
            i++;
            continue;
          }
          break;
        }
        items.push(parseInline(m[1]));
        i++;
      }
      i--;
      out.push({ kind: "list", ordered, items });
      continue;
    }

    para.push(line.trim());
  }
  flush();
  return out;
}

/** The heading text of every `##`, for a table of contents. */
export function headings(blocks: Block[]): Array<{ level: number; text: string }> {
  const text = (inline: Inline[]): string =>
    inline
      .map((n) =>
        n.kind === "text" || n.kind === "code" ? n.text : text(n.children),
      )
      .join("");
  return blocks
    .filter((b): b is Extract<Block, { kind: "heading" }> => b.kind === "heading")
    .map((b) => ({ level: b.level, text: text(b.inline) }));
}

/** A stable id for a heading, so a link can point at a section of the page. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}
