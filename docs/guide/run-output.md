[← README](../../README.md)

# Run Output and Analysis

Each run generates a `runs/<run_id>/` directory. The dedicated evaluation, scoring, and visualization commands have been removed; analysis reads the output files directly.

| File | Contents |
|---|---|
| `summary.json` | per-agent initial / final value, netPnl, alpha, included/revert tx counts, `valueSeries.failedReads`, `violations` |
| `events.jsonl` | event stream (observation, stress, liquidation, etc.); the primary source for scoring |
| `blocks.csv` | per-block tx records (fee comes from the on-chain tx field) |
| `market.json` | post-run market series (issue #63 Phase 2): per-block per-venue executable quotes + pool depth, GMX OI/funding, Aave reserve totals, multi-asset fair prices, end-of-run GMX positions / Aave accounts, and decoded per-tx USD notionals. Derived from historical reads after the run (zero live-loop cost); feeds the `dashboard/` workspace. Reporting only — never an input to scoring |
| `agents/<id>.jsonl` | each agent's self-reported log (decision `reason` / `signals` / `state`, plus mempool activity appended by runtime/send.ts as `kind:"mempool"`: submitted / submit_failed / rejected) |
| `agents/<id>.llm.jsonl` | raw strategy-revision exchange for a self-improving agent (opt-in via `ERIS_IMPROVE_LOG_CALLS=1`; system prompt, sent context, response, errors; see [Self-improving agents](llm-agents.md)). Revision *outcomes* are in `agents/<id>.jsonl` |

```bash
npm run dashboard                         # render a run in a browser (live or finished) — dashboard.md
npm run metrics -- runs/<run_id>          # rescore under every candidate metric — scoring.md
npm run check:ordering -- runs/<run_id>   # inspect Anvil's fee ordering
npm run check:strategy -- <file>          # static cheatcode check of strategy code (entry side)
```

> The entry points for a run are `sim:realtime` and `backtest` (identical output format, with `summary.json`'s `mode` being `"realtime"` / `"backtest"`). **SEED (= regime) is a label for the market conditions** — the price path is reproducible, but tx timing/ordering is non-deterministic, so results vary even within the same regime. When you need to compare runs, accumulate samples and aggregate — [Backtest](backtest.md)'s `--repeat N` runs the same scenario N times and prints each run so you can see the spread, and `--scenarios` ranks a whole set at once.

## Key fields in summary.json

| Field | Meaning |
|---|---|
| `mode` | `"realtime"` / `"backtest"` (which entry point the run came from) |
| `resetUnit` | `"continuous"` / `"scenario"` — one world, or one scenario out of a set that rebuilt the world per (regime, seed). ADR 0020 |
| `agents[].initialValueUsdc` / `finalValueUsdc` | total value at run start / end (USDC-equivalent, including the valuation of venue positions) |
| `agents[].alphaUsdc` | β-removed PnL relative to the fair price at fill time (look here for skill comparison) |
| `agents[].netPnlUsdc` | `finalValueUsdc − initialValueUsdc` |
| `agents[].includedTxCount` / `revertCount` | number of included / reverted txs |
| `agents[].stderrTail` | tail of the agent process's stderr (for crash diagnosis) |
| `epochScores[<id>]` | the risk-adjusted score per agent — `score` (`mean − λ·std`), the `logReturns` it came from, `bankruptAtEpoch`, `carriedForwardEpochs`, `benchmarkApplied` ([Scoring](scoring.md)) |
| `valueSeries.epochSeries` | the boundary values every score above is computed from (`boundaryBlocks` / `valuesByAgent`, `null` = a boundary that did not report) |
| `valueSeries.markMedian` | which manipulable marks were medianed at the boundaries, and the largest deviation seen |
| `valueSeries.alphaByAgent` / `liquidatableValueByAgent` | the β-removed series, and what an exit would actually have returned where a venue marks a position at something else (LST) |
| `valueSeries.unpricedHoldings` | holdings the scorer could not price, reported rather than silently zeroed |
| `valueSeries.failedReads` | number of cross-sections that could not be read during value reconstruction (`0` if healthy) |
| `violations` | violations from the post-run rule checks (fee limit overruns, etc.) |

Everything the score is derived from is stored, not just the score, so a finished run can be
rescored under a different metric without re-running it: `npm run metrics -- runs/<id>`
([Scoring](scoring.md)).

## Liquidation Attribution (stress runs)

Liquidation attribution is not done by a dedicated tool; instead, cross-reference `stress_liquidation` in `events.jsonl` with each agent's `liquidationCall` (rawTx) in `agents/<id>.jsonl` (read the jsonl directly). See [Market Stress Events](stress-events.md) for details.
