[← README](../../README.md)

# Run Output and Analysis

Each run generates a `runs/<run_id>/` directory. The dedicated evaluation, scoring, and visualization commands have been removed; analysis reads the output files directly.

| File | Contents |
|---|---|
| `summary.json` | per-agent initial / final value, netPnl, alpha, included/revert tx counts, `valueSeries.failedReads`, `violations` |
| `events.jsonl` | event stream (observation, stress, liquidation, etc.); the primary source for scoring |
| `blocks.csv` | per-block tx records (fee comes from the on-chain tx field) |
| `agents/<id>.jsonl` | each agent's self-reported log (decision `reason` / `signals` / `state`, plus mempool activity appended by runtime/send.ts as `kind:"mempool"`: submitted / submit_failed / rejected) |
| `agents/<id>.prompt.v<K>.md` | prompt-agent self-revision history (when `ERIS_PROMPT_REVISE_EVERY` is enabled; full text, versioned) |
| `agents/<id>.llm.jsonl` | prompt-agent LLM conversation log (opt-in via `ERIS_PROMPT_LOG_CALLS=1`; full system prompt, sent messages, raw responses, errors; see [LLM Agents](llm-agents.md)) |

```bash
npm run check:ordering -- runs/<run_id>   # inspect Anvil's fee ordering
npm run check:strategy -- <file>          # static cheatcode check of strategy code (entry side)
```

> The entry points for a run are `sim:realtime` and `backtest` (identical output format, with `summary.json`'s `mode` being `"realtime"` / `"backtest"`). **SEED (= regime) is a label for the market conditions** — the price path is reproducible, but tx timing/ordering is non-deterministic, so results vary even within the same regime. When you need to compare runs, accumulate samples and aggregate — [Backtest](backtest.md)'s `--repeat N` handles the iteration and the display of mean alphaUsdc for you.

## Key fields in summary.json

| Field | Meaning |
|---|---|
| `mode` | `"realtime"` / `"backtest"` (which entry point the run came from) |
| `agents[].initialValueUsdc` / `finalValueUsdc` | total value at run start / end (USDC-equivalent, including the valuation of venue positions) |
| `agents[].alphaUsdc` | β-removed PnL relative to the fair price at fill time (look here for skill comparison) |
| `agents[].netPnlUsdc` | `finalValueUsdc − initialValueUsdc` |
| `agents[].includedTxCount` / `revertCount` | number of included / reverted txs |
| `agents[].stderrTail` | tail of the agent process's stderr (for crash diagnosis) |
| `valueSeries.failedReads` | number of cross-sections that could not be read during value reconstruction (`0` if healthy) |
| `violations` | violations from the post-run rule checks (fee limit overruns, etc.) |

## Liquidation Attribution (stress runs)

Liquidation attribution is not done by a dedicated tool; instead, cross-reference `stress_liquidation` in `events.jsonl` with each agent's `liquidationCall` (rawTx) in `agents/<id>.jsonl` (read the jsonl directly). See [Market Stress Events](stress-events.md) for details.
