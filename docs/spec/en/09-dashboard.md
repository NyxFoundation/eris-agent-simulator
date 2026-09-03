[← Index](README.md) | [← 08 Artifacts](08-artifacts.md) | [10 Operations →](10-operations.md)

# 09. Dashboard

The `dashboard/` workspace (Vite + React). A viewer and analysis UI that **nothing in a run or its scoring depends on**: it reads `runs/<id>/` off disk, and the anvil over JSON-RPC when it needs to.

Sources: `dashboard/src/{App.tsx,navigation.ts}`, `dashboard/src/data/*`, `dashboard/server/runsApi.ts`.

## 9.1 The information hierarchy

```
competition  ⊃  scenario (one world, "regime#seed")  ⊃  round (one scoring epoch)
```

Defined once, in `dashboard/src/data/competition.ts:1-8`.

- A competition is normally the `matrix.json` written by `npm run backtest -- --scenarios`. A segmented period has the same shape
- **There is no second model for "a run outside a competition".** One `sim:realtime` run is "a competition of one scenario", and `competitionFromRun` wraps it into the identical shape. **Normalizing at one point in the data layer means every page downstream sees exactly one kind of object**
- The word "matrix" is gone from the UI (the on-disk `matrix.json` is core's output and keeps its name)

### Routes

| Path | Page |
|---|---|
| `/` | Standings (the competition) — **the default landing** |
| `/scenario` | One scenario in detail |
| `/agent/<id>` | Agent detail |
| `/markets` | Venue state (scenario level) |
| `/explorer` | Blocks and transactions (scenario level) |

**Why `/` is the competition**: one scenario is a single draw from a distribution, not a result (`config/scenarios/public.yaml`: "the published seeds are five draws from it, **not the target**"). Landing there would show the unit you must not read first.

`/markets` and `/explorer` stay at the scenario level because venue state and a block range only mean anything inside one world.

**Removed routes**: `/standings` and `/leaderboard` (duplicated the in-scenario ranking), `/archive` (a relic that was never reached), `/run` (an alias).

## 9.2 The round cursor (the UI's clock)

`dashboard/src/data/roundCursor.ts`. **The position exists exactly once.**

Scores, rank changes and environment events are all measured in epochs, so every view reads against this axis. **The round axis used to be reimplemented three times** (round selection, replay head, live head) — three stores, one concept.

| Property | Contents |
|---|---|
| `round` | **1-based and competition-relative.** `null` means the end, i.e. the finished result |
| Meaning | **At round k, all 35 scenarios are at their own round k** — which is what makes 35 independent worlds watchable as one competition |
| Playback | Advancing the cursor (not a separate "replay mode"). 1x/2x/4x, one tick every 700ms |
| The end | **Parks rather than looping** (a cursor that silently restarts reads as a competition that rewound) |
| Range changes | A position still inside the new range is kept. **A position past the end parks at the end** (round 20 of a nine-round scenario is not round 9) |

Block-level movement inside one scenario stays in `replay.ts`. It is a **refinement** of this position, not a competing notion of it, and exists only while a single scenario is open. When armed, replay drives the cursor; the cursor never drives it back.

## 9.3 Standings

### The rule is fixed (for participants)

The metric × aggregator controls, the λ/ρ sliders, the disagreement panel and the #55 exposure were removed on 2026-08-31. Rescoring under other metrics is `npm run metrics -- --matrix`'s job.

```
per scenario   M9 = mean − λ·std (λ = 0.25)
  → z-score within the scenario
  → mean with equal weight per regime
```

**The aggregation is imported by the dashboard from `core/src/scoring/aggregate.ts`** (through the `@core/*` alias). Two implementations of one ranking leave no way to tell which is real when the CLI and the screen disagree.

### Display

| Column | Contents |
|---|---|
| Score | **The equal-weight regime mean of M9 itself** (×10⁴, no unit label). The aggregated z is demoted to a tooltip |
| net PnL (final marks) | A reference column: the quantity where β cancels and `noop` is exactly 0 |

The z is kept out of the table because **a unitless z cannot answer "by how much"**. **The displayed value and the rank can occasionally disagree**, which is the difference between the aggregators, and the caption says so.

### The `practice` badge

Shown permanently when `competition.file.resetUnit === "continuous"` (`HomePage.tsx:142`). ADR 0020 §2 puts the official competition in `scenario` mode, so **a continuous competition is by construction not the official scoring**.

**The test is "is it continuous", not "is it not scenario"** — `matrix.json` files written before ADR 0020 have no such field, and those were the official shape. Getting it wrong in that direction is the same kind of error.

A ranking whose provenance travels separately from the ranking will be misread, so it is stated **on the standings itself**.

### "Through round k"

The ranking is **recomputed over the first k rounds** (it never reads the finished result), and the move from round k−1 is shown alongside.

`summary.json`'s `logReturns` are **already floored, already in excess of the baseline, and already frozen at bankruptcy** — every part of the construction except λ. So "through round k" is exactly `mean − λ·std` over the first k entries, not an approximation (`dashboard/src/data/standings.ts:47-53`).

### When scenarios have different lengths

In full-8h, depeg runs 9 rounds and the others 29. **A scenario past its last round is treated as a world that ended and stays in the ranking** (removing it would move the field for a reason that is not a result). The band says `30 of 35 still running · 5 ended earlier`.

### net PnL cannot be scoped to a round

Both ends are priced at the run's final marks, so there is no value for round k. It appears only as a reference column, and **while scrubbing it is greyed out so a finished value is never labelled with a round**.

### Two cases with no ranking

Both land on the scenario view and say so.

1. **A live run** — `summary.json` is written at the end, so the result does not exist yet
2. **The seed provider** (fixtures)

## 9.4 The scenario page

Stacked sections rather than tabs (`dashboard/src/pages/ScenarioPage.tsx`).

```
RoundsBar     the round axis
hero          the scenario's name (regime#seed, with the `full-` prefix stripped) + seed + rounds/blocks
leaderboard   the ranking within this scenario
market tickers / blocks / tape (the event stream)
SectionPanel  Markets (→ /markets) / Standings / Explorer (→ /explorer)
InfoTabs      overview / environment / scoring / artifacts (the learning layer)
```

**The hero names the scenario itself.** It used to be the ERIS wordmark, which made every scenario look like the application's front page and said nothing about which of the 35 worlds was on screen.

**Implementation vocabulary (file names, ADR numbers) may appear only in the InfoTabs** (§9.10).

### Putting environment events on the round axis (`dashboard/src/data/schedule.ts`)

`stress_schedule` is **the plan drawn from the seed**, in run-relative blocks. It is converted **onto the round axis** (`fromRound` / `toRound` = `ceil(block / epochBlocks)`), because the round is the axis everything else is on.

- The schedule is written before the first block, so **reading the first 128KB of events.jsonl is enough**: 4MB across 35 scenarios, against 102MB for the whole files
- `windowsAtRound(schedules, round)` collects every window covering that round across the competition and **puts the ones that just opened first** (a window open for three rounds is context; one that just opened is the news)
- The standings' round note prints that in one line

**`crash` / `spike` / `cexDrift` / `flowTrend` leave no per-block record** (they change the price walk itself), so this is **the plan and is labelled as such**. It never says "never fired"; it says "look at the price chart".

**The seed is recorded in `run_started_realtime`.** For older runs without it, the stat is simply not shown.

### Panel scoping

Panels are scoped to the selected round. **`scopeRunToBlocks` (`runsProvider.ts:1358`) narrows the run object itself by a block window**, so no builder grows a second code path. The header states the window and offers a link back to the whole run.

**The exception is the end-of-run cross-section tables** (GMX positions / Aave accounts / reserves), which are a single snapshot at the end and say "at the run's final block" in the title. When an agent genuinely ended flat, the panel says so in prose — "no venue position open at the final block; this agent ended flat, or the run predates per-venue position tracking".

**Per-round volumes summing to less than the whole run is correct**: the scorer drops the trailing partial epoch, so blocks after the last boundary belong to no round.

### The rounds bar

The bar is the selected run's own epoch series (`valueSeries.epochSeries.boundaryBlocks`). Clicking a segment opens that round's per-agent result.

- **`Δ value` and `log return` are different quantities**: the first is the raw change including β (so even `noop` moves), the second is excess over the baseline — the series the score averages
- A live run has no scored series, so the frame is drawn from `run_started_realtime.epochBlocks` to show progress, and the results arrive on completion

## 9.5 `/markets`

Shows **venue state, not prices**. One tab per enabled protocol (AMM / Perp / Lending / Stablecoin / LST).

| Source | Covers |
|---|---|
| `market.json` | AMM, perp, lending, stable prices |
| **`lst_block` / `liquity_block` in `events.jsonl`** | The market-wide state of the LST and Liquity venues |

Reading those two from events avoids reconstructing what the coordinator already emits every block — and means older runs still render. The builders live in `dashboard/src/data/venuePanels.ts`.

### Agent positions

**Every venue is covered** (`gmxPositionsAtEnd` / `aaveAccountsAtEnd` / `lstPositionsAtEnd` / `liquityPositionsAtEnd`).

Only GMX used to be, so an agent that spent the run staking or borrowing produced an empty table indistinguishable from a broken one. The table is not perp-shaped: it is **venue / kind / size / what it is marked against (entry price, redemption rate, ICR, HF) / detail**.

## 9.6 The agent page

The default tab is **Standing (why this rank)** — but only when the agent ranks in a competition; otherwise (seed mode, live runs) it lands on Overview (`AgentDetailPage.tsx:516`).

It pools that agent's epochs **across the whole competition** and shows mean / std / λ·std / the distribution / a per-regime breakdown. M9 itself is per scenario and then averaged per regime, so this is **an explanation, not a second ranking**.

Measured: `clean-arb` ranks first on +0.32bp per round with a std of 1.78bp; `levered-long-max` ranks last on **+4.90bp** with a std of **78.60bp**. **The agent earning fifteen times as much is last**, and the whole difference is std. Split by regime, it is +48.3bp in `cex-drift` and negative in the other six — i.e. a story about regime fit.

**The decision-log tab is hidden for external agents** ([05 §5.9](05-agent-contract.md)); an empty panel is a different claim. The submission feed states how many agents will not appear there.

## 9.7 Live and replay

### Live

A run in progress appears as `● (live)`.

| Test | No `summary.json`, and **the newer of** `events.jsonl` / `blocks.csv` was touched within 120 s (`runsApi.ts:23`) |
|---|---|
| Sources | Tailing the events and agent jsonl, plus reading the head block from `run_started_realtime.rpcUrl` |
| Transition | Scores and venue series switch to the archived rendering when the run completes |

**Why the newer of the two**: during teardown (the bulk blocks.csv scan, then the reconstruction sweeps) events.jsonl can be silent for tens of seconds. A run that briefly drops out of the index sends the dashboard to a neighbouring run and strands it there — the live refresh loop stops with the run it lost.

### Replay

Walk a finished run forward as "at block B" (`▶ replay` on the rounds bar).

**Live mode only works on the machine that ran the run** (the tail is the dev server's filesystem and the chain reads go to the agents' anvil), so **replay is the only way to watch a finished run, or one collected from a spot box**.

Archived carries *more* information than live (`market.json`, scored epochs, a complete `blocks.csv`), so it is a superset rather than a degraded mode.

**Not showing the future is a requirement**:

- A round that has not closed has no result
- The ranking is **recomputed as `mean − λ·std` over closed rounds only** (reading the finished score would print the answer on every frame)
- The end-of-run position tables are withheld until the head reaches the end

## 9.8 Finding runs (the `/runs` API)

`dashboard/server/runsApi.ts`. **The dev server and the hosted server share the handler.**

| Endpoint | Contents |
|---|---|
| `/runs/index.json` | Run directories, newest first, tagged `live: true` / `kind: "matrix"` |
| `/runs/<id>/<artifact>` | The artifact itself |
| `/runs/<id>/tail/<file>?offset=N&limit=M` | An incremental tail of a jsonl/csv artifact |

- **It walks two levels deep** (`MAX_RUN_DEPTH = 2`), because a run collected from a spot box unpacks to `runs/<collection>/runs/<runId>/`. The picker shows it as `<runId> ← <collection>`
- An id is a path relative to `runs/` and can contain slashes, so a tail request splits on **the last `/tail/`**
- **A competition directory is not a leaf**: a directory holding `matrix.json` has segments inside it, and those are runs
- A tail returns at most 4MB. An explicit `limit` reads only the head — `run_started_realtime` and `stress_schedule` sit in the first few KB
- Paths are resolved with a prefix check **and `realpath`** (a symlink under `runs/` could otherwise point anywhere on disk)

**`npm run dashboard:serve` is read-only but is not an access boundary** — everything under `runs/` becomes public ([10](10-operations.md)).

## 9.9 Naming

**Internal ids do not appear in the UI.**

| Subject | Displayed as |
|---|---|
| Competition | Derived from the scenario set and the date (`full-8h` in the h1, `full-8h · 8/29` in the picker, the raw id in a tooltip). **The `full-8h` here is a name a stored run recorded**; the set file itself was folded into `public.yaml` when the regimes were consolidated. The display name comes from `matrix.json`'s `scenarioSet`, so a retired set name keeps appearing on the runs that used it |
| Scenario | Always `regime#seed` (with the `full-` prefix stripped). Segments use a date label |
| Run | `2026-08-29 16:03` (the directory's timestamp, formatted) |
| **"Run N" sequence numbers** | **Gone** — a coordinate on the developer's machine that means nothing to a participant |

**Identity and display are separate**: a scenario is keyed by `runDir`, the only field guaranteed unique (a matrix can repeat (regime, seed) under `--repeat`, and segments can share a label). Keying on the label collapsed six segments into one and pooled their rounds.

## 9.10 i18n

`dashboard/src/i18n/` (a locale store and a full message dictionary, `messages.ts`). Toggled in the sidebar, persisted in localStorage, defaulting to the browser language.

**The data-layer builders call `t()` too** (`venuePanels`, and the tape and position tables in `runsProvider`), so `useSnapshot` includes the locale in its key and rebuilds the snapshot on a language change.

Wording rules:

- Implementation vocabulary (file names, ADR numbers) appears **only in the learning layer** (the scenario page's Info tabs)
- Units are always attached (bps, USDC)
- The state words are **live and finished**, and only those two
- `npm run` commands appear only in a local-operations context, such as starting the explorer

## 9.11 Blockscout integration

When it is up, transactions, blocks and addresses become deep links and the indexer's height is shown next to the RPC height. **When it is down the links simply disappear** (nothing else degrades).

`/explorer` states the connection (indexed height, or the command to start it) and resolves searches for transaction hashes, blocks, addresses and **agent names** (→ wallet address; Blockscout does not know names). Without Blockscout it still works as a filter over the local listing.

## 9.12 Development

`VITE_DATA_PROVIDER=seed` switches to fixtures (`dashboard/src/data/seed.ts`). The seed provider has no ranking, and the UI says so.
