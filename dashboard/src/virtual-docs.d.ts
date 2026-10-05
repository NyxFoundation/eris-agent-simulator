// The modules docsPlugin (vite.config.ts) builds from docs/updates/ and docs/qa/: every entry, both
// languages.
declare module "virtual:eris-updates" {
  const entries: Array<{
    slug: string;
    locale: string;
    meta: Record<string, string>;
    text: string;
  }>;
  export default entries;
}
declare module "virtual:eris-qa" {
  const entries: Array<{
    slug: string;
    locale: string;
    /** `genre`, from the topic's frontmatter. */
    meta: Record<string, string>;
    text: string;
  }>;
  export default entries;
  /** docs/qa/genres.json: the genres in display order, labelled in both languages. */
  export const genres: Array<{ key: string; ja: string; en: string }>;
}
