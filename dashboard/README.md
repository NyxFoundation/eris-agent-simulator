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
indirection point. The default provider (`runsProvider.ts`, issue #63 Phase 1)
builds every snapshot from run artifacts under `runs/<id>/`, served by a small
Vite dev-server plugin (`/runs/index.json` + `/runs/<id>/<file>`, see
`vite.config.ts`). The sidebar's run picker selects which run to render
(newest by default, persisted per browser).

- `summary.json` — standings (score = M9 in bps/epoch, PnL%, Sharpe, max DD)
- `events.jsonl` — price/portfolio series (reconstructed observations), event tape
- `blocks.csv` — explorer blocks/transactions (methods joined from agent logs)
- `agents/<id>.jsonl` — decision logs and submitted-tx self-reports
- `market.json` — post-run reconstruction extension (#63 Phase 2, written by
  `core/src/realtime/marketSeries.ts`): per-block per-venue executable quotes +
  pool depth, GMX OI/funding, Aave reserve totals, multi-asset fair prices,
  end-of-run GMX positions / Aave accounts per agent, and decoded per-tx USD
  notionals. Powers the cross-venue arb chart, MarketStats, positions/trades
  tables, tx amounts, and volume aggregates. Runs recorded before the artifact
  existed degrade to the Phase 1 rendering (`—`/`n/a`/empty).

Live mode is Phase 3 (#63); until it lands the dashboard renders completed runs.

When the local Blockscout explorer is running (`npm run explorer`, :3100),
tx/block/address deep links appear automatically (availability is probed once
through the Vite proxy at `/blockscout`); when it is down the links vanish and
nothing else changes.

Start with `VITE_DATA_PROVIDER=seed` to fall back to the IndexedDB seed provider
(`localProvider.ts` over `seed.ts`) for UI development.
