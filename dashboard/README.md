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

## Live mode (issue #63 Phase 3)

A run in progress (no `summary.json` yet, `events.jsonl` still moving) appears
in the run picker as `● <id> (live)` and every view refreshes in place every
few seconds. Live data comes from three places, none of them the coordinator:

- **file tails** — the dev server's `/runs/<id>/tail/<file>?offset=N` endpoint
  streams appended bytes of `events.jsonl` (run meta, event tape, tx
  attribution) and `agents/<id>.jsonl` (live decision log)
- **JSON-RPC** — the anvil endpoint is discovered from the agents' own
  `runtime_start` log lines; the browser reads the chain height, recent blocks,
  and the on-chain PriceFeed directly (a live fair ticker accumulates while the
  page watches)
- **Blockscout** (optional) — when `npm run explorer` is up, its indexed height
  is shown next to the RPC height so the indexer lag stays visible, and deep
  links work during the run

Scores, portfolio curves, per-venue series, and tx notionals are post-run
artifacts by design (ADR 0006 §4) and appear the moment the run completes — the
picker drops the live marker and the views switch to the archived rendering on
the next poll, no reload needed.

Lifecycle note: the Blockscout explorer indexes the same anvil, so its own
lifecycle applies alongside live mode — `npm run explorer:reset` after a chain
reset (the indexer cannot follow a rollback), `npm run explorer:tag` per run
for agent name tags. The dashboard never depends on the explorer; it only adds
links and the indexed-height stat.

When the local Blockscout explorer is running (`npm run explorer`, :3100),
tx/block/address deep links appear automatically (availability is probed once
through the Vite proxy at `/blockscout`); when it is down the links vanish and
nothing else changes.

Start with `VITE_DATA_PROVIDER=seed` to fall back to the IndexedDB seed provider
(`localProvider.ts` over `seed.ts`) for UI development.
