import type { Locale } from "@/i18n/locale";
import { headings, parseMarkdown, type Block } from "./markdownDoc.js";
import rawEntries from "virtual:eris-updates";

/**
 * The update history, as entries rather than one page.
 *
 * Each entry is a file in `docs/updates/` (updatesPlugin in vite.config.ts enumerates them), so
 * adding an update is adding a file. The index and the entry pages are both built from this list,
 * which is why neither has a list of its own to fall out of step with the directory.
 */
export type UpdateEntry = {
  /** `YYYY-MM-DD`, which is also the entry's URL. */
  slug: string;
  /** The entry's own `#` heading, less the date it starts with. */
  title: string;
  /** Its first paragraph, for the index. */
  summary: string;
  blocks: Block[];
};

type Raw = { slug: string; locale: string; text: string };

function firstParagraph(blocks: Block[]): string {
  const p = blocks.find((b) => b.kind === "paragraph");
  if (!p || p.kind !== "paragraph") return "";
  const text = (nodes: typeof p.inline): string =>
    nodes
      .map((n) =>
        n.kind === "text" || n.kind === "code" ? n.text : text(n.children),
      )
      .join("");
  return text(p.inline);
}

/** Entries in the viewer's language, newest first. */
export function updateEntries(locale: Locale): UpdateEntry[] {
  const raw = rawEntries as Raw[];
  const wanted = raw.filter((e) => e.locale === locale);
  // A new entry may land in one language first. Falling back to the other is better than hiding it:
  // somebody looking for what changed should find it, even untranslated.
  const bySlug = new Map<string, Raw>();
  for (const e of [...raw.filter((x) => x.locale !== locale), ...wanted]) {
    bySlug.set(e.slug, e);
  }
  return [...bySlug.values()]
    .sort((a, b) => (a.slug < b.slug ? 1 : -1))
    .map((e) => {
      const blocks = parseMarkdown(e.text);
      const h1 = headings(blocks).find((h) => h.level === 1)?.text ?? e.slug;
      return {
        slug: e.slug,
        // The heading opens with the date, which the page shows separately.
        title: h1.replace(/^\d{4}-\d{2}-\d{2}\s*/, ""),
        summary: firstParagraph(blocks),
        blocks,
      };
    });
}

/** The entry at `/updates/<slug>`, or undefined when the path names none. */
export function updateEntry(
  locale: Locale,
  slug: string,
): UpdateEntry | undefined {
  return updateEntries(locale).find((e) => e.slug === slug);
}
