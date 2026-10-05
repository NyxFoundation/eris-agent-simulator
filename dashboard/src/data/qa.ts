import type { Locale } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { headings, parseMarkdown, slug, type Block } from "./markdownDoc.js";
import rawEntries, { genres as rawGenres } from "virtual:eris-qa";

/**
 * The Q&A, as genres of topics rather than one page.
 *
 * Each topic is a file in `docs/qa/` (docsPlugin in vite.config.ts enumerates them) whose
 * frontmatter names its genre; `docs/qa/genres.json` is the genres in display order, labelled in
 * both languages. Adding a topic is adding a file; adding a genre is adding a line to that file.
 * Within a genre the topics keep file order, so the number that leads a file name is the order a
 * reader meets them in.
 */
export type QaQuestion = {
  /** The `##` heading's text, which is the question. */
  text: string;
  /** Its anchor on the page, the same id MarkdownView gives the heading. */
  id: string;
};

export type QaTopic = {
  /** `<NN>-<name>`, the file name less its language and extension. */
  slug: string;
  /** From the frontmatter; "" when the file names none. */
  genre: string;
  blocks: Block[];
  questions: QaQuestion[];
};

export type QaGenre = {
  key: string;
  label: string;
  topics: QaTopic[];
};

type Raw = {
  slug: string;
  locale: string;
  meta: Record<string, string>;
  text: string;
};
type Genre = { key: string; ja: string; en: string };

/** Topics in the viewer's language, in file order, genre unresolved. */
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
    .map((e) => {
      const blocks = parseMarkdown(e.text);
      return {
        slug: e.slug,
        genre: e.meta.genre ?? "",
        blocks,
        questions: headings(blocks)
          .filter((h) => h.level === 2)
          .map((h) => ({ text: h.text, id: slug(h.text) })),
      };
    });
}

/**
 * Genres in the order of genres.json, each with its topics; a genre with no topic is left out, and
 * a topic whose genre is not in the file comes last under "other" rather than disappearing.
 */
export function qaGenres(locale: Locale): QaGenre[] {
  const topics = qaTopics(locale);
  const genres = rawGenres as Genre[];
  const out: QaGenre[] = [];
  for (const g of genres) {
    const own = topics.filter((x) => x.genre === g.key);
    if (own.length > 0) {
      out.push({ key: g.key, label: locale === "en" ? g.en : g.ja, topics: own });
    }
  }
  const known = new Set(genres.map((g) => g.key));
  const rest = topics.filter((x) => !known.has(x.genre));
  if (rest.length > 0) {
    out.push({ key: "other", label: t("qa.genre.other"), topics: rest });
  }
  return out;
}
