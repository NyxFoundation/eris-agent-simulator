[← Index](README.md) | [← 09 Dashboard](09-dashboard.md) | [11 Invariants →](11-invariants.md)

# 10. Operations

## 10.1 The commands

Source: the `scripts` block of `package.json`.

### Running

| Command | Role |
|---|---|
| `npm run sim:realtime` | One realtime run. Configured by `config/local.yaml` (`--config` for another file; `--seed`/`--blocks`/`--protocols`/`--agents` for one-off overrides) |
| `npm run anvil` | Start the Anvil fork in another terminal (fork mode only; not needed for local deploy) |
| `npm run backtest -- --regime <name> --seed <N>` | Replay one scenario on a dedicated anvil |
| `npm run backtest -- --scenarios <path>` | Replay a whole matrix on one anvil and produce standings |

### Generation

| Command | Role |
|---|---|
| `npm run build:contracts` | forge build for the PriceFeed and mock oracles (once, if `out/` is missing) |
| `npm run gen:local-constants` | `deployments.json` → `sdk/src/constants.local.ts` |
| `npm run gen:state-dump` | A distributable state dump plus manifest, from the running deployer anvil |
| `npm run gen:method-selectors` | The selector → function-name table, from venue ABIs |
| `npm run manifest` | The environment manifest (`--participant <id>` prints one key to stdout) |
| `npm run bundle:agent <id>` | The submission zip |

### Analysis and viewing

| Command | Role |
|---|---|
| `npm run metrics -- <runDir...>` | Rescore stored runs under every candidate metric |
| `npm run metrics -- --matrix runs/matrix-<id>` | Rescore a matrix across every metric × aggregator |
| `npm run dashboard` | The dev server (:5173) |
| `npm run dashboard:build` / `dashboard:serve` | The operator-hosted dashboard (:5174) |
| `npm run explorer` / `explorer:down` / `explorer:reset` / `explorer:tag` | The local Blockscout |

### Checks

| Command | Role |
|---|---|
| `npm run typecheck` / `npm run test` | Type check / unit tests |
| `npm run check:strategy` | The cheatcode static check on strategy code (the submission gate) |
| `npm run check:boundaries` | The workspace dependency direction |
| `npm run check:ordering -- --live` | **Bid against the chain to measure whether the builder orders by fee** |
| `npm run stress:rpc` | Measure RPC capacity under Eris-shaped read load |

## 10.2 Local-deploy setup

The default path avoids fork RPC latency by **deploying every venue onto a bare anvil**.

```
first time only:
  cd deployer && npm install && forge build && cp .env.example .env && ./scripts/setup-vendors.sh

every time:
  cd deployer && npm run deploy -- --keep-fresh   # start anvil and deploy every venue (never pass --exit)
  npm run gen:local-constants                      # import the deployed addresses
  npm run sim:realtime
```

| Caution | Why |
|---|---|
| **Rebuild the anvil when you redeploy** | `--keep-fresh` only deletes `deployments.json`. Seeding every venue spends ~999k of the deployer account's 1M ETH, so a second pass on the same anvil dies wrapping WETH with `insufficient funds` |
| **Do not use partial redeploys (`--only`)** | Shared tokens are recreated, leaving venues on inconsistent addresses (the symptom is `WETH9 insufficient allowance`) |
| The heavy `vendor/` clones | Not in git; `setup-vendors.sh` reproduces them |

To go back to a fork: `run.localDeploy: false`, remove `lst` and `liquity` from `run.protocols`, set `ARB_RPC_URL`, and run `npm run anvil` in another terminal.

## 10.3 Backtesting

### The state dump

`npm run gen:state-dump` writes a distributable dump into `backtest/state/` from the running deployer anvil (ADR 0016).

- Before dumping it reverts to the clean cross-section in `.local-snapshot`, and **regenerates `constants.local.ts` from the same deployments**
- The manifest records the source commit, the deployments and a fingerprint
- `--load-state` accepts plain JSON only

### Validation at run time (`core/src/backtest/shared.ts`)

| Check | On mismatch |
|---|---|
| Deployments fingerprint | **Regenerates `constants.local.ts`** from the deployments bundled in the manifest |
| Genesis | **Fails fast** |
| Missing venues | Stops, naming what is absent (with a `--protocols` hint) |

### The CLI

```
npm run backtest -- (--regime <name|path> --seed <N> | --scenarios <path>) [options]
  --agents <roster>    replace the regime's default roster
  --metric <name>      the standings metric (default netPnlUsdc)
  --repeat <N>         repeat each scenario N times (a calibration diagnostic; standings take the median)
  --port <N>           port for the backtest-only anvil (default 8547)
  --state <dir>        state dump directory
  --keep-anvil         leave anvil running afterwards
  --blocks/--seconds/--protocols/--economic-gas/--score-every
```

| Rule | Contents |
|---|---|
| **A scenario is (regime, seed)** | Regime YAMLs carry no seed, so `--seed` is required (ADR 0017 §1). Omitting it does not silently mean "the default seed" |
| `--regime` and `--scenarios` are exclusive | `--seed` does not apply to `--scenarios` (the set supplies the seeds) |
| `--config` is not accepted | In a backtest **the regime YAML is the run config** |
| **Overrides are written into the effective regime YAML** | Applying them only to the coordinator kills the agents on observation. The `--agents` roster propagates the same way |
| `--score-every N` | Thins the scoring cross-sections. **The score is unchanged**; only the equity curve gets coarser |

