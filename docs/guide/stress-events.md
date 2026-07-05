[← README](../../README.md)

# Market Stress Events (spike/crash + Aave liquidation; off by default)

The effective price is derived by overlaying a **SEED-derived, randomized deterministic overlay** (`core/src/realtime/events.ts`) on top of the OU base price. The effective price propagates consistently to the PriceFeed, the Aave WETH oracle, GMX, and scoring, and holds β≈0 outside the window. It builds a group of seed-derived victims (excluded from scoring) to make liquidations happen. Configure it in the `stress:` section of `config/local.yaml`:

```yaml
stress:
  events:
    - { type: crash, magnitudeRange: [0.12, 0.16], windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }
  victimCount: 0   # >0 builds liquidatable victims (fresh state required; see below)
```

> To try it quickly, the fastest path is to run the official regime `config/regimes/crash-01.yaml`
> (which includes 2 victims + a liquidator roster) via [Backtest](backtest.md): `npm run backtest -- --regime crash-01`.

- `stress.events` — give **ranges rather than values** to curb overfitting (a `spike`/`crash` trapezoid, ramp→hold→decay). Requires `run.blocks>0`.
- Building victims requires **fresh state** (with a soft reset, victim positions from the previous run linger and break the HF; fail-fast if not satisfied): fork uses a full re-fork (with `ARB_RPC_URL` set), local deploy satisfies it via the resetFork snapshot/revert clean cross-section (ADR 0016; proven in backtest). On local, the coordinator automatically calibrates the Aave oracle to the initial fair price before building victims (because the fork's "oracle ≈ market ≈ fair0" does not hold locally).
- To breach, the crash magnitude must satisfy `m > (HF0−1)/HF0` (for HF0=1.10, m>9.1% → the example [0.12,0.16] breaches reliably). Configs that cannot breach emit `stress_calibration_warning`.
- The condition to **be able to build** victims is `victimHf0 ≳ LT/(0.97·LTV)` (with measured Arbitrum WETH LT=0.84 / LTV=0.80, ≈1.08; below this the borrow pins to the LTV edge and fails-fast). Specify it via `stress.victimCount` (default 0 = disabled) / `stress.victimHf0` (default 1.10) / `stress.victimWethWei` (supply per victim).
- stress/vuln runs (any of `stress.events` / `stress.victimCount>0` / `vuln.events` enabled, and `run.blocks>0`) **automatically disable the time limit** and end by block count (avoiding the accident where `--seconds` expires first and the event window is never reached).
- The coordinator emits `stress_schedule` / `stress_victim_hf` / `stress_liquidation` to `events.jsonl`. Victim addresses are distributed to the liquidator agent via `ERIS_LIQUIDATION_VICTIMS`. For liquidation attribution, the agent log's `liquidationCall` (rawTx) is the primary source.
