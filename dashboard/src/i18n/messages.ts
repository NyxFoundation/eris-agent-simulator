// Every user-visible string, in both languages, in one place.
//
// Rules the copy follows (the audit that produced them lives in the PR description):
//   - name things by what the viewer controls and recognizes, never by how the system is built —
//     no artifact file names, config paths, env keys or ADR numbers outside the learning layer
//   - one word per concept: competition / scenario / round, standings, live / finished
//   - every number carries its unit: bps per round, USDC, blocks
//   - empty states say what is true and what it means; errors say what happened and how to fix it
//
// `npm run …` commands are allowed only where the viewer genuinely operates the local tooling
// (starting the Blockscout explorer) — this dashboard is run by participants on their own machine.

import { getLocale } from "./locale";

const en = {
  // ---- common ----
  "common.loading": "Loading…",
  "common.loadFailed": "Couldn't load run data{detail}",
  "common.finished": "finished",
  "common.live": "live",
  "common.seeAll": "see all →",

  // ---- sidebar ----
  "nav.standings": "Standings",
  "nav.scenario": "Scenario",
  "nav.markets": "Markets",
  "nav.explorer": "Explorer",
  "nav.top": "Top",
  "sidebar.competition": "Competition",
  "sidebar.scenario": "Scenario",
  "sidebar.scenarioLive": "Scenario · live",
  "sidebar.singleRun": "— single run —",
  // The world a scenario-level page is on, in the picker's place (the standings page opens worlds
  // from its scenario list instead of a dropdown of names).
  "sidebar.world": "Viewing",
  "sidebar.worldOf": "{i} of {n} worlds",
  "sidebar.worldRounds": "{n} rounds",
  "sidebar.worldLeader": "leads: {id}",
  "sidebar.worldEvents": "episodes: {list}",
  "sidebar.worldNoEvents": "no episodes scheduled",
  "sidebar.change": "change",
  "sidebar.close": "close",
  "sidebar.readOnly": "Read-only view",
  "sidebar.noSignIn": "no sign-in required",

  // ---- round cursor (competition clock) ----
  "cursor.final": "Final · {n} rounds",
  "cursor.at": "Round {at} / {max}",
  "cursor.play": "▶ play",
  "cursor.pause": "❚❚ pause",
  "cursor.jumpFinal": "jump to final →",
  "cursor.complete": "{n} scenarios · finished",
  "cursor.completeOne": "1 scenario · finished",
  "cursor.running":
    "{running} of {total} still running · {ended} ended earlier",
  "cursor.atRound": "{n} scenarios @ round {at}",
  "cursor.atRoundOne": "1 scenario @ round {at}",

  // ---- home (competition standings) ----
  "home.stat.scenarios": "scenarios",
  "home.stat.regimes": "regimes",
  "home.stat.agents": "agents",
  "home.stat.rounds": "rounds",
  "home.stat.recorded": "recorded",
  "home.roundsFinal": "{n} · final",
  "home.roundsAt": "{at} of {n}",
  "home.missingRounds":
    "{missing} of {total} scenario runs were not collected — they still count toward the ranking, but have no round detail.",
  // ADR 0021 §1. Shown on any competition that is not a scenario matrix — the practice devnet runs
  // one continuous world (ADR 0020 §2 puts the official competition in `scenario` mode), so a
  // continuous competition is by construction not the official scoring. Said on the standings
  // itself, permanently, because a ranking whose provenance travels separately from the ranking is
  // a ranking that will be misread.
  "home.practiceBadge": "practice",
  "home.practiceNote":
    "Practice standings, not the official scoring. The competition is scored separately, from submitted bundles replayed over a scenario matrix — nothing here feeds into it.",
  "home.standingsFinal": "Standings · final",
  "home.standingsThrough": "Standings · through round {at}",
  "home.subtitle":
    "Score: each epoch (one scenario run) gives every agent a deviation score T = 50 + 10 × (P − μ) / σ, where P is its USDC profit over the epoch and μ, σ are the field's. The score is the average of T over the epochs, later epochs weighted up to 1.5×. Regime columns are the agent's mean T in that regime. Click a row for the epoch-by-epoch breakdown.",
  "home.col.move": "move",
  "home.col.agent": "agent",
  "home.col.score":
    "score",
  "home.col.netPnl": "net PnL",
  "home.scoreTitle":
    "{n} epoch(s) scored · tie-breaks: std of T {std}, worst epoch T {worst}",
  "home.netPnlTitle": "USDC, both ends priced at the run's final marks",
  "home.netPnlScrub": "final value — net PnL only exists at a run's end",
  "home.noteOpens": "{types} opens in {n} scenarios",
  "home.noteOpensOne": "{types} opens in 1 scenario",
  "home.noteOpen": "{n} windows still open",
  "home.noteOpenOne": "1 window still open",
  "home.noteNoMove": "nobody changed place",
  "home.noteMoved": "{n} agents changed place",
  "home.noteMovedOne": "1 agent changed place",

  // ---- the scenario list on the standings page ----
  // A competition is its scenarios; this is where you pick one, and picking one is a decision that
  // deserves more than a name in a dropdown.
  "home.scenarios.title": "Scenarios",
  "home.scenarios.subtitle":
    "One row per world: a regime drawn at a seed, with whoever leads it and what the environment is scheduled to do there. Click a row to open it. A single scenario is one draw from the distribution, not the result — the standings above are.",
  "home.scenarios.col.scenario": "scenario",
  "home.scenarios.col.rounds": "rounds",
  "home.scenarios.col.leader": "leader",
  "home.scenarios.col.events": "environment episodes",
  // "none scheduled" is about the episode schedule, not about the world being quiet: a regime such
  // as cex-drift can bend the whole run rather than open a timed window, and runs recorded before
  // those regimes were windowed have no schedule at all.
  "home.scenarios.eventsTitle":
    "Timed episodes drawn from the seed. \"None scheduled\" does not mean the world was quiet — a regime can shape the entire run instead of opening a window.",
  "home.scenarios.roundsAt": "{at} / {n}",
  "home.scenarios.ended": "ended",
  "home.scenarios.endedTitle":
    "This world ran out of rounds before the cursor. Its last value is its result, so it stays in the standings.",
  "home.scenarios.noEvents": "none scheduled",
  "home.scenarios.noLeader": "no result yet",
  "home.scenarios.missing":
    "round detail was not collected for this scenario",
  "home.scenarios.leaderTitle":
    "leads through the selected round, by P = V_k − V_0 (USDC) — the quantity the epoch's deviation score is taken over",

  // ---- how the units nest ----
  // "Round" means three different things to three different readers: a block, a scoring window, or
  // a whole run. Saying which one this dashboard means, once, beats disambiguating it per panel.
  "units.title": "How this fits together",
  "units.competition": "Competition",
  "units.competitionBody":
    "Every scenario replayed, ranked together. This page.",
  "units.scenario": "Scenario",
  "units.scenarioBody":
    "One world: a regime drawn at a seed, run start to finish. All agents trade it at the same time.",
  "units.round": "Round",
  "units.roundBody":
    "The scoring window — several blocks, not one. Scores, rank moves and environment episodes are all read against it.",
  "units.block": "Block",
  "units.blockBody":
    "Two seconds, and one chance to act. Transactions inside one are ordered by priority fee.",

  // ---- scenario page ----
  "scenario.fallbackTitle": "Scenario",
  "scenario.seed": "seed {n}",
  "scenario.roundsBlocks": "{rounds} rounds × {blocks} blocks",
  "scenario.heroMeta": "{agents} agents · block {block}",
  "scenario.markets": "Markets",
  "scenario.standings": "Scenario standings",
  "scenario.explorer": "Explorer",
  "scenario.info.overview.label": "Overview",
  "scenario.info.environment.label": "Environment",
  "scenario.info.scoring.label": "Scoring",
  "scenario.info.artifacts.label": "Data",
  "scenario.info.overview.p1":
    "Eris is a DeFi trading-competition simulator. Autonomous agents compete on a multi-protocol venue set — Uniswap v3, Balancer, Curve, GMX v2 and Aave v3, plus optional LST and CDP-stablecoin venues — all deployed on a local anvil chain.",
  "scenario.info.overview.p2":
    "Agents run as fully independent processes and see only finalized on-chain state: no privileged RPC, no pending transactions, no other agent's orders. Each block they observe, decide, and sign their own transactions; in-block ordering is by priority fee, so priority is something you bid for.",
  "scenario.info.overview.p3":
    "The environment daemon drives the market: a seed-derived fair price written on-chain every block, uninformed and informed order flow, a perp keeper, and scheduled stress events — crashes, liquidity pulls, stablecoin depegs, whale orders — that agents cannot opt out of.",
  "scenario.info.overview.p4":
    "Self-improving agents pair a rule strategy with an LLM that rewrites the strategy code mid-run. The LLM is never in the trade path: the rules trade every block on their own, and revisions install only after a static check, compilation, and a sandboxed test run.",
  "scenario.info.environment.p1":
    "A seed is a label for market conditions. The fair-price path is reproducible per (regime, seed), but transaction timing and in-block ordering are not — the same scenario replayed twice gives different fills, which is why the competition measures over many scenarios.",
  "scenario.info.environment.p2":
    "Official regimes: calm, cex-drift, informed-flow, whale, lending-incident, crash, and depeg. A scenario is one (regime, seed) pair; a competition replays a whole set of them and ranks agents per regime.",
  "scenario.info.environment.p3":
    "Stress events are randomized-but-deterministic overlays on the fair price (ramp, hold, decay), liquidity pulls that thin every AMM pool at once, and depegs where the environment leans on a stablecoin's pool until the window closes. Seeded victim positions make lending liquidations reachable for agents that watch health factors.",
  "scenario.info.environment.p4":
    "The fair price is distributed on-chain through a price feed and lands one block late for everyone equally — reacting to information a block after it exists is part of the game.",
  "scenario.info.scoring.p1":
    "Scoring happens after the run, not during it. The environment walks back over historical chain state and values every agent at identical block cross-sections, so the live loop pays nothing for it and no agent can game a snapshot phase.",
  "scenario.info.scoring.p2":
    "The score is one number per epoch: P = V_K − V_0, the change in total account value over the run (each end at its own 5-block-median marks), standardised over the field as T = 50 + 10 (P − μ) / σ. The benchmark is valued but not in the population.",
  "scenario.info.scoring.p3":
    "Net PnL and max drawdown come from the same reconstructed series and are shown for context; the rounds inside a run are the leaderboard's running progress, not part of the score.",
  "scenario.info.scoring.p4":
    "Holdings the scorer cannot price are reported, never silently zeroed — a zero that is really a read failure would be indistinguishable from a trading loss.",
  "scenario.info.artifacts.p1":
    "Everything on these pages is derived from the run's own recorded files: the standings and per-round scores, the reconstructed observations and event stream, every transaction, each agent's own decision log, and the per-venue market series.",
  "scenario.info.artifacts.p2":
    "The chain is the source of truth: every numeric series is reconstructed from on-chain reads after the run. Logs supply only reasoning, intent and identity.",
  "scenario.info.artifacts.p3":
    "While a run is live the dashboard tails the log files and reads the chain over RPC — prices, blocks, the event tape and decision logs update in place. Scores and per-venue series appear the moment the run finishes.",
  "scenario.info.artifacts.p4":
    "The local Blockscout explorer (npm run explorer) is the deep-dive tool: when it is running, every transaction, address and block on these pages links into it.",

  // ---- rounds bar (one scenario's clock) ----
  "rounds.segmentTitle": "Round {i} · blocks {from}–{to} · {tx}",
  "rounds.txOutside": "tx count outside the live window",
  "rounds.txN": "{n} tx",
  "rounds.heading": "Round {i}",
  "rounds.blocks": "blocks {from}–{to}",
  "rounds.openExplorer": "open in explorer →",
  "rounds.close": "close ✕",
  "rounds.notScored":
    "this round was not scored — the run has no per-round series",
  "rounds.scoredLater":
    "scored when the run finishes — results are reconstructed from chain history afterwards",
  "rounds.col.agent": "Agent",
  "rounds.col.delta": "Δ value",
  "rounds.col.logReturn": "Log return",
  "rounds.col.rank": "Rank",
  "rounds.bankrupt":
    "asset value at or below zero (bankrupt — no floor, no freeze)",
  "rounds.deltaNote":
    "Δ value is the raw change in account value, market exposure included — a do-nothing agent still moves with the price. Log return is the same round measured against the do-nothing baseline, and is the series the score averages. Rank is cumulative since the first round; the arrow is its change over this round.",
  "rounds.envDid": "What the environment did",
  "rounds.replayStart": "▶ replay",
  "rounds.replayStartTitle": "Walk this run forward from its first block",
  "rounds.replayExit": "exit",
  "rounds.blk": "blk {b} / {to}",
  "rounds.play": "Play",
  "rounds.pause": "Pause",
  "rounds.playAgain": "Replay again",
  "rounds.replay": "replay",
  "rounds.progress": "{done}/{total} rounds",
  "rounds.progressBlocks": "{done}/{total} rounds × {blocks} blocks",
  "rounds.noRounds":
    "no rounds in this run — it was too short for a single scoring round",
  "rounds.left": "{t} left",
  "rounds.replayPct": "replay {pct}%",

  // ---- agent page ----
  "agent.tab.standing": "Standing",
  "agent.tab.overview": "Overview",
  "agent.tab.rounds": "Rounds",
  "agent.tab.positions": "Positions",
  "agent.tab.trades": "Trade history",
  "agent.tab.log": "Decision log",
  "agent.back": "← back",
  "agent.rank": "Rank {n}",
  "agent.stat.score":
    "T (this epoch)",
  "agent.stat.pnl": "PnL (USDC)",
  "agent.stat.drawdown": "Max drawdown",
  "agent.standing.rank": "rank",
  "agent.standing.rankValue": "{r} of {n}",
  "agent.standing.score":
    "score",
  "agent.standing.scoreTitle":
    "tie-breaks (§4.6): std of T {std}, worst epoch T {worst}",
  "agent.standing.netPnl": "net PnL (USDC)",
  "agent.standing.rounds":
    "epochs scored",
  "agent.standing.explain":
    "Every epoch this agent was scored in. T is where its profit sat in that epoch's field (50 = the field's mean, ±10 = one standard deviation); the score is the weighted average of T, so a strategy that wins big in one regime and loses in the rest can place below a steady one — the std of T is also the first tie-break.",
  "agent.standing.noSeries":
    "No round detail for this agent — the scenario runs behind this competition were not collected, so the standing can be shown but not explained.",
  "agent.standing.mean":
    "mean T",
  "agent.standing.std":
    "std of T (tie-break 1)",
  "agent.standing.scoreLine":
    "score (Σ w·T / Σ w)",
  "agent.standing.worst":
    "worst epoch T (tie-break 2)",
  "agent.standing.byRegime": "by regime",
  "agent.standing.byEpoch":
    "by epoch",
  "agent.standing.col.regime": "regime",
  "agent.standing.col.scenario":
    "scenario",
  "agent.standing.col.rounds":
    "epochs",
  "agent.standing.col.mean":
    "mean T",
  "agent.standing.col.std":
    "std of T",
  "agent.standing.bankrupt":
    "Ended {n} scenarios with an asset value at or below zero (bankrupt, rules §4.5 — no floor, the negative value counts): {list}",
  "agent.standing.bankruptOne":
    "Ended 1 scenario with an asset value at or below zero (bankrupt, rules §4.5 — no floor, the negative value counts): {list}",
  "agent.histogram.clipped":
    "0 · {n} epochs past the edge, stacked into the end bins",
  "agent.histogram.clippedOne":
    "0 · 1 epoch past the edge, stacked into the end bin",
  "agent.openPositions": "Open positions",
  "agent.positions.empty":
    "no venue position open at the final block — this agent ended flat, or the run predates per-venue position tracking",
  "agent.positions.col.venue": "Venue",
  "agent.positions.col.kind": "Kind",
  "agent.positions.col.size": "Size",
  "agent.positions.col.mark": "Mark",
  "agent.positions.col.detail": "Detail",
  "agent.noValueSeries":
    "no value series yet for this agent — the curve is built from scoring snapshots, which land when the run finishes",
  "agent.decisionLive": "Decision log — live ↓",
  // ADR 0021 §2/§4. Said, not shown as an empty panel: an empty log reads as "this agent thought
  // nothing", which is a different and wrong claim.
  "agent.selfHosted": "Self-hosted participant",
  "agent.selfHostedLog":
    "This participant runs their agent on their own machine, so its decision log is on that machine and never reaches here. What this page shows about them comes from the chain: their transactions, their positions, and their score.",
  "agent.noRounds":
    "no scored rounds yet — the per-round series is built when the run finishes",
  "agent.roundsNote":
    "A round is an evaluation interval — the leaderboard's running progress inside an epoch. Log return is the raw change of this agent's account value over the round. The score is one number for the whole epoch (P = V_K − V_0, standardised over the field), not a function of these rounds.",
  "agent.portfolio": "Portfolio value",
  "agent.portfolioRange": "Portfolio value · {from} → {to}",
  "agent.yLabel": "account value (USDC)",
  "agent.xLabel": "block",
  "agent.lineLabel": "total account value",
  "agent.trades.col.hash": "Tx hash",
  "agent.trades.col.block": "Block",
  "agent.trades.col.method": "Method",
  "agent.trades.col.amount": "Amount",
  "agent.trades.col.time": "Time",
  "agent.openTx": "Open transaction in Blockscout",
  "agent.openAddress": "Open address in Blockscout",

  // ---- markets page ----
  "market.fair": "Reference price · what the environment publishes",
  "market.venuesInRun": "Venues in this run",
  "market.notRecorded": "not recorded",
  "market.scope": "Scope",
  "market.wholeRun": "whole run · blocks {from}–{to}",
  "market.runWide":
    "Whole run · blocks {from}–{to}. This tab is not narrowed by the round you pick: its tables are a single snapshot taken at the run's last block.",
  "market.roundScope": "Round {i} · blocks {from}–{to}",
  "market.scopeHint":
    "Pick a round in the bar above and every panel below narrows to that round's blocks.",
  "market.backToRun": "show the whole run →",
  "market.view.arb": "Cross-venue arb",
  "market.view.price": "Fair price",
  "market.arbLegend":
    "▲ = a buy, ▼ = a sell, coloured by venue. The dashed line is the reference price. The lower pane plots the widest gap between venues against the {n}bps round-trip cost: above that line there was arbitrage to take.",
  "market.noVenue":
    "This run had no venue with a panel on this page. Nothing is missing — it enabled none of them.",
  "market.standings": "Standings",
  "market.submissions": "Agent submissions ↓",
  // ADR 0021 §4: this feed comes from the agents' own reports of what they sent, which is the one
  // thing a self-hosted participant files nowhere but their own disk. Their *included* transactions
  // are on the chain and appear in the explorer; what is not visible is what they sent and lost.
  "market.submissionsSelfHosted":
    "{count} self-hosted participant(s) are not in this list — it is built from what agents report sending, and theirs is reported on their own machines. Their included transactions are in the explorer.",
  "market.noSubmissions": "no agent submitted a transaction in this run",
  "market.sell": "sell",
  "market.buy": "buy",

  // ---- explorer page ----
  "explorer.title": "Explorer",
  "explorer.connected": "Blockscout connected",
  "explorer.indexed": "indexed block {n}",
  "explorer.indexedPct": " · {p}% indexed",
  "explorer.offline":
    "Blockscout is not running — start it with `npm run explorer` to open transactions, blocks and addresses here (after a chain reset: `npm run explorer:reset`)",
  "explorer.probing": "probing the local explorer…",
  "explorer.notIndexed":
    "this run's transactions are not indexed — the explorer holds a different chain; run `npm run explorer:reset`",
  "explorer.behind": "{n} blocks behind the chain",
  "explorer.search": "Search tx hash / block / agent / wallet address…",
  "explorer.hint.tx": "transaction hash",
  "explorer.hint.address": "wallet address",
  "explorer.hint.block": "block number",
  "explorer.hint.agent": "agent → wallet address",
  "explorer.hint.unknown": "no exact match — filtering the lists below",
  "explorer.open": "open in Blockscout ↗ (enter)",
  "explorer.localOnly": "explorer offline — showing local matches only",
  "explorer.wholeRun": "Whole run ({n} rounds)",
  "explorer.roundOption": "Round {i} · blk {from}–{to}",
  "explorer.scopeBlocks": "blocks {from}–{to}",
  "explorer.scopeRound": "round {i} · blocks {from}–{to}",
  "explorer.stat.scenario": "Scenario",
  "explorer.stat.latest": "Latest block",
  "explorer.stat.indexed": "Indexed block",
  "explorer.stat.txRun": "Tx this run",
  "explorer.stat.txRound": "Tx this round",
  "explorer.stat.agents": "Active agents",
  "explorer.stat.blockTime": "Avg block time",
  "explorer.blocks": "Blocks",
  "explorer.transactions": "Transactions",
  "explorer.shown": "{n} shown",
  "explorer.noBlocks": "no block in this scope matches",
  "explorer.noTx": "no transaction in this scope matches",
  "explorer.openBlock": "Open block in Blockscout",
  "explorer.startToOpen": "start `npm run explorer` to open blocks",

  // ---- event tape (scenario page ticker) ----
  "tape.kind.run": "RUN",
  "tape.kind.scenario": "SCENARIO",
  "tape.kind.victimHf": "VICTIM HF",
  "tape.kind.liquidation": "LIQUIDATION",
  "tape.kind.liquidity": "LIQUIDITY",
  "tape.kind.depeg": "DEPEG",
  "tape.kind.lstSlash": "LST SLASH",
  "tape.kind.trove": "TROVE",
  "tape.kind.redemption": "REDEMPTION",
  "tape.kind.arbWindow": "ARB WINDOW",
  "tape.runStarted": "run started · {protocols}",
  "tape.blocksN": "{n} blocks",
  "tape.schedule": "stress schedule: {types}",
  "tape.eventsN": "{n} events",
  "tape.victimHf": "victim health factors at blk {block}",
  "tape.liquidation": "liquidation at blk {block}",
  "tape.liquidityPull": "{venue} {market} depth {direction}",
  "tape.liquidityRestored": "{venue} depth restored",
  "tape.eusdDepeg": "eUSD pool sell-off (blk {block})",
  "tape.depeg": "{stable} pool sell-off (blk {block})",
  "tape.lstSlash": "LST redemption rate cut {before} → {after}",
  "tape.trove": "trove liquidated ({borrower})",
  "tape.redemption": "eUSD redeemed for ETH (blk {block})",
  "tape.arbWindow": "{base} {buy}→{sell} gap open",
  "tape.runCompleted": "run finished, scores reconstructed",

  // ---- venue panels (markets tabs) ----
  "vp.amm.label": "AMM",
  "vp.amm.caption":
    "Three AMMs quote the same pair independently, so one asset has three prices at once. Two things to read. Depth is how much a pool holds: a liquidity pull takes it away, and a thinner pool moves further on the same trade. The gap between venues is the arbitrage — but only once it clears the round-trip cost of both swaps.",
  "vp.amm.widestGap": "Widest cross-venue gap",
  "vp.amm.threshold": "threshold {n}bps round-trip",
  "vp.amm.aboveThreshold": "Blocks above threshold",
  "vp.amm.poolDepth": "Pool depth (all venues)",
  "vp.amm.start": "start {v}",
  "vp.amm.swapVolume": "Swap volume · {base}",
  "vp.amm.swapsN": "{n} swaps",
  "vp.amm.depthChart": "Pool depth · {base}",
  "vp.amm.quotesTitle": "Executable quotes at the final block · {base}",
  "vp.col.venue": "Venue",
  "vp.col.mid": "Mid",
  "vp.col.sell": "Sell",
  "vp.col.buy": "Buy",
  "vp.col.depth": "Depth",
  "vp.amm.quotesEmpty": "no venue quotes recorded in this run",
  "vp.amm.note": "per-venue depth appears once the run finishes",
  "vp.amm.sampledNote":
    "Venue series sampled at each round boundary ({n} points, every {every} blocks) while the run was going. Per-transaction volume and the trade markers need the post-run sweep, which a period's closed day does not get.",
  "vp.amm.swapsTitle": "Agent swaps · {base}",
  "vp.col.block": "Block",
  "vp.col.agent": "Agent",
  "vp.col.side": "Side",
  "vp.col.size": "Size",
  "vp.col.price": "Price",
  "vp.amm.swapsEmpty":
    "no agent swap in this asset was decoded — either nobody traded it, or the run predates per-venue tracking",
  "vp.side.buy": "BUY",
  "vp.side.sell": "SELL",

  "vp.perp.label": "Perp",
  "vp.perp.caption":
    "GMX v2. A position is submitted as an order and executed by the environment's keeper on the next block, so a perp trade always lands one block after the decision behind it. Funding is paid by whichever side is crowded to the other: the rate follows the open-interest skew above, and over a run of a few hundred blocks the amount it moves is small.",
  "vp.perp.oi": "Open interest",
  "vp.perp.oiSplit": "{long}% long / {short}% short",
  "vp.perp.noOi": "no open interest",
  "vp.perp.longOi": "Long OI",
  "vp.perp.shortOi": "Short OI",
  "vp.perp.funding": "Funding / 1h",
  "vp.perp.fundingSub": "positive = longs pay shorts, negative = the reverse",
  "vp.perp.oiChart": "Open interest · {base}",
  "vp.perp.long": "Long",
  "vp.perp.short": "Short",
  "vp.perp.fundingChart": "Funding rate per hour",
  "vp.perp.balanced": "balanced",
  "vp.perp.positionsTitle": "Positions open at the run's final block",
  "vp.col.collateral": "Collateral",
  "vp.col.entry": "Entry",
  "vp.col.pnl": "PnL",
  "vp.perp.positionsEmpty": "no perp position was open when the run ended",
  "vp.perp.keeperFailures": "Keeper failures",
  "vp.perp.keeperSub": "orders the environment's keeper could not execute",
  "vp.perp.noState": "no GMX state recorded for {base} in this run",
  "vp.perp.note": "GMX state appears once the run finishes",
  "vp.side.long": "LONG",
  "vp.side.short": "SHORT",

  "vp.lending.label": "Lending",
  "vp.lending.caption":
    "Aave v3. The oracle that prices collateral is written by the environment and lands one block late. So the health factor an agent reads is always one block behind the price that will break it: a position that still looks safe on screen can already be liquidatable on chain.",
  "vp.lending.supplied": "Total supplied",
  "vp.lending.borrowed": "Total borrowed",
  "vp.lending.utilization": "utilization {v}",
  "vp.lending.borrowedChart": "Borrowed by reserve",
  "vp.lending.utilizationChart": "Utilization by reserve",
  "vp.lending.reservesTitle": "Reserves at the run's final block",
  "vp.col.asset": "Asset",
  "vp.col.suppliedCol": "Supplied",
  "vp.col.borrowedCol": "Borrowed",
  "vp.col.utilizationCol": "Utilization",
  "vp.lending.reservesEmpty": "no reserve totals recorded in this run",
  "vp.lending.worstHf": "Worst victim health factor",
  "vp.lending.liquidatable": "liquidatable",
  "vp.lending.aboveLine": "above the liquidation line",
  "vp.lending.victimChart": "Seeded victim health factor (worst)",
  "vp.lending.minHf": "Min HF",
  "vp.lending.liquidationLine": "liquidation",
  "vp.lending.liquidations": "Liquidations",
  "vp.col.victim": "Victim",
  "vp.col.healthFactor": "Health factor",
  "vp.col.remainingDebt": "Remaining debt",
  "vp.lending.liquidationsEmpty": "no victim was liquidated in this run",
  "vp.lending.accountsTitle": "Agent accounts at the run's final block",
  "vp.col.debt": "Debt",
  "vp.lending.accountsEmpty":
    "no agent held an Aave position when the run ended",
  "vp.lending.noState": "no Aave reserve state recorded in this run",
  "vp.lending.note": "Aave state appears once the run finishes",

  "vp.stable.label": "Stablecoin",
  "vp.stable.caption":
    "Stablecoin prices here are measured, not assumed. The mark is the geometric mean of both executable directions on the coin's own pool, so a coin off its peg reads as off its peg. eUSD is the one with a floor under it: it can always be redeemed for $1 of collateral from the riskiest trove, which makes its discount a claim you can exercise rather than a forecast.",
  "vp.stable.price": "{symbol} price",
  "vp.stable.deepest": "deepest {v} · {bps} vs par",
  "vp.stable.noQuote": "pool would not quote — par assumed",
  "vp.stable.tcr": "System TCR",
  "vp.stable.recovery": "RECOVERY MODE",
  "vp.stable.aboveCcr": "above CCR (1.5)",
  "vp.stable.troves": "Troves open",
  "vp.stable.riskiest": "riskiest ICR {v}",
  "vp.stable.debt": "eUSD debt",
  "vp.stable.spSub": "stability pool {v} eUSD",
  "vp.stable.redemptionFee": "Redemption fee",
  "vp.stable.borrowingSub": "borrowing {v}bps",
  "vp.stable.eusdPrice": "eUSD price",
  "vp.stable.eusdVenueRead": "eUSD (venue read)",
  "vp.stable.tcrChart": "System collateral ratio",
  "vp.stable.ccrLine": "CCR — recovery mode",
  "vp.stable.feesChart": "Redemption / borrowing fee",
  "vp.stable.redemptionLine": "Redemption",
  "vp.stable.borrowingLine": "Borrowing",
  "vp.stable.redemptionsTitle": "Redemptions",
  "vp.col.eusdRedeemed": "eUSD redeemed",
  "vp.col.ethOut": "ETH out",
  "vp.col.ethFee": "ETH fee",
  "vp.stable.redemptionsEmpty":
    "nobody redeemed eUSD in this run — the discount never cleared the redemption fee, or nobody tried",
  "vp.stable.troveLiqTitle": "Trove liquidations",
  "vp.col.borrower": "Borrower",
  "vp.col.mode": "Mode",
  "vp.stable.modeRecovery": "recovery",
  "vp.stable.modeNormal": "normal",
  "vp.stable.troveLiqEmpty": "no trove was liquidated",
  "vp.stable.priceChart": "Stablecoin price against USDC",
  "vp.stable.parLine": "par",
  "vp.stable.depegPressure": "Depeg pressure",
  "vp.stable.depegSub": "{n} blocks of environment selling",
  "vp.stable.depegTitle": "Depeg windows (environment selling)",
  "vp.col.stable": "Stable",
  "vp.col.targetShare": "Target share of depth",
  "vp.col.sold": "Sold",
  "vp.stable.depegEmpty": "the environment never leaned on a peg in this run",
  "vp.stable.note": "no stablecoin market in this run",

  "vp.lst.label": "LST",
  "vp.lst.caption":
    "A non-rebasing liquid staking token carries two prices for one asset. One is the redemption rate the vault owes you, which sits behind a withdrawal queue. The other is what its secondary pool will pay right now. The gap between them is only profit if you can afford to wait out the queue.",
  "vp.lst.rate": "Redemption rate",
  "vp.lst.rateSub": "what the vault owes per LST — the par",
  "vp.lst.market": "Market price",
  "vp.lst.marketSub": "what the pool pays right now",
  "vp.lst.discount": "Discount",
  "vp.lst.discountSub":
    "market below par; the exit queue is why it can persist",
  "vp.lst.queue": "Exit queue",
  "vp.lst.queueSub": "withdrawal delay {n} blocks",
  "vp.lst.reserve": "Reward reserve",
  "vp.lst.reserveEmpty": "exhausted — yield has stopped",
  "vp.lst.apy": "APY {v}%",
  "vp.lst.rateChart": "Redemption rate vs market price",
  "vp.lst.rateLine": "Redemption rate (par)",
  "vp.lst.marketLine": "Market price",
  "vp.lst.discountChart": "Discount to par",
  "vp.lst.discountLine": "Discount",
  "vp.lst.queueChart": "Exit queue length",
  "vp.lst.queueLine": "Queued exits",
  "vp.lst.slashes": "Slashes",
  "vp.lst.slashesSub": "permanent cuts to the redemption rate",
  "vp.lst.slashTitle": "Slash events",
  "vp.col.rateBefore": "Rate before",
  "vp.col.rateAfter": "Rate after",
  "vp.col.cut": "Cut",
  "vp.col.discountAfter": "Discount after",
  "vp.lst.slashEmpty": "the vault was never slashed in this run",
  "vp.lst.apyTitle": "Yield changes",
  "vp.col.apy": "APY",
  "vp.lst.apyEmpty": "the yield was fixed for the whole run",
  "vp.lst.note": "no LST state was recorded in this run",

  "vp.scenario.label": "Scenario",
  "vp.scenario.caption":
    "What the environment did to this run. Its schedule is drawn from the seed before the first block: each episode is a trapezoid — it ramps up, holds, then decays — laid over the fair-price walk. The draw is random but reproducible, so the same seed always replays the same windows. This tab covers the whole run rather than the round you picked, because a scenario is a property of the run.",
  "vp.scenario.seed": "Seed",
  "vp.scenario.seedSub":
    "flow seed {flow} · the label for this run's market conditions",
  "vp.scenario.scheduled": "Scheduled events",
  "vp.scenario.scheduledNone":
    "none — the fair-price walk was the only thing moving",
  "vp.scenario.window": "Run window",
  "vp.scenario.windowSub": "{blocks} blocks · {rounds} rounds",
  "vp.scenario.scheduleTitle":
    "Stress schedule (drawn from the seed at run start)",
  "vp.col.event": "Event",
  "vp.col.windowShape": "Window · ramp/hold/decay",
  "vp.col.rounds": "Rounds",
  "vp.col.mag": "Mag",
  "vp.col.outcome": "Outcome",
  "vp.scenario.scheduleEmpty":
    "no stress event was scheduled — this run is the fair-price walk and the order flow, nothing else",
  "vp.scenario.neverFired": "never fired",
  "vp.scenario.failed": "failed",
  "vp.scenario.restored": "restored",
  "vp.scenario.leftInPlace": "left in place",
  "vp.scenario.firedBlocks": "{n} blk {from}–{to}",
  "vp.scenario.crash": "overlay on the fair price — see the price chart",
  "vp.scenario.cexDrift": "changes the price walk — see the price chart",
  "vp.scenario.flowTrend": "tilts the order flow — see the swap volume",
  "vp.scenario.venueEvents": "Venue events",
  "vp.scenario.venueEventsSub":
    "liquidations, redemptions, slashes and open arb windows",
  "vp.scenario.notableTitle": "What the venues did, in block order",
  "vp.col.round": "Round",
  "vp.col.detail": "Detail",
  "vp.scenario.notableEmpty":
    "nothing was liquidated, redeemed or slashed, and no arb window stayed open long enough to be reported",
  "vp.scenario.liquidation": "liquidation",
  "vp.scenario.liquidationText": "victim {victim} liquidated at HF {hf}",
  "vp.scenario.troveLiquidated": "trove liquidated",
  "vp.scenario.troveText": "{borrower} · {debt} eUSD",
  "vp.scenario.redemption": "redemption",
  "vp.scenario.redemptionText": "{eusd} eUSD redeemed for {eth} ETH",
  "vp.scenario.lstSlash": "lst slash",
  "vp.scenario.lstSlashText": "redemption rate {before} → {after}",
  "vp.scenario.arbWindow": "arb window",
  "vp.scenario.arbWindowText": "{base} {buy}→{sell} open at {bps}bps",

  // ---- agent positions (built in the data layer) ----
  "pos.kind.stake": "STAKE",
  "pos.kind.debt": "DEBT",
  "pos.kind.deposit": "DEPOSIT",
  "pos.kind.hold": "HOLD",
  "pos.kind.borrow": "BORROW",
  "pos.kind.supply": "SUPPLY",
  "pos.entry": "entry {v}",
  "pos.entryNone": "entry —",
  "pos.collateralNote": "collateral {v}",
  "pos.par": "par {v} WETH",
  "pos.queue": "queue: {claimable} claimable, {pending} pending ({n} requests)",
  "pos.queueOne": "queue: {claimable} claimable, {pending} pending (1 request)",
  "pos.noQueue": "nothing queued for withdrawal",
  "pos.troveNote": "{coll} WETH collateral · MCR 1.100",
  "pos.icrNone": "ICR —",
  "pos.spMark": "absorbs liquidated debt",
  "pos.spNote": "paid in discounted collateral when a Trove is liquidated",
  "pos.eusdSpot": "eUSD (spot)",
  "pos.eusdNote": "redeemable against the riskiest Trove at par",
  "pos.aave": "Aave account",
  "pos.debtNote": "debt {v}",
  "pos.noDebt": "no debt drawn",

  // ---- errors ----
  "err.noRuns":
    "no runs found under runs/ — finish one `npm run sim:realtime` first",

  // ---- the public view (server/runsApi.ts audience mode) and the trial environment ----
  // What is absent is said, because an empty panel makes a claim of its own: an empty decision log
  // says the agent never thought, an empty schedule says nothing was planned.
  "mode.audienceBadge": "public view",
  "mode.audienceNote":
    "Public view. While the competition runs, each epoch's scenario, the environment episodes still to come, the agents' decision logs and their pending bids are withheld (rules §3.3, §2.6). They are published with the results (rules §7.2).",
  "home.progress": "{done} of {planned} epochs complete",
  "home.progressRunning": "next epoch running",
  "home.progressPreparing":
    "The competition has started and its first epoch is running. Standings appear once it completes.",
  "home.standingsOff":
    "Standings are not posted in this environment (rules §4.7: the trial environment posts no standings). Scenarios, markets and the explorer stay available.",
  "home.col.flags": "notes",
  "home.flagsTitle":
    "Recorded facts, not penalties (rules §4.4.2 — a stopped agent is scored on what it left behind): {flags}",
  "home.search": "filter by agent or participant…",
  "home.showMore": "show all {n} rows",
  "home.showLess": "show the top {n}",
  "home.view.agents": "agents",
  "home.view.participants": "participant units",
  "home.participantsNote":
    "Rules §2.2: a participant unit may enter up to two submissions and its final score is the higher of the two. Each row names the agent that counted.",
  "home.col.participant": "participant unit",
  "home.col.countedAgent": "counted agent",
  "home.col.agents": "agents",
  "home.scenarios.audienceEvents":
    "Public view: only episodes that have already opened are listed; upcoming windows are withheld while the competition runs.",
  "scenario.hidden": "epoch {s}",
  "home.scenarios.eventsWithheld": "withheld while the competition runs",
  "agent.audienceLog": "Not shown while the competition runs",
  "agent.audienceLogNote":
    "The decision log is the participant's own reasoning, and its mempool self-reports are bids not yet included in a block (rules §2.6). Both stay unpublished until the results (rules §7.2).",
  "agent.flags": "Recorded facts (rules §4.4.2; no score penalty)",
  "market.submissionsAudience":
    "Pending bids are not shown while the competition runs (rules §2.6: inclusion is a priority-fee auction).",
  "market.standingsOff": "not posted in this environment (rules §4.7)",
  "live.noChainReads":
    "Block heights come from the environment's log; the public view does not read the chain directly.",
  // ---- the standings as a live leaderboard: status line, score-by-epoch chart, form, pin ----
  "home.status.epochs": "{done} of {planned} epochs scored",
  "home.status.epochsAll": "{n} epochs scored",
  "home.status.updated": "updated {time}",
  "home.status.next": "next epoch starts {time}",
  "home.status.live": "an epoch is running now",
  "home.chart.title": "Score by epoch",
  "home.chart.subtitle":
    "Cumulative score after each completed epoch — the same number as the table, replayed epoch by epoch. The top {n} are drawn in colour, the rest in grey; 50 is the field's average. Click a name to follow it.",
  "home.chart.mean": "field average",
  "home.chart.empty": "The chart appears once two epochs have been scored.",
  "home.chart.legend": "top {n}",
  "home.col.delta": "Δ",
  "home.deltaTitle": "Rank change since the previous completed epoch",
  "home.col.form": "form",
  "home.formTitle": "T per epoch, oldest to newest — {n} scored, latest {latest}",
  "home.col.txs": "txs",
  "home.col.reverts": "reverted",
  "home.txsTitle": "Transactions included across the scored scenarios, and how many reverted",
  "home.details": "details",
  "home.pin": "follow",
  "home.unpin": "unfollow",
  "home.pinTitle": "Highlight this agent in the table and the chart on this browser",
  "home.pinned": "following",
  "home.about": "About this competition",
  "home.aboutHint":
    "How the units nest, what the environment does, how the score is computed, where the data comes from.",
} as const;