`--scenarios` replays the cartesian product on one anvil with snapshot/revert between scenarios, writing `runs/matrix-<id>/matrix.json` and `standings.json` ([08 §8.9](08-artifacts.md)).

## 10.4 The practice devnet

ADR 0021. **A chain that never stops, with self-hosted participants.**

### It is not the official scoring

The competition is scored from submitted bundles replayed over a scenario matrix (ADR 0017 / 0020), and **nothing from the practice period feeds into it**. The standings carry a permanent `practice` badge whenever `resetUnit === "continuous"`.

> **The test is "is it continuous", not "is it not scenario".** `matrix.json` files written before ADR 0020 have no such field, and those were the official shape.

### Running a period

```
1. Stand up the external chain (an OP Stack devnet) and deploy the venues
2. Put ANVIL_RPC_URL / CHAIN_ID / TREASURY_PRIVATE_KEY in .env.local
3. Switch the address overlay: DEPLOYMENTS_JSON=<path> npm run gen:local-constants
4. Build the roster (a registration list) from config/practice.yaml
5. npm run sim:realtime -- --config config/practice.yaml --chain-mode external
6. npm run manifest to distribute the environment manifest (keys individually, via --participant <id>)
7. npm run dashboard:serve to host the dashboard
```

Step-by-step instructions are in `docs/guide/practice-devnet.md`.

### The roster is a registration list, not a launch list

[05 §5.9](05-agent-contract.md) / [07 §7.5](07-configuration.md). Use `external: true` with `address` — **a key the operator generated is a key the operator has**, so the participant holding their own key is the safer registration.

### What is given up

| Item | Why |
|---|---|
| Tracking **submitted-but-not-included** | Unverifiable in principle for an agent the operator does not run |
| Decision logs | They live on the participant's machine |
| Resets | On a practice ground that is the design |

### Output is cut into daily segments

`run.segmentHours` ([02 §2.5](02-runtime.md)). The chain stays continuous; only the run directory is cut.

### A warning about the hosted dashboard

**It is read-only, but it is not an access boundary.** Everything under `runs/` becomes public ([09 §9.8](09-dashboard.md)).

## 10.5 The explorer (local Blockscout)

`infra/blockscout/`, on pinned stock images. The UI is at http://localhost:3100.

| Action | Contents |
|---|---|
| `npm run explorer` | Start it |
| **`npm run explorer:reset`** | **Run this whenever the chain is reset.** The indexer cannot follow a resetFork or a snapshot-revert rewind, so **wiping the DB and reindexing is the intended lifecycle** |
| `npm run explorer:tag` | Name-tag agent addresses from the latest run's `summary.json` (a reset clears them, so it is per run) |

The endpoint, chain id and the fork's `FIRST_BLOCK` live in `infra/blockscout/explorer.env`.

## 10.6 Measuring ordering and capacity

### `npm run check:ordering`

| Form | Contents |
|---|---|
| No arguments | A post-hoc inspection of `blocks.csv` |
| `--live` | **Bids against the chain to measure it** (the load-bearing assumption of #35) |

The default profile stacks the oracle above every agent to pin it at txIndex 0, so **on a chain that does not honour fee ordering the environment's price becomes front-runnable**.

**The bids are sent in ascending order**, so arrival order and fee order disagree. A builder that merely preserves arrival order passes a descending probe and fails this one.

### `npm run stress:rpc`

Fires the same read set as `reconstruct.ts` through Multicall3, per agent per block, and reports cold/warm p50/p99, block-interval jitter with and without load, the reachable depth of `eth_call`, and whether the endpoint is sequencer-only or a replica.

**On a chain with nothing to read, it stops before measuring.** A call to an empty address is refused faster than a real balance is fetched, so total absence looks like enormous capacity — it once reported "3,360 obs/s, sequencer-only is enough" against an anvil with nothing deployed on it.

## 10.7 Heavy runs on spot EC2

When local CPU or memory is tight, throw the run at a spot EC2 built from a golden AMI. It assumes local deploy (no fork), is self-contained, and its only external dependency is LLM (ollama) egress.

- An anvil state with every protocol deployed is baked into the AMI, so launch restores all five venues in ~10 seconds via `anvil --load-state` — no install, no deploy, running in ~3 minutes
- Results come back over SSH (no S3, no IAM role)
- AWS uses the `eris` profile
- The scripts live in the user-global spot skills (`~/.claude/skills/spot-{run,bake,ops}/scripts/`)

| Skill | Purpose |
|---|---|
| `/spot-run` | Run on the golden AMI and collect the results (the everyday driver) |
| `/spot-bake` | Bake a new golden AMI (after a dependency, deployer or constants change). ~35 minutes |
| `/spot-ops` | First-time setup (key + SG + IAM), status, cleanup |

> **A rebake is due**: ADR 0015's workspace split changed what `npm install` targets and the paths it assumes, so the next spot use needs `/spot-bake`.
>
> **Do not bake on spot** — the instance gets reclaimed mid-bundling and takes the AMI with it. Use `ERIS_BAKE_MARKET=on-demand`. A failure still exits 0, so verify the artifact exists.

A collected run opens in the dashboard as-is: it unpacks to `runs/<collection>/runs/<runId>/`, and the index walks two levels deep ([09 §9.8](09-dashboard.md)).

## 10.8 Removed commands

These do not exist. Post-run analysis reads `runs/<id>/` directly, or uses `npm run metrics` and the dashboard.

`sim` (synchronous rounds) / `evaluate` / `gate` / `discrimination` / `leaderboard` / `stress-report`
