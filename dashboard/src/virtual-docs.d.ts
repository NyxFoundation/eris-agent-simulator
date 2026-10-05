// The modules docsPlugin (vite.config.ts) builds from docs/updates/ and docs/qa/: every entry, both
// languages.
declare module "virtual:eris-updates" {
  const entries: Array<{ slug: string; locale: string; text: string }>;
  export default entries;
}
declare module "virtual:eris-qa" {
  const entries: Array<{ slug: string; locale: string; text: string }>;
  export default entries;
}
