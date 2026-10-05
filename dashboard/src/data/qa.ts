import type { Locale } from "@/i18n/locale";
import { parseMarkdown, type Block } from "./markdownDoc.js";
import rawEntries from "virtual:eris-qa";

/**
 * The Q&A, as topics rather than one page.
 *
 * Each topic is a file in `docs/qa/` (docsPlugin in vite.config.ts enumerates them), so adding a
 * topic is adding a file. The page shows them in file order, each one's questions as its `##`
 * headings, so the number that leads the file name is the order a reader meets them in.
 */
export type QaTopic = {
  /** `<NN>-<name>`, the file name less its language and extension. */
  slug: string;
  blocks: Block[];
};

type Raw = { slug: string; locale: string; text: string };

/** Topics in the viewer's language, in file order. */
export function qaTopics(locale: Locale): QaTopic[] {
  const raw = rawEntries as Raw[];
  const wanted = raw.filter((e) => e.locale === locale);
  // A topic may land in one language first. Falling back to the other is better than hiding it:
  // somebody with the question should find the answer, even untranslated.
  const bySlug = new Map<string, Raw>();
  for (const e of [...raw.filter((x) => x.locale !== locale), ...wanted]) {
    bySlug.set(e.slug, e);
  }
  return [...bySlug.values()]
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((e) => ({ slug: e.slug, blocks: parseMarkdown(e.text) }));
}
