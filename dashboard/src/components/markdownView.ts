import { createElement as h, type CSSProperties, type ReactNode } from "react";
import { slug, type Block, type Inline } from "../data/markdownDoc.js";

/**
 * Renders the blocks of a repository document (data/markdownDoc.ts) as the page a participant
 * reads.
 *
 * Written with `createElement` rather than JSX so that `test/dashboardMarkdown.test.ts` can render
 * the real document to HTML under the root tsconfig, which covers `test/` and sets no `jsx`. The
 * failure worth pinning is structural and quiet: a table that comes out as one long line, or a list
 * that loses its items, is still a page that loads.
 */
const CODE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  background: "var(--bg-inset)",
  borderRadius: 4,
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
        { key: i, style: { color: "var(--text-strong)" } },
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
        style: { color: "var(--link)", textDecoration: "underline" },
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

const HEADING_SIZE = [28, 22, 18, 16, 15, 14];

const TH: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-strong)",
  color: "var(--text-muted)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const TD: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
  lineHeight: 1.7,
};

function row(cells: Inline[][], j: number): ReactNode {
  return h(
    "tr",
    { key: j },
    cells.map((c: Inline[], k: number) => h("td", { key: k, style: TD }, inlineNodes(c))),
  );
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
            fontSize: HEADING_SIZE[level - 1],
            fontWeight: 650,
            color: "var(--text-strong)",
            margin: level <= 2 ? "32px 0 12px" : "24px 0 8px",
            scrollMarginTop: 80,
          },
        },
        inlineNodes(b.inline),
      );
    }
    case "paragraph":
      return h(
        "p",
        { key: i, style: { margin: "0 0 12px", lineHeight: 1.75 } },
        inlineNodes(b.inline),
      );
    case "list":
      return h(
        b.ordered ? "ol" : "ul",
        {
          key: i,
          style: { margin: "0 0 12px", paddingLeft: 24, lineHeight: 1.75 },
        },
        b.items.map((it: Inline[], j: number) =>
          h("li", { key: j, style: { margin: "0 0 6px" } }, inlineNodes(it)),
        ),
      );
    case "table":
      // Scrolls on its own rather than widening the page: these tables are two columns of prose,
      // and a phone cannot hold them.
      return h(
        "div",
        { key: i, style: { overflowX: "auto", margin: "0 0 16px" } },
        h(
          "table",
          {
            style: { borderCollapse: "collapse", width: "100%", fontSize: 14 },
          },
          h(
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
            margin: "0 0 16px",
            padding: 12,
            overflowX: "auto",
            background: "var(--bg-inset)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.6,
          },
        },
        b.text,
      );
    case "rule":
      return h("hr", {
        key: i,
        style: {
          border: 0,
          borderTop: "1px solid var(--border)",
          margin: "28px 0",
        },
      });
  }
}

export function MarkdownView({ blocks }: { blocks: Block[] }): ReactNode {
  return h("div", null, blocks.map(block));
}
