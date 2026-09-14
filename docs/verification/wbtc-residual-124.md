# WBTC residual calibration (#124)

Two defects contributed to WBTC's persistent premium: inventory exhaustion made informed sellers
buy an already overpriced pool, and the stated USD parity of the WBTC flow did not hold for its
funding or Uniswap informed cap. This change fixes the direction guard and restores that parity.
It does not turn the 30bps entry threshold into a promised post-trade residual.

## Mechanism and configuration

On main `48e9bdc`, each flow wallet received 150 WETH ($450,000 at opening fair) but only 0.5 WBTC
($30,000). When a desired informed sell exceeded its remaining base balance, `buildAmmFlow`
switched to buying with USDC. The wallet thus replenished inventory by pushing the already
overpriced pool further away from fair. In the baseline below, Uniswap's informed WBTC wallet
ended with 0.03529226 BTC and repeatedly bought above fair after running low.

The initial reported depth was about $6m for **both** bases on each AMM; a systematically thinner
WBTC opening book does not explain this observation. `flow.baseMax.WBTC=5000000` ($3,000) matched
the 1 WETH uninformed/Balancer/Curve caps, but also supplied Uniswap's informed cap despite its
WETH counterpart being 2 WETH ($6,000).

- Cap informed sells to actual base inventory. At zero, emit no order; buying must itself be
  toward fair. Preserve the priority-fee RNG draw when the capped size is zero.
- Fund 7.5 WBTC ($450,000 at opening fair), matching the existing 150 WETH funding, across all
  twelve official regimes. These are unscored background wallets, separate from agent funding.
- Add `flow.baseInformedMax: { WBTC: "10000000" }` (0.1 BTC), an optional **Uniswap informed**
  override. Balancer/Curve and uninformed caps remain 0.05 BTC. Absence inherits `baseMax`;
  explicit zero disables Uniswap informed flow. The env form is `FLOW_INFORMED_MAX_WBTC_SATS`.
- Keep the fee band at 30bps. Sizing uses the excess deviation with a bounded proportional
  response, rather than solving for a pool price exactly at the fee boundary.

This changes regime YAML before #124's September 23, 2026 deadline. Scenario results from the old
and new calibration must be labeled separately; participant strategies should be rerun.

## Matched scenario measurements

Both runs used calm, seed 101, 360 blocks at 2 seconds, all seven venues, a noop-only `AUTO`
baseline roster and `--agent-sandbox process`. Removing active participants isolates background
flow, so these measurements are not directly comparable to the issue's multi-agent table.
Both completed in 718 seconds, reconstructed blocks 1154–1512 (359 samples), and reported zero
failed market reads. Opening price paths and depths were identical. The reused local state
manifest fingerprint was `sha256:026fe70e6f4e871b2c33171976cb961d5a7160c4f36363db27b09f95344a9eec`.

Before: `2026-09-13T15-27-08-248Z`, main `48e9bdc` plus the separate walkthrough fixes (unchanged
flow model). After: `2026-09-13T15-45-38-190Z`, main plus this calibration and direction fix.
The run used explicit WBTC override values; the subsequent absent/zero loader correction does
not change those values.

`gap = (fair / mid − 1) × 10000`; negative means the pool is above fair. SD is population SD;
the final columns are the fraction of valid blocks with `abs(gap)>80bps`.

| Base / venue | Mean before | Mean after | SD before | SD after | >80 before | >80 after |
|---|---:|---:|---:|---:|---:|---:|
| WETH / Uniswap | 4.7 | 16.9 | 66.1 | 58.3 | 22.0% | 20.9% |
| WETH / Balancer | −34.5 | 51.3 | 91.3 | 122.0 | 40.9% | 65.2% |
| WETH / Curve | 10.7 | 4.3 | 67.9 | 76.1 | 22.6% | 28.4% |
| WBTC / Uniswap | −160.4 | −10.0 | 121.1 | 65.7 | 71.9% | 24.2% |
| WBTC / Balancer | −8.3 | −11.1 | 87.6 | 85.5 | 46.2% | 33.4% |
| WBTC / Curve | −15.8 | −41.3 | 70.5 | 75.1 | 34.5% | 39.8% |

Successful informed buys/sells were also joined to current-block fair and previous-block mid.
There were 113 direction mismatches outside 30bps before, all WBTC/Uniswap buys, and zero after
(1,584 / 1,553 comparable transactions; three lacked a preceding sample in each run). This is
a diagnostic proxy for the decision state: delayed inclusion or intervening trades can affect it.
The code regression separately reproduces the reversal with a known balance and price.
Afterward, informed WBTC balances ended at 7.0253 / 7.0955 / 6.4153 BTC on Uniswap/Balancer/Curve.

This is one before/after sample, not a statistical estimate across seeds or a guarantee that every
venue tightens. WETH/Balancer and WBTC/Curve widened; shared quote inventory, flow contexts and
transaction timing can change the subsequent market path even with the same price seed. The
strongest conclusion is the reproduced direction defect and removed notional mismatch. The
measured improvement on WBTC/Uniswap supports that correction; broader residual targets need
repeated multi-seed/roster evaluation rather than tuning to this run.

## Reproduce and validate

Prepare the local state/dependencies using the starter guide. Use this roster in an ignored file:

```yaml
agents:
  - id: noop
    wallet: AUTO
    baseline: true
```

```sh
npm run backtest -- --regime calm --seed 101 --agents config/_residual-roster.yaml --agent-sandbox process
python3 scripts/measureResiduals.py runs/<before-id> runs/<after-id>
```

The script uses only Python's standard library, reports missing samples and failed reads, and
fails for missing/empty artifacts. Exact aggregate outputs are in
[`wbtc-residual-124.json`](wbtc-residual-124.json). Unit regressions cover exhausted/partial
inventory on all AMMs, buying below fair, exhausted quote funding, RNG continuity, USD parity
across all official regimes, optional-cap inheritance/zero behavior, and report error cases.

Validation on macOS arm64, Node 23.5.0 and Python 3.13.7: typecheck and import boundaries passed.
The final full suite (`--test-concurrency=4`, matching the separate #122 change) passed 835/839,
zero failures, in 83.64 seconds. Four cases require a local deployment/registry; the three
registry-gated cases passed in a separate local-mode run together with the changed flow/report
tests (59 tests, zero skips). The remaining LST/Aave case requires the optional collateral reserve.