export type MessageKey = keyof typeof en;

const ja: Record<MessageKey, string> = {
  "common.loading": "読み込み中…",
  "common.loadFailed": "run データを読み込めませんでした{detail}",
  "common.finished": "終了",
  "common.live": "ライブ",
  "common.seeAll": "すべて見る →",

  "nav.standings": "順位表",
  "nav.scenario": "シナリオ",
  "nav.markets": "マーケット",
  "nav.explorer": "エクスプローラ",
  "nav.top": "トップ",
  "sidebar.competition": "競技",
  "sidebar.scenario": "シナリオ",
  "sidebar.scenarioLive": "シナリオ · ライブ",
  "sidebar.singleRun": "— 単発 run —",
  "sidebar.world": "見ている世界",
  "sidebar.worldOf": "{n} 世界中 {i} 番目",
  "sidebar.worldRounds": "{n} ラウンド",
  "sidebar.worldLeader": "首位 {id}",
  "sidebar.worldEvents": "イベント: {list}",
  "sidebar.worldNoEvents": "イベントの予定なし",
  "sidebar.change": "変更",
  "sidebar.close": "閉じる",
  "sidebar.readOnly": "閲覧専用ビュー",
  "sidebar.noSignIn": "ログイン不要",

  "cursor.final": "最終 · 全 {n} ラウンド",
  "cursor.at": "ラウンド {at} / {max}",
  "cursor.play": "▶ 再生",
  "cursor.pause": "❚❚ 一時停止",
  "cursor.jumpFinal": "最終結果へ →",
  "cursor.complete": "{n} シナリオ · 終了",
  "cursor.completeOne": "1 シナリオ · 終了",
  "cursor.running": "{total} 中 {running} が進行中 · {ended} は先に終了",
  "cursor.atRound": "{n} シナリオ · ラウンド {at}",
  "cursor.atRoundOne": "1 シナリオ · ラウンド {at}",

  "home.stat.scenarios": "シナリオ",
  "home.stat.regimes": "レジーム",
  "home.stat.agents": "エージェント",
  "home.stat.rounds": "ラウンド",
  "home.stat.recorded": "実施日",
  "home.roundsFinal": "{n} · 最終",
  "home.roundsAt": "{at} / {n}",
  "home.missingRounds":
    "{total} 本中 {missing} 本のシナリオ run が未回収です。順位には含まれますが、ラウンド詳細は表示できません。",
  "home.practiceBadge": "練習",
  "home.practiceNote":
    "これは練習順位で、公式採点ではありません。公式競技は提出バンドルをシナリオ行列で再生して別途採点され、ここの結果は一切反映されません。",
  "home.standingsFinal": "順位表 · 最終",
  "home.standingsThrough": "順位表 · ラウンド {at} 時点",
  "home.subtitle":
    "スコア: 各エポック（1 シナリオの run）で、エポック中の USDC 損益 P から偏差値 T = 50 + 10 × (P − μ) / σ を全員横断で出し（μ・σ は場全体）、T をエポック通しで平均した値（後のエポックほど重みが大きく、最大 1.5 倍）。レジーム列はそのレジームでの T の平均。行をクリックするとエポックごとの内訳が見られます。",
  "home.col.move": "変動",
  "home.col.agent": "エージェント",
  "home.col.score":
    "スコア",
  "home.col.netPnl": "純損益",
  "home.scoreTitle":
    "採点エポック {n} · タイブレーク: T の標準偏差 {std}、最悪エポックの T {worst}",
  "home.netPnlTitle": "USDC 建て。両端とも run の最終価格で評価",
  "home.netPnlScrub": "最終値 — 純損益は run 終了時にのみ定義されます",
  "home.noteOpens": "{types} の窓が {n} シナリオで開始",
  "home.noteOpensOne": "{types} の窓が 1 シナリオで開始",
  "home.noteOpen": "{n} 個の窓が継続中",
  "home.noteOpenOne": "1 個の窓が継続中",
  "home.noteNoMove": "順位変動なし",
  "home.noteMoved": "{n} 体の順位が変動",
  "home.noteMovedOne": "1 体の順位が変動",

  "home.scenarios.title": "シナリオ",
  "home.scenarios.subtitle":
    "1 行 1 世界。レジームとシードの組、その世界の首位、環境がそこで起こす予定のイベントを並べています。行をクリックすると開きます。1 つのシナリオは分布からの 1 ドローであって結果ではありません — 結果は上の順位表です。",
  "home.scenarios.col.scenario": "シナリオ",
  "home.scenarios.col.rounds": "ラウンド",
  "home.scenarios.col.leader": "首位",
  "home.scenarios.col.events": "環境イベント",
  "home.scenarios.eventsTitle":
    "シードから引かれた時限イベントです。「予定なし」は世界が静かだったという意味ではありません。cex-drift のようなレジームは、窓を開けずに run 全体を形づくることがあります。",
  "home.scenarios.roundsAt": "{at} / {n}",
  "home.scenarios.ended": "終了",
  "home.scenarios.endedTitle":
    "カーソルより前にラウンドが尽きた世界です。最後の値がその世界の結果なので、順位表には残ります。",
  "home.scenarios.noEvents": "予定なし",
  "home.scenarios.noLeader": "結果はまだありません",
  "home.scenarios.missing": "このシナリオのラウンド詳細は回収されていません",
  "home.scenarios.leaderTitle":
    "選択中のラウンドまでの首位。P = V_k − V_0（USDC）で判定 — このエポックの偏差値が取られる量",

  "units.title": "単位の関係",
  "units.competition": "競技",
  "units.competitionBody": "全シナリオを再生して一緒に順位を付けたもの。このページです。",
  "units.scenario": "シナリオ",
  "units.scenarioBody":
    "1 つの世界。レジームとシードの組を最初から最後まで走らせたもので、全エージェントが同時に取引します。",
  "units.round": "ラウンド",
  "units.roundBody":
    "採点の窓で、1 ブロックではなく複数ブロックです。スコアも順位変動も環境イベントも、すべてこの軸で読みます。",
  "units.block": "ブロック",
  "units.blockBody":
    "2 秒であり、1 回の行動機会です。同じブロック内の順序は優先手数料で決まります。",

  "scenario.fallbackTitle": "シナリオ",
  "scenario.seed": "シード {n}",
  "scenario.roundsBlocks": "{rounds} ラウンド × {blocks} ブロック",
  "scenario.heroMeta": "{agents} エージェント · ブロック {block}",
  "scenario.markets": "マーケット",
  "scenario.standings": "シナリオ内順位",
  "scenario.explorer": "エクスプローラ",
  "scenario.info.overview.label": "概要",
  "scenario.info.environment.label": "環境",
  "scenario.info.scoring.label": "採点",
  "scenario.info.artifacts.label": "データ",
  "scenario.info.overview.p1":
    "Eris は DeFi トレード競技のシミュレータです。自律エージェントが複数プロトコルの venue 群 — Uniswap v3・Balancer・Curve・GMX v2・Aave v3、加えてオプションの LST・CDP ステーブルコイン venue — で競います。全 venue はローカルの anvil チェーン上にデプロイされます。",
  "scenario.info.overview.p2":
    "エージェントは完全に独立したプロセスとして動き、確定済みのオンチェーン状態だけを見ます。特権 RPC も、ペンディング tx も、他エージェントの注文も見えません。毎ブロック、観測・判断・署名を自分で行い、ブロック内の順序は priority fee 順 — 優先度は入札で買うものです。",
  "scenario.info.overview.p3":
    "環境デーモンが市場を動かします: シードから導かれるフェア価格を毎ブロックオンチェーンに書き込み、無情報・有情報のオーダーフロー、perp のキーパー、そして暴落・流動性引き抜き・ステーブルのデペグ・大口注文といったストレスイベントをスケジュールします。エージェントはこれらから逃れられません。",
  "scenario.info.overview.p4":
    "自己改善型エージェントは、ルール戦略と、run 中に戦略コードを書き換える LLM の組み合わせです。LLM は取引経路には入りません: ルールが毎ブロック自力で取引し、改訂は静的検査・コンパイル・サンドボックス実行を通ってはじめて反映されます。",
  "scenario.info.environment.p1":
    "シードは市場条件のラベルです。フェア価格の経路は (レジーム, シード) ごとに再現可能ですが、tx のタイミングと着順は再現されません — 同じシナリオを 2 回再生しても約定は変わります。だから競技は多数のシナリオで測ります。",
  "scenario.info.environment.p2":
    "公式レジーム: calm・cex-drift・informed-flow・whale・lending-incident・crash・depeg。シナリオは 1 つの (レジーム, シード) の組で、競技はそのセット全体を再生してレジームごとに順位を付けます。",
  "scenario.info.environment.p3":
    "ストレスイベントは、フェア価格に重ねるランダム化された決定論オーバーレイ（ramp・hold・decay）、全 AMM プールを同時に薄くする流動性引き抜き、環境がステーブルのプールを窓の間だけ売り続けるデペグです。シード由来の victim ポジションがあるため、健全性係数を見ているエージェントには清算機会が届きます。",
  "scenario.info.environment.p4":
    "フェア価格はオンチェーンの価格フィードで配布され、全員に等しく 1 ブロック遅れて届きます — 情報が生まれた 1 ブロック後に反応することはゲームの一部です。",
  "scenario.info.scoring.p1":
    "採点は run の最中ではなく終了後に行われます。環境が過去のチェーン状態を遡り、全エージェントを同一ブロック断面で評価するので、実行ループは採点コストを払わず、スナップショット時刻を狙った操作もできません。",
  "scenario.info.scoring.p2":
    "スコアは 1 エポックにつき 1 つの数字です。P = V_K − V_0（run 全体での総資産価値の変化。両端ともその時点の 5 ブロック中央値マーク）を、場全体で T = 50 + 10 (P − μ) / σ に標準化します。ベンチマークは評価されますが母集団には入りません。",
  "scenario.info.scoring.p3":
    "純損益と最大ドローダウンは同じ再構成系列から出す参考値です。run 内のラウンドはリーダーボードの途中経過であって、スコアの一部ではありません。",
  "scenario.info.scoring.p4":
    "採点者が値付けできない保有は必ず報告され、黙って 0 になることはありません — 読み取り失敗の 0 は取引の損失と見分けが付かなくなるからです。",
  "scenario.info.artifacts.p1":
    "このページ群の全てが run 自身の記録ファイルから導かれます: 順位とラウンド別スコア、再構成された観測とイベント列、全トランザクション、各エージェント自身の判断ログ、そして venue 別の市場系列です。",
  "scenario.info.artifacts.p2":
    "真実の出典はチェーンです: 数値系列はすべて run 終了後にオンチェーン読み取りから再構成されます。ログが与えるのは理由・意図・帰属だけです。",
  "scenario.info.artifacts.p3":
    "run の進行中はログファイルを tail し、チェーンを RPC で読みます — 価格・ブロック・イベントテープ・判断ログはその場で更新されます。スコアと venue 別系列は run 終了と同時に現れます。",
  "scenario.info.artifacts.p4":
    "ローカルの Blockscout エクスプローラ（npm run explorer）が深掘り用ツールです。起動していれば、ページ上の全トランザクション・アドレス・ブロックがリンクになります。",

  "rounds.segmentTitle": "ラウンド {i} · ブロック {from}–{to} · {tx}",
  "rounds.txOutside": "ライブ表示の範囲外（tx 数は不明）",
  "rounds.txN": "{n} tx",
  "rounds.heading": "ラウンド {i}",
  "rounds.blocks": "ブロック {from}–{to}",
  "rounds.openExplorer": "エクスプローラで開く →",
  "rounds.close": "閉じる ✕",
  "rounds.notScored":
    "このラウンドは採点されていません — この run にはラウンド系列がありません",
  "rounds.scoredLater":
    "採点は run 終了後 — 結果はチェーン履歴から再構成されます",
  "rounds.col.agent": "エージェント",
  "rounds.col.delta": "Δ資産",
  "rounds.col.logReturn": "対数リターン",
  "rounds.col.rank": "順位",
  "rounds.bankrupt":
    "資産価値がゼロ以下（破産。床処理も凍結も無し）",
  "rounds.deltaNote":
    "Δ資産は市場エクスポージャー込みの生の資産変化で、何もしないエージェントでも価格と一緒に動きます。対数リターンは同じラウンドを「何もしない」ベースライン超過で測ったもので、スコアが平均するのはこちらの系列です。順位は初回ラウンドからの累積、矢印はこのラウンドでの変動です。",
  "rounds.envDid": "環境が行ったこと",
  "rounds.replayStart": "▶ リプレイ",
  "rounds.replayStartTitle": "最初のブロックからこの run を再生する",
  "rounds.replayExit": "終了",
  "rounds.blk": "blk {b} / {to}",
  "rounds.play": "再生",
  "rounds.pause": "一時停止",
  "rounds.playAgain": "もう一度再生",
  "rounds.replay": "リプレイ",
  "rounds.progress": "{done}/{total} ラウンド",
  "rounds.progressBlocks": "{done}/{total} ラウンド × {blocks} ブロック",
  "rounds.noRounds":
    "この run にはラウンドがありません — 1 採点ラウンド分に満たない長さです",
  "rounds.left": "残り {t}",
  "rounds.replayPct": "リプレイ {pct}%",

  "agent.tab.standing": "総合成績",
  "agent.tab.overview": "概要",
  "agent.tab.rounds": "ラウンド",
  "agent.tab.positions": "建玉",
  "agent.tab.trades": "取引履歴",
  "agent.tab.log": "判断ログ",
  "agent.back": "← 戻る",
  "agent.rank": "{n} 位",
  "agent.stat.score":
    "T（このエポック）",
  "agent.stat.pnl": "損益 (USDC)",
  "agent.stat.drawdown": "最大ドローダウン",
  "agent.standing.rank": "順位",
  "agent.standing.rankValue": "{n} 体中 {r} 位",
  "agent.standing.score":
    "スコア",
  "agent.standing.scoreTitle":
    "タイブレーク（§4.6）: T の標準偏差 {std}、最悪エポックの T {worst}",
  "agent.standing.netPnl": "純損益 (USDC)",
  "agent.standing.rounds":
    "採点エポック数",
  "agent.standing.explain":
    "このエージェントが採点された全エポックです。T はそのエポックの場の中での損益の位置（50 = 場の平均、±10 = 標準偏差 1 つ分）。スコアは T の加重平均なので、1 つのレジームで大勝ちして他で負ける戦略は、安定した戦略より下に来ることがあります。T の標準偏差は最初のタイブレークでもあります。",
  "agent.standing.noSeries":
    "このエージェントのラウンド詳細がありません — 競技のシナリオ run が未回収のため、順位は示せても説明はできません。",
  "agent.standing.mean":
    "T の平均",
  "agent.standing.std":
    "T の標準偏差（タイブレーク 1）",
  "agent.standing.scoreLine":
    "スコア（Σ w·T / Σ w）",
  "agent.standing.worst":
    "最悪エポックの T（タイブレーク 2）",
  "agent.standing.byRegime": "レジーム別",
  "agent.standing.byEpoch":
    "エポック別",
  "agent.standing.col.regime": "レジーム",
  "agent.standing.col.scenario":
    "シナリオ",
  "agent.standing.col.rounds":
    "エポック",
  "agent.standing.col.mean":
    "T の平均",
  "agent.standing.col.std":
    "T の標準偏差",
  "agent.standing.bankrupt":
    "{n} シナリオで資産価値がゼロ以下で終了（破産。規約 §4.5 により床処理なし、負の値がそのまま算入）: {list}",
  "agent.standing.bankruptOne":
    "1 シナリオで資産価値がゼロ以下で終了（破産。規約 §4.5 により床処理なし、負の値がそのまま算入）: {list}",
  "agent.histogram.clipped":
    "0 · {n} エポックが表示範囲外（両端のビンに積算）",
  "agent.histogram.clippedOne":
    "0 · 1 エポックが表示範囲外（端のビンに積算）",
  "agent.openPositions": "建玉",
  "agent.positions.empty":
    "最終ブロック時点で建玉なし — フラットで終えたか、venue 別記録が始まる前の run です",
  "agent.positions.col.venue": "Venue",
  "agent.positions.col.kind": "種別",
  "agent.positions.col.size": "サイズ",
  "agent.positions.col.mark": "マーク",
  "agent.positions.col.detail": "詳細",
  "agent.noValueSeries":
    "資産系列はまだありません — 曲線は採点スナップショットから作られ、run 終了時に届きます",
  "agent.decisionLive": "判断ログ — ライブ ↓",
  "agent.selfHosted": "自己ホスト参加者",
  "agent.selfHostedLog":
    "この参加者はエージェントを自分のマシンで動かしているため、判断ログはそちらにあり、ここには届きません。このページに出ているのはすべてチェーン由来です（取引・建玉・スコア）。",
  "agent.noRounds":
    "採点済みラウンドはまだありません — ラウンド系列は run 終了時に作られます",
  "agent.roundsNote":
    "ラウンドは評価区間で、エポック内でのリーダーボードの途中経過です。対数リターンはそのラウンドでのこのエージェントの総資産価値の変化そのものです。スコアはエポック全体で 1 つの数字（P = V_K − V_0 を場全体で標準化）で、ラウンドの関数ではありません。",
  "agent.portfolio": "資産推移",
  "agent.portfolioRange": "資産推移 · {from} → {to}",
  "agent.yLabel": "資産評価額 (USDC)",
  "agent.xLabel": "ブロック",
  "agent.lineLabel": "総資産価値",
  "agent.trades.col.hash": "Tx ハッシュ",
  "agent.trades.col.block": "ブロック",
  "agent.trades.col.method": "メソッド",
  "agent.trades.col.amount": "金額",
  "agent.trades.col.time": "時刻",
  "agent.openTx": "Blockscout でトランザクションを開く",
  "agent.openAddress": "Blockscout でアドレスを開く",

  "market.fair": "参照価格 · 環境が配信する基準価格",
  "market.venuesInRun": "この run の venue",
  "market.notRecorded": "記録なし",
  "market.scope": "範囲",
  "market.wholeRun": "run 全体 · ブロック {from}–{to}",
  "market.runWide":
    "run 全体 · ブロック {from}–{to}。このタブはラウンドで絞り込まれません。表が run の最終ブロック時点の 1 断面だからです。",
  "market.roundScope": "ラウンド {i} · ブロック {from}–{to}",
  "market.scopeHint":
    "上の帯でラウンドを選ぶと、下のパネルがすべてそのラウンドのブロックに絞られます。",
  "market.backToRun": "run 全体に戻す →",
  "market.view.arb": "venue 間裁定",
  "market.view.price": "フェア価格",
  "market.arbLegend":
    "▲ は買い、▼ は売りで、色は venue を表します。破線は参照価格です。下段は venue 間の最大価格差を往復コスト {n}bps と並べたもので、この線より上にある間は裁定の余地があったということです。",
  "market.noVenue":
    "この run には、このページにパネルを持つ venue が 1 つも有効になっていません。表示漏れではなく、そもそも使われていないということです。",
  "market.standings": "順位",
  "market.submissions": "エージェントの送信 tx ↓",
  "market.submissionsSelfHosted":
    "自己ホストの参加者 {count} 名はこの一覧に出ません — これは各エージェントの自己申告から作られており、彼らの申告はそれぞれのマシンにあります。ブロックに入った tx は explorer で見られます。",
  "market.noSubmissions":
    "この run でトランザクションを送ったエージェントはいません",
  "market.sell": "売",
  "market.buy": "買",

  "explorer.title": "エクスプローラ",
  "explorer.connected": "Blockscout 接続中",
  "explorer.indexed": "索引済みブロック {n}",
  "explorer.indexedPct": " · 索引 {p}%",
  "explorer.offline":
    "Blockscout が起動していません — `npm run explorer` で起動すると tx・ブロック・アドレスをここから開けます（チェーンをリセットした後は `npm run explorer:reset`）",
  "explorer.probing": "ローカルエクスプローラを確認中…",
  "explorer.notIndexed":
    "この run のトランザクションが索引されていません — エクスプローラが別のチェーンを保持しています。`npm run explorer:reset` を実行してください",
  "explorer.behind": "チェーンより {n} ブロック遅れ",
  "explorer.search": "tx ハッシュ / ブロック / エージェント / アドレスを検索…",
  "explorer.hint.tx": "トランザクションハッシュ",
  "explorer.hint.address": "ウォレットアドレス",
  "explorer.hint.block": "ブロック番号",
  "explorer.hint.agent": "エージェント → ウォレットアドレス",
  "explorer.hint.unknown": "完全一致なし — 下の一覧を絞り込み中",
  "explorer.open": "Blockscout で開く ↗ (Enter)",
  "explorer.localOnly": "エクスプローラ停止中 — ローカル一致のみ表示",
  "explorer.wholeRun": "run 全体（{n} ラウンド）",
  "explorer.roundOption": "ラウンド {i} · blk {from}–{to}",
  "explorer.scopeBlocks": "ブロック {from}–{to}",
  "explorer.scopeRound": "ラウンド {i} · ブロック {from}–{to}",
  "explorer.stat.scenario": "シナリオ",
  "explorer.stat.latest": "最新ブロック",
  "explorer.stat.indexed": "索引済みブロック",
  "explorer.stat.txRun": "この run の tx",
  "explorer.stat.txRound": "このラウンドの tx",
  "explorer.stat.agents": "稼働エージェント",
  "explorer.stat.blockTime": "平均ブロック時間",
  "explorer.blocks": "ブロック",
  "explorer.transactions": "トランザクション",
  "explorer.shown": "{n} 件表示",
  "explorer.noBlocks": "この範囲に一致するブロックはありません",
  "explorer.noTx": "この範囲に一致するトランザクションはありません",
  "explorer.openBlock": "Blockscout でブロックを開く",
  "explorer.startToOpen": "`npm run explorer` を起動するとブロックを開けます",

  "tape.kind.run": "RUN",
  "tape.kind.scenario": "シナリオ",
  "tape.kind.victimHf": "健全性",
  "tape.kind.liquidation": "清算",
  "tape.kind.liquidity": "流動性",
  "tape.kind.depeg": "デペグ",
  "tape.kind.lstSlash": "スラッシュ",
  "tape.kind.trove": "トローブ",
  "tape.kind.redemption": "償還",
  "tape.kind.arbWindow": "裁定窓",
  "tape.runStarted": "run 開始 · {protocols}",
  "tape.blocksN": "{n} ブロック",
  "tape.schedule": "ストレス予定: {types}",
  "tape.eventsN": "{n} 件",
  "tape.victimHf": "victim の健全性係数 (blk {block})",
  "tape.liquidation": "清算発生 (blk {block})",
  "tape.liquidityPull": "{venue} {market} の板が{direction}",
  "tape.liquidityRestored": "{venue} の板が回復",
  "tape.eusdDepeg": "eUSD プールへ売り圧 (blk {block})",
  "tape.depeg": "{stable} プールへ売り圧 (blk {block})",
  "tape.lstSlash": "LST 償還レート引き下げ {before} → {after}",
  "tape.trove": "トローブ清算 ({borrower})",
  "tape.redemption": "eUSD を ETH に償還 (blk {block})",
  "tape.arbWindow": "{base} {buy}→{sell} に差が発生",
  "tape.runCompleted": "run 終了、スコア再構成完了",

  "vp.amm.label": "AMM",
  "vp.amm.caption":
    "同じペアを 3 つの AMM が別々に値付けするので、1 つの資産に同時に 3 つの価格が付きます。読むところは 2 つです。深度はプールの厚みで、流動性引き抜きが減らします。薄いほど、同じ取引で価格が大きく動きます。venue 間の価格差は裁定の機会ですが、2 回のスワップの往復コストを超えて初めて利益になります。",
  "vp.amm.widestGap": "最大 venue 間価格差",
  "vp.amm.threshold": "しきい値 {n}bps（往復コスト）",
  "vp.amm.aboveThreshold": "しきい値超えブロック数",
  "vp.amm.poolDepth": "プール深度（全 venue）",
  "vp.amm.start": "開始時 {v}",
  "vp.amm.swapVolume": "スワップ出来高 · {base}",
  "vp.amm.swapsN": "{n} スワップ",
  "vp.amm.depthChart": "プール深度 · {base}",
  "vp.amm.quotesTitle": "最終ブロックの実行可能クォート · {base}",
  "vp.col.venue": "Venue",
  "vp.col.mid": "中値",
  "vp.col.sell": "売り",
  "vp.col.buy": "買い",
  "vp.col.depth": "深度",
  "vp.amm.quotesEmpty": "この run に venue クォートの記録がありません",
  "vp.amm.note": "venue 別の深度は run 終了後に表示されます",
  "vp.amm.sampledNote":
    "venue の系列は run 中にラウンド境界ごとに記録したサンプルです（{n} 点、{every} ブロックごと）。tx 単位の出来高と取引マーカーは run 終了後の再構成が要るため、期間の閉じた日には出ません。",
  "vp.amm.swapsTitle": "エージェントのスワップ · {base}",
  "vp.col.block": "ブロック",
  "vp.col.agent": "エージェント",
  "vp.col.side": "売買",
  "vp.col.size": "サイズ",
  "vp.col.price": "価格",
  "vp.amm.swapsEmpty":
    "この資産のスワップは検出されませんでした — 誰も取引しなかったか、venue 別記録が始まる前の run です",
  "vp.side.buy": "買い",
  "vp.side.sell": "売り",

  "vp.perp.label": "Perp",
  "vp.perp.caption":
    "GMX v2。建玉は注文として出され、環境のキーパーが次のブロックで執行します。つまり perp の取引は、必ず判断の 1 ブロック後に成立します。ファンディングは建玉が偏っている側から反対側へ支払われます。レートは上の OI の偏りに追随しますが、数百ブロックの run で実際に動く金額は小さい値です。",
  "vp.perp.oi": "建玉総額 (OI)",
  "vp.perp.oiSplit": "ロング {long}% / ショート {short}%",
  "vp.perp.noOi": "建玉なし",
  "vp.perp.longOi": "ロング OI",
  "vp.perp.shortOi": "ショート OI",
  "vp.perp.funding": "ファンディング / 1h",
  "vp.perp.fundingSub": "正 = ロングがショートに支払う。負はその逆",
  "vp.perp.oiChart": "建玉総額 · {base}",
  "vp.perp.long": "ロング",
  "vp.perp.short": "ショート",
  "vp.perp.fundingChart": "ファンディングレート（毎時）",
  "vp.perp.balanced": "均衡",
  "vp.perp.positionsTitle": "run 最終ブロック時点の建玉",
  "vp.col.collateral": "証拠金",
  "vp.col.entry": "建値",
  "vp.col.pnl": "損益",
  "vp.perp.positionsEmpty": "run 終了時に開いていた perp 建玉はありません",
  "vp.perp.keeperFailures": "キーパー失敗",
  "vp.perp.keeperSub": "環境のキーパーが執行できなかった注文",
  "vp.perp.noState": "この run に {base} の GMX 記録はありません",
  "vp.perp.note": "GMX の状態は run 終了後に表示されます",
  "vp.side.long": "ロング",
  "vp.side.short": "ショート",

  "vp.lending.label": "レンディング",
  "vp.lending.caption":
    "Aave v3。担保の価格を決めるオラクルは環境が書き込み、1 ブロック遅れて届きます。したがってエージェントが読む健全性係数は、それを割る価格より常に 1 ブロック古い値です。画面上はまだ安全に見えるポジションが、チェーン上では既に清算可能ということが起こります。",
  "vp.lending.supplied": "総供給",
  "vp.lending.borrowed": "総借入",
  "vp.lending.utilization": "利用率 {v}",
  "vp.lending.borrowedChart": "リザーブ別借入",
  "vp.lending.utilizationChart": "リザーブ別利用率",
  "vp.lending.reservesTitle": "run 最終ブロック時点のリザーブ",
  "vp.col.asset": "資産",
  "vp.col.suppliedCol": "供給",
  "vp.col.borrowedCol": "借入",
  "vp.col.utilizationCol": "利用率",
  "vp.lending.reservesEmpty": "この run にリザーブ残高の記録がありません",
  "vp.lending.worstHf": "victim の最悪健全性係数",
  "vp.lending.liquidatable": "清算可能",
  "vp.lending.aboveLine": "清算ラインより上",
  "vp.lending.victimChart": "victim の健全性係数（最悪値）",
  "vp.lending.minHf": "最小 HF",
  "vp.lending.liquidationLine": "清算ライン",
  "vp.lending.liquidations": "清算",
  "vp.col.victim": "Victim",
  "vp.col.healthFactor": "健全性係数",
  "vp.col.remainingDebt": "残債",
  "vp.lending.liquidationsEmpty": "この run で清算された victim はいません",
  "vp.lending.accountsTitle": "run 最終ブロック時点のエージェント口座",
  "vp.col.debt": "負債",
  "vp.lending.accountsEmpty":
    "run 終了時に Aave ポジションを持つエージェントはいません",
  "vp.lending.noState": "この run に Aave リザーブの記録がありません",
  "vp.lending.note": "Aave の状態は run 終了後に表示されます",

  "vp.stable.label": "ステーブルコイン",
  "vp.stable.caption":
    "ここでのステーブルコインの価格は、仮定ではなく実測です。マークはそのコインのプールの売り・買い両方向の実行可能価格の幾何平均なので、ペグが外れていれば外れたまま表示されます。eUSD だけは下に床があります。常に最もリスクの高いトローブから $1 分の担保と交換できるため、そのディスカウントは予想ではなく行使できる請求権です。",
  "vp.stable.price": "{symbol} 価格",
  "vp.stable.deepest": "最安 {v} · par 比 {bps}",
  "vp.stable.noQuote": "プールが値を返さず — par を仮置き",
  "vp.stable.tcr": "システム TCR",
  "vp.stable.recovery": "リカバリーモード",
  "vp.stable.aboveCcr": "CCR (1.5) より上",
  "vp.stable.troves": "オープン中トローブ",
  "vp.stable.riskiest": "最低 ICR {v}",
  "vp.stable.debt": "eUSD 債務",
  "vp.stable.spSub": "安定プール {v} eUSD",
  "vp.stable.redemptionFee": "償還手数料",
  "vp.stable.borrowingSub": "借入 {v}bps",
  "vp.stable.eusdPrice": "eUSD 価格",
  "vp.stable.eusdVenueRead": "eUSD（venue 読み取り）",
  "vp.stable.tcrChart": "システム担保率",
  "vp.stable.ccrLine": "CCR — リカバリーモード",
  "vp.stable.feesChart": "償還 / 借入手数料",
  "vp.stable.redemptionLine": "償還",
  "vp.stable.borrowingLine": "借入",
  "vp.stable.redemptionsTitle": "償還",
  "vp.col.eusdRedeemed": "償還 eUSD",
  "vp.col.ethOut": "ETH 受取",
  "vp.col.ethFee": "ETH 手数料",
  "vp.stable.redemptionsEmpty":
    "この run で eUSD を償還した者はいません — ディスカウントが償還手数料を超えなかったか、誰も試みませんでした",
  "vp.stable.troveLiqTitle": "トローブ清算",
  "vp.col.borrower": "借り手",
  "vp.col.mode": "モード",
  "vp.stable.modeRecovery": "リカバリー",
  "vp.stable.modeNormal": "通常",
  "vp.stable.troveLiqEmpty": "清算されたトローブはありません",
  "vp.stable.priceChart": "ステーブルコイン価格（対 USDC）",
  "vp.stable.parLine": "par",
  "vp.stable.depegPressure": "デペグ圧力",
  "vp.stable.depegSub": "環境の売りが {n} ブロック",
  "vp.stable.depegTitle": "デペグ窓（環境の売り）",
  "vp.col.stable": "ステーブル",
  "vp.col.targetShare": "深度に対する目標比率",
  "vp.col.sold": "売却量",
  "vp.stable.depegEmpty":
    "この run で環境がペグを崩しに行くことはありませんでした",
  "vp.stable.note": "この run にステーブルコイン市場はありません",

  "vp.lst.label": "LST",
  "vp.lst.caption":
    "非 rebasing の LST は、同じ資産に価格を 2 つ持ちます。1 つは vault が負う償還レートで、これは出金キューの向こう側にあります。もう 1 つは二次市場のプールが今すぐ払う価格です。2 つの差が利益になるのは、キューを待てる場合だけです。",
  "vp.lst.rate": "償還レート",
  "vp.lst.rateSub": "vault が 1 LST あたりに負う額 — par",
  "vp.lst.market": "市場価格",
  "vp.lst.marketSub": "プールが今払う額",
  "vp.lst.discount": "ディスカウント",
  "vp.lst.discountSub": "market < par。出金キューがあるから持続し得ます",
  "vp.lst.queue": "出金キュー",
  "vp.lst.queueSub": "出金遅延 {n} ブロック",
  "vp.lst.reserve": "報酬リザーブ",
  "vp.lst.reserveEmpty": "枯渇 — 利回りは停止",
  "vp.lst.apy": "APY {v}%",
  "vp.lst.rateChart": "償還レート vs 市場価格",
  "vp.lst.rateLine": "償還レート (par)",
  "vp.lst.marketLine": "市場価格",
  "vp.lst.discountChart": "par からのディスカウント",
  "vp.lst.discountLine": "ディスカウント",
  "vp.lst.queueChart": "出金キュー長",
  "vp.lst.queueLine": "待機中の出金",
  "vp.lst.slashes": "スラッシュ",
  "vp.lst.slashesSub": "償還レートの恒久的な切り下げ",
  "vp.lst.slashTitle": "スラッシュイベント",
  "vp.col.rateBefore": "レート（前）",
  "vp.col.rateAfter": "レート（後）",
  "vp.col.cut": "切下げ幅",
  "vp.col.discountAfter": "直後のディスカウント",
  "vp.lst.slashEmpty": "この run で vault はスラッシュされませんでした",
  "vp.lst.apyTitle": "利回り変更",
  "vp.col.apy": "APY",
  "vp.lst.apyEmpty": "利回りは run 全体で固定でした",
  "vp.lst.note": "この run に LST の記録はありません",

  "vp.scenario.label": "シナリオ",
  "vp.scenario.caption":
    "環境がこの run に対して行ったことです。予定は最初のブロックより前にシードから引かれます。各イベントは台形で、立ち上がり（ramp）・維持（hold）・減衰（decay）の順にフェア価格の上へ重なります。引き方はランダムですが再現可能なので、同じシードは必ず同じ窓を再生します。このタブは選んだラウンドではなく run 全体を表示します。シナリオは run の属性だからです。",
  "vp.scenario.seed": "シード",
  "vp.scenario.seedSub": "フローシード {flow} · この run の市場条件のラベル",
  "vp.scenario.scheduled": "予定イベント",
  "vp.scenario.scheduledNone": "なし — 動いていたのはフェア価格の walk だけ",
  "vp.scenario.window": "run の範囲",
  "vp.scenario.windowSub": "{blocks} ブロック · {rounds} ラウンド",
  "vp.scenario.scheduleTitle": "ストレス予定（run 開始時にシードから決定）",
  "vp.col.event": "イベント",
  "vp.col.windowShape": "窓 · ramp/hold/decay",
  "vp.col.rounds": "ラウンド",
  "vp.col.mag": "強度",
  "vp.col.outcome": "結果",
  "vp.scenario.scheduleEmpty":
    "ストレスイベントの予定なし — この run はフェア価格の walk とオーダーフローだけです",
  "vp.scenario.neverFired": "発火せず",
  "vp.scenario.failed": "失敗",
  "vp.scenario.restored": "復元済み",
  "vp.scenario.leftInPlace": "そのまま維持",
  "vp.scenario.firedBlocks": "{n} blk {from}–{to}",
  "vp.scenario.crash": "フェア価格へのオーバーレイ — 価格チャート参照",
  "vp.scenario.cexDrift": "価格 walk 自体を変更 — 価格チャート参照",
  "vp.scenario.flowTrend": "オーダーフローを傾ける — スワップ出来高参照",
  "vp.scenario.venueEvents": "venue イベント",
  "vp.scenario.venueEventsSub": "清算・償還・スラッシュ・開いた裁定窓",
  "vp.scenario.notableTitle": "venue で起きたこと（ブロック順）",
  "vp.col.round": "ラウンド",
  "vp.col.detail": "詳細",
  "vp.scenario.notableEmpty":
    "清算・償還・スラッシュはなく、報告されるほど長く開いた裁定窓もありませんでした",
  "vp.scenario.liquidation": "清算",
  "vp.scenario.liquidationText": "victim {victim} を HF {hf} で清算",
  "vp.scenario.troveLiquidated": "トローブ清算",
  "vp.scenario.troveText": "{borrower} · {debt} eUSD",
  "vp.scenario.redemption": "償還",
  "vp.scenario.redemptionText": "{eusd} eUSD を {eth} ETH に償還",
  "vp.scenario.lstSlash": "LST スラッシュ",
  "vp.scenario.lstSlashText": "償還レート {before} → {after}",
  "vp.scenario.arbWindow": "裁定窓",
  "vp.scenario.arbWindowText": "{base} {buy}→{sell} が {bps}bps で継続",

  "pos.kind.stake": "ステーク",
  "pos.kind.debt": "負債",
  "pos.kind.deposit": "預入",
  "pos.kind.hold": "保有",
  "pos.kind.borrow": "借入",
  "pos.kind.supply": "供給",
  "pos.entry": "建値 {v}",
  "pos.entryNone": "建値 —",
  "pos.collateralNote": "証拠金 {v}",
  "pos.par": "par {v} WETH",
  "pos.queue": "キュー: 受取可 {claimable} / 待機 {pending}（{n} 件）",
  "pos.queueOne": "キュー: 受取可 {claimable} / 待機 {pending}（1 件）",
  "pos.noQueue": "出金待ちなし",
  "pos.troveNote": "担保 {coll} WETH · MCR 1.100",
  "pos.icrNone": "ICR —",
  "pos.spMark": "清算債務を吸収",
  "pos.spNote": "トローブ清算時に割引価格の担保で支払われる",
  "pos.eusdSpot": "eUSD（現物）",
  "pos.eusdNote": "最もリスクの高いトローブに対し par で償還可能",
  "pos.aave": "Aave 口座",
  "pos.debtNote": "負債 {v}",
  "pos.noDebt": "借入なし",

  "err.noRuns":
    "runs/ に run が見つかりません — まず `npm run sim:realtime` を 1 回完走させてください",

  // ---- 公開ビュー（server/runsApi.ts の audience モード）と試行環境 ----
  "mode.audienceBadge": "公開ビュー",
  "mode.audienceNote":
    "公開ビューです。競技中は、各エポックのシナリオ・これから開く環境イベント・エージェントの判断ログ・未確定の入札を表示しません（規約 §3.3・§2.6）。結果発表とともに公開されます（規約 §7.2）。",
  "home.progress": "{planned} エポック中 {done} 本が完了",
  "home.progressRunning": "次のエポックを実行中",
  "home.progressPreparing":
    "競技は開始済みで、1 本目のエポックを実行中です。完走すると順位が出ます。",
  "home.standingsOff":
    "この環境では順位を掲示しません（規約 §4.7: 試行環境は順位を掲示しない）。シナリオ・市場・エクスプローラは閲覧できます。",
  "home.col.flags": "注記",
  "home.flagsTitle":
    "採点上のペナルティではなく記録された事実です（規約 §4.4.2: 止まった agent も残したポジションで採点される）: {flags}",
  "home.search": "エージェント名・参加単位で絞り込み…",
  "home.showMore": "全 {n} 行を表示",
  "home.showLess": "上位 {n} 行だけ表示",
  "home.view.agents": "エージェント",
  "home.view.participants": "参加単位",
  "home.participantsNote":
    "規約 §2.2: 参加単位は 2 提出まで選べ、最終スコアは高い方です。各行に採点された agent を示します。",
  "home.col.participant": "参加単位",
  "home.col.countedAgent": "採点 agent",
  "home.col.agents": "エージェント",
  "home.scenarios.audienceEvents":
    "公開ビュー: 既に開いたイベントだけを表示し、これから開く窓は競技中は伏せます。",
  "scenario.hidden": "エポック {s}",
  "home.scenarios.eventsWithheld": "競技中は非表示",
  "agent.audienceLog": "競技中は表示しません",
  "agent.audienceLogNote":
    "判断ログは参加者自身の推論で、mempool の自己申告はまだブロックに入っていない入札です（規約 §2.6）。どちらも結果発表までは公開しません（規約 §7.2）。",
  "agent.flags": "記録された事実（規約 §4.4.2。採点上のペナルティは無い）",
  "market.submissionsAudience":
    "競技中は未確定の入札を表示しません（規約 §2.6: ブロックに入るかは priority fee のオークションで決まる）。",
  "market.standingsOff": "この環境では掲示しません（規約 §4.7）",
  "live.noChainReads":
    "ブロック高は環境のログから取得しています。公開ビューではチェーンを直接読みません。",
  // ---- 順位表をライブの掲示板として: 状態行・エポック別スコアの推移・フォーム・ピン留め ----
  "home.status.epochs": "{planned} エポック中 {done} 本を採点済み",
  "home.status.epochsAll": "{n} エポックを採点済み",
  "home.status.updated": "最終更新 {time}",
  "home.status.next": "次のエポックは {time} 開始予定",
  "home.status.live": "エポックを実行中",
  "home.chart.title": "エポックごとのスコア",
  "home.chart.subtitle":
    "完走したエポックごとの累積スコア。表と同じ数字をエポック単位で再生したもので、上位 {n} 体を色付き、他は灰色で描きます。50 が場の平均です。名前をクリックすると追跡します。",
  "home.chart.mean": "場の平均",
  "home.chart.empty": "2 エポック採点されるとグラフが出ます。",
  "home.chart.legend": "上位 {n}",
  "home.col.delta": "Δ",
  "home.deltaTitle": "直前の完走エポックからの順位変動",
  "home.col.form": "フォーム",
  "home.formTitle": "エポックごとの T（古い順）— {n} 本採点、直近 {latest}",
  "home.col.txs": "tx",
  "home.col.reverts": "revert",
  "home.txsTitle": "採点済みシナリオでブロックに入った tx の数と、そのうち revert した数",
  "home.details": "詳細",
  "home.pin": "追跡",
  "home.unpin": "追跡をやめる",
  "home.pinTitle": "このブラウザで、表とグラフの中でこのエージェントを強調します",
  "home.pinned": "追跡中",
  "home.about": "この競技について",
  "home.aboutHint":
    "単位の入れ子・環境が何をするか・スコアの計算・データの出所。",
};

const MESSAGES: Record<"en" | "ja", Record<MessageKey, string>> = { en, ja };

/** Translate a key in the current locale, interpolating {name} params. Callable outside React —
 * the data-layer builders use it too; snapshot hooks key on the locale so they rebuild on switch. */
export function t(
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let out: string = MESSAGES[getLocale()][key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}
