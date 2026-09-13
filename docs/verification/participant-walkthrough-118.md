# Participant walkthrough fixes (#118–#123)

The participant-facing corrections are in both `docs/competition-start.md` and
`docs/competition-start.en.md`. The local validation below used an isolated worktree of main
`48e9bdc` plus these changes, leaving the participant's uncommitted agent untouched.

| Finding | Resolution and evidence |
|---|---|
| A: gas capital | §1 names the scored 100 ETH, spendability and WETH-only sizing. At ETH=$3,000/BTC=$60,000 the portfolio is $373,000; 0.8 WETH is about 0.64%, not 10%, of it. |
| B: P endpoints | §6 names `pnlUsdc` and `valueSeries.epochSeries`; both-final-mark `netPnlUsdc` is separate. The linked output reference uses the same distinction. |
| C: resting gaps | §3 explains the fee band, bounded background flow, depth and inclusion delay. The WBTC calibration question is tracked separately in #124. |
| D: noise control | §6 includes a same-directory frozen twin and explains the measured variation, including for rule-only strategies. |
| E: missing state | §2 generates the ignored state dump after deployment, before §6 uses it; §6 names the missing-file recovery. |
| F: missing images | §6 builds every roster directory before the first Docker backtest; twins reuse their source directory's image. |
| G: stale dependencies | `npm install` after pull is explicit in §6 and the §10 checklist; full-suite prerequisites have their own linked guide. |
| H: CLI backends in Docker | §5 restricts host CLIs to process mode and describes reachable API/proxy backends for containers and revision outcome checks. |
| I / #119: wrong roster | Realtime rejects conflicting inline/external rosters. Backtest passes the baked config to the coordinator without reapplying its CLI. Tests cover the conflict, valid external rosters and both flag spellings; a real backtest started the requested noop-only roster. |
| J / #120: incomplete prompt | Both literal templates load through the runtime and name all four evidence sections and both reply shapes; regression tests extract the Markdown code fences. |
| K / #121: conditional self-test | The exact returned run is read for PASS/FAIL, counts, early-exit reason and stderr. Missing/malformed output, missing chain, failed baseline and leftover containers fail. Code 137 is described as possible OOM, not proof. |
| L: stale linked guides | Removed retired amount-cap claims and corrected the official funding basket in the authoring guide. |
| M: invisible event windows | Every schedule entry has an application summary and event index. Skipped windows and incomplete price peaks produce warnings. Submission stages include hashes for receipt verification; process inputs are distinguished from executed trades. |
| N: fee ordering | §6 explicitly joins submitted hashes to `priorityFeeWei` and `txIndex` in `blocks.csv`. |
| #122: suite scheduling | Default test-file concurrency is capped at four; production deadlines remain unchanged. Setup and repeat instructions are in `docs/guide/testing.md`. |
| #123: stale runtime base | Every team build refreshes the source-dependent base and prints its digest/build time; a failed base stops the team build. Repeated builds and failure propagation are tested with a Docker command recorder. |

## Measurements

- macOS arm64, Node v23.5.0, Python 3.13.7 in an isolated venv. The original report used a pyenv
  shim; this validation used the direct interpreter. Uncapped file concurrency passed three times
  after installing the Python SDK and compiling the root contracts: 44.42 / 46.23 / 56.43 seconds.
  This did **not** reproduce the original timing failure under the direct interpreter.
- With the cap, the event-audit revision passed three full-suite runs: 833 tests, 828 passed,
  5 skipped, 0 failed, in 49.03 / 36.52 / 36.32 seconds. One skip was a missing deployer LST
  artifact (the testing guide now includes that build); four require a local deployment/registry.
  After building deployer artifacts and adding the unavailable-chain regression, the full suite
  passed 830/834 with those four local-mode skips in 43.85 seconds. The Python SDK’s five tests,
  TypeScript check, import-boundary check and strategy static check also passed. The three
  registry-gated cases passed in a separate local-mode run (16 tests, zero skips); the remaining
  LST/Aave integration requires a deployment with that optional collateral reserve.
- Dedicated Anvil port 18648, 24-block crash fixture: `blocksProcessed=24`, `failedReads=0`, seven
  `stress_event_applied` publications, all seven hashes matched successful `blocks.csv` receipts.
  The measured overlay peak was 0.15, equal to its configured magnitude, with no application warning.
  Unit tests also cover skipped windows, a partial ramp, overlapping/multi-base overlays, drift
  inputs, and all non-price event categories.
- The reused state snapshot contains all deployed venues and predates this branch; it was copied
  into the isolated worktree. This is replay validation, not a claim to have freshly deployed every
  vendor from a clean clone.

## Independent re-walk

The post-merge walk requested by #118 should use a different reviewer and start without state or
images. Check local deployment and state generation, Docker builds, both TypeScript and Python,
fork-mode instructions, and a reachable inference backend that installs a revision. These changes
make that walk executable; the successful replay above does not substitute for that independent
review or for a complete fork/LLM-provider test.
