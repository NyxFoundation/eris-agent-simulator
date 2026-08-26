# eris-dashboard

A dashboard built with Vite + React 19 + TypeScript + Tailwind CSS v4.

Lives as the `dashboard/` npm workspace of this repository (imported from the
standalone `eris-dashboard` repo — see issue #63). Install from the repository
root with `npm install`; there is no per-package install step.

## Commands

From the repository root:

| Command | Description |
| --- | --- |
| `npm run dashboard` | Start the dev server (http://localhost:5173) |
| `npm run build -w dashboard` | Type-check, then build for production (`dist/`) |
| `npm run preview -w dashboard` | Serve the production build locally |
| `npm run typecheck -w dashboard` | Run the type check only |

## Layout

```
index.html          HTML entry point
vite.config.ts      Vite config (React / Tailwind plugins, @ alias)
tsconfig.json       TypeScript config (strict)
src/
  main.tsx          React mount
  App.tsx           Root component
  styles/index.css  Tailwind entry point
public/             Static assets, served as-is
```

`@/` is an alias for `src/`, defined in both `vite.config.ts` and `tsconfig.json`.

## Data

All pages consume snapshots through `src/data/provider.ts` — an explicit
indirection point. It currently re-exports the seed-data provider
(`localProvider.ts` over `seed.ts`); swapping in a provider that reads real run
artifacts (`runs/<id>/`) requires no component changes (issue #63 Phase 1).
