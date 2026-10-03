// The module updatesPlugin (vite.config.ts) builds from docs/updates/: every entry, both languages.
declare module "virtual:eris-updates" {
  const entries: Array<{ slug: string; locale: string; text: string }>;
  export default entries;
}
