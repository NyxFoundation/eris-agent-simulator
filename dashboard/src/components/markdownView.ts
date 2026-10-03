import { createElement as h, type CSSProperties, type ReactNode } from "react";
import { slug, type Block, type Inline } from "../data/markdownDoc.js";

/**
 * Renders the blocks of a repository document (data/markdownDoc.ts) as the page a participant
 * reads.
 *
 * The reader is somebody whose agent may have stopped working, looking for the part that affects
 * them. So the structure carries the information: prose is held to a readable measure while tables
 * take the full width (this document's tables are two columns of prose, and squeezing them into a
 * paragraph's measure turns each cell into a column of single words), and the heading levels step
 * far enough apart that "which bucket is this" is answerable without reading.
 *
 * Written with `createElement` rather than JSX so that `test/dashboardMarkdown.test.ts` can render
 * the real document to HTML under the root tsconfig, which covers `test/` and sets no `jsx`. The
 * failure worth pinning is structural and quiet: a table that comes out as one long line, or a list
 * that loses its items, is still a page that loads.
 */

/** Prose stays inside a measure; tables and code may use the page. */
const MEASURE = "68ch";

const CODE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.9em",
  background: "var(--bg-sunken)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "1px 5px",
};

const REPO_DOCS =
  "https://github.com/NyxFoundation/eris-agent-simulator/blob/main/docs/";

export function inlineNodes(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.kind === "text") return h("span", { key: i }, n.text);
    if (n.kind === "code") return h("code", { key: i, style: CODE }, n.text);
    if (n.kind === "strong")
      return h(
        "strong",
        { key: i, style: { color: "var(--text-primary)", fontWeight: 600 } },
        inlineNodes(n.children),
      );
    // A relative link points at another file in the repository, so it resolves there; only that way
    // does it still work from inside the dashboard.
    const href = /^https?:/.test(n.href) ? n.href : REPO_DOCS + n.href;
    return h(
      "a",
      {
        key: i,
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        style: { color: "var(--text-link)" },
      },
      inlineNodes(n.children),
    );
  });
}

function flatten(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.kind === "text" || n.kind === "code" ? n.text : flatten(n.children),
    )
    .join("");
}

/**
 * The step between levels is what tells a reader which bucket they are in: `##` is a dated entry and
 * takes a rule above it, `###` is a bucket inside one, `####` is a single item.
 */
const HEADING: Record<number, CSSProperties> = {
  1: { fontSize: "var(--text-2xl)", letterSpacing: "var(--tracking-tight)" },
  2: {
    fontSize: "var(--text-xl)",
    letterSpacing: "var(--tracking-tight)",
    paddingTop: "var(--space-8)",
    borderTop: "1px solid var(--border-subtle)",
  },
  3: { fontSize: "var(--text-md)" },
  4: { fontSize: "var(--text-base)", color: "var(--text-secondary)" },
  5: { fontSize: "var(--text-base)", color: "var(--text-secondary)" },
  6: { fontSize: "var(--text-base)", color: "var(--text-secondary)" },
};

const HEADING_SPACE: Record<number, string> = {
  1: "0 0 var(--space-5)",
  2: "var(--space-12) 0 var(--space-5)",
  3: "var(--space-10) 0 var(--space-4)",
  4: "var(--space-6) 0 var(--space-3)",
  5: "var(--space-6) 0 var(--space-3)",
  6: "var(--space-6) 0 var(--space-3)",
};

const TH: CSSProperties = {
  textAlign: "left",
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--border-default)",
  color: "var(--text-tertiary)",
  fontWeight: 500,
  fontSize: "var(--text-sm)",
};

const TD: CSSProperties = {
  padding: "var(--space-4)",
  borderBottom: "1px solid var(--border-subtle)",
  verticalAlign: "top",
  lineHeight: 1.75,
};

function row(cells: Inline[][], j: number): ReactNode {
  return h(
    "tr",
    { key: j },
    cells.map((c: Inline[], k: number) =>
      h("td", { key: k, style: TD }, inlineNodes(c)),
    ),
  );
}

/** True when every header cell is empty: a two-column table used as a list of facts, not a grid. */
function headless(head: Inline[][]): boolean {
  return head.every((c) => flatten(c).trim().length === 0);
}

function block(b: Block, i: number): ReactNode {
  switch (b.kind) {
    case "heading": {
      const level = Math.min(b.level, 6);
      return h(
        `h${level}`,
        {
          key: i,
          id: slug(flatten(b.inline)),
          style: {
            ...HEADING[level],
            fontWeight: level <= 2 ? 600 : 650,
            color: "var(--text-primary)",
            margin: HEADING_SPACE[level],
            maxWidth: MEASURE,
            scrollMarginTop: "var(--space-20)",
            lineHeight: 1.35,
          },
        },
        inlineNodes(b.inline),
      );
    }
    case "paragraph":
      return h(
        "p",
        {
          key: i,
          style: {
            margin: "0 0 var(--space-4)",
            maxWidth: MEASURE,
            lineHeight: 1.85,
            color: "var(--text-secondary)",
          },
        },
        inlineNodes(b.inline),
      );
    case "list":
      return h(
        b.ordered ? "ol" : "ul",
        {
          key: i,
          style: {
            margin: "0 0 var(--space-4)",
            paddingLeft: "var(--space-6)",
            maxWidth: MEASURE,
            lineHeight: 1.85,
            color: "var(--text-secondary)",
          },
        },
        b.items.map((it: Inline[], j: number) =>
          h(
            "li",
            { key: j, style: { margin: "0 0 var(--space-3)" } },
            inlineNodes(it),
          ),
        ),
      );
    case "table":
      return h(
        "div",
        {
          key: i,
          style: {
            overflowX: "auto",
            margin: "0 0 var(--space-6)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg-surface)",
          },
        },
        h(
          "table",
          {
            style: {
              borderCollapse: "collapse",
              width: "100%",
              minWidth: 520,
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
            },
          },
          headless(b.head)
            ? null
            : h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  b.head.map((c: Inline[], j: number) =>
                    h("th", { key: j, style: TH }, inlineNodes(c)),
                  ),
                ),
              ),
          h("tbody", null, b.rows.map(row)),
        ),
      );
    case "code":
      return h(
        "pre",
        {
          key: i,
          style: {
            margin: "0 0 var(--space-6)",
            padding: "var(--space-4)",
            overflowX: "auto",
            background: "var(--bg-sunken)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            lineHeight: 1.7,
            color: "var(--text-secondary)",
          },
        },
        b.text,
      );
    case "rule":
      // The entry heading carries its own rule, so a horizontal rule in the source is just spacing.
      return h("div", { key: i, style: { height: "var(--space-4)" } });
  }
}

export function MarkdownView({ blocks }: { blocks: Block[] }): ReactNode {
  return h("div", null, blocks.map(block));
}
