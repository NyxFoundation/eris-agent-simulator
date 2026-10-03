// Every user-visible string, in both languages, in one place.
//
// Rules the copy follows (the audit that produced them lives in the PR description):
//   - name things by what the viewer controls and recognizes, never by how the system is built —
//     no artifact file names, config paths, env keys or ADR numbers outside the learning layer
//   - one word per concept: competition / scenario / interval, standings, live / finished
//     (the interval is the rules' evaluation interval, §0.1; the code calls it a round, issue #140)
//   - every number carries its unit: bps per interval, USDC, blocks
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

  // ---- navigation and the competition / world pickers ----
  "nav.standings": "Standings",
  "nav.scenario": "Scenario",
  "nav.markets": "Markets",
  "nav.explorer": "Explorer",
  "nav.menu": "Menu",
  "picker.competition": "Competition",
  "picker.scenario": "Scenario",
  "picker.singleRun": "— single run —",
  // The world a scenario-level page is on, in the picker's place (the standings page opens worlds
  // from its scenario list instead of a dropdown of names).
  "picker.world": "Viewing",
  "picker.worldOf": "{i} of {n} worlds",
  "picker.worldRounds": "{n} intervals",
  "picker.worldLeader": "leads: {id}",
  "picker.worldEvents": "episodes: {list}",
  "picker.worldNoEvents": "no episodes scheduled",
  "picker.change": "change",
  "picker.close": "close",
  "picker.readOnly": "Read-only view",
  "picker.noSignIn": "no sign-in required",

  // ---- interval cursor (competition clock) ----
  "cursor.final": "Final · {n} intervals",
  "cursor.at": "Interval {at} / {max}",
  "cursor.play": "▶ play",
  "cursor.pause": "❚❚ pause",
  "cursor.jumpFinal": "jump to final →",
  "cursor.complete": "{n} scenarios · finished",
  "cursor.completeOne": "1 scenario · finished",
  "cursor.running":
    "{running} of {total} still running · {ended} ended earlier",
  "cursor.atRound": "{n} scenarios @ interval {at}",
  "cursor.atRoundOne": "1 scenario @ interval {at}",

  // ---- home (competition standings) ----
  "home.stat.scenarios": "scenarios",
  "home.stat.regimes": "regimes",
  "home.stat.agents": "agents",
  "home.stat.rounds": "intervals",
  "home.stat.recorded": "recorded",
  "home.roundsFinal": "{n} · final",
  "home.roundsAt": "{at} of {n}",
  "home.missingRounds":
    "{missing} of {total} scenario runs were not collected — they still count toward the ranking, but have no interval detail.",
  // ADR 0021 §1. Shown on any competition that is not a scenario matrix — the practice devnet runs
  // one continuous world (ADR 0020 §2 puts the official competition in `scenario` mode), so a
  // continuous competition is by construction not the official scoring. Said on the standings
  // itself, permanently, because a ranking whose provenance travels separately from the ranking is
  // a ranking that will be misread.
  "home.practiceBadge": "practice",
  "home.practiceNote":
    "Practice standings, not the official scoring. The competition is scored separately, from submitted bundles replayed over a scenario matrix — nothing here feeds into it.",
  "home.standingsFinal": "Standings · final",
  // The heading over the §4.7 notice, where there is no result to be final or provisional about.
  "home.standingsTitle": "Standings",
  "home.standingsThrough": "Standings · through interval {at}",
  "home.subtitlePractice":
    "Score: each day of the period is one epoch. P is the agent's return over the day (end value ÷ start value − 1) rather than its USDC — the world never resets, so starting amounts drift apart, and a return asks what each agent did with what it had. T = 50 + 10 × (P − μ) / σ over the field, and the score is the plain average of T over the days. An agent that starts a day with less than a tenth of the field's median is not placed that day. With equal starts this is exactly the competition's ranking.",
  "home.subtitle":
    "Score: each epoch (one scenario run) gives every agent a deviation score T = 50 + 10 × (P − μ) / σ, where P is its USDC profit over the epoch and μ, σ are the field's. The score is the average of T over the epochs, later epochs weighted up to 1.5×. Regime columns are the agent's mean T in that regime. Click a row for the epoch-by-epoch breakdown.",
  "home.col.move": "move",
  "home.col.agent": "agent",
  "home.col.score":
    "score",
  "home.col.netPnl": "net PnL",
  "home.scoreTitle":
    "{n} epoch(s) scored · tie-breaks: std of T {std}, worst epoch T {worst}",
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
  "home.scenarios.col.rounds": "intervals",
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
    "This world ran out of intervals before the cursor. Its last value is its result, so it stays in the standings.",
  "home.scenarios.noEvents": "none scheduled",
  "home.scenarios.noLeader": "no result yet",
  "home.scenarios.missing":
    "interval detail was not collected for this scenario",
  "home.scenarios.leaderTitle":
    "leads through the selected interval, by P = V_k − V_0 (USDC) — the quantity the epoch's deviation score is taken over",

  // ---- how the units nest ----
  // The interval is easy to mistake for the scoring unit, which is the epoch (one scenario run).
  // Saying what it is, once, beats disambiguating it per panel. It was called a round until issue
  // #140, and "round" meant a block, a scoring window or a whole run depending on the reader.
  "units.title": "How this fits together",
  "units.competition": "Competition",
  "units.competitionBody":
    "Every scenario replayed, ranked together. This page.",
  "units.scenario": "Scenario",
  "units.scenarioBody":
    "One world: a regime drawn at a seed, run start to finish. All agents trade it at the same time.",
  "units.round": "Interval",
  "units.roundBody":
    "The evaluation interval — several blocks, not one. Values, rank moves and environment episodes are read against it as interim progress; the score uses only the scenario's first and last boundary.",
  "units.block": "Block",
  "units.blockBody":
    "Two seconds, and one chance to act. Transactions inside one are ordered by priority fee.",

  // ---- scenario page ----
  "scenario.fallbackTitle": "Scenario",
  "scenario.seed": "seed {n}",
  "scenario.roundsBlocks": "{rounds} intervals × {blocks} blocks",
  "scenario.standings": "Scenario standings",
  "home.scenarios.aboutSeed":
    "A seed is a label for market conditions. The fair-price path is reproducible per (regime, seed), but transaction timing and in-block ordering are not — the same scenario replayed twice gives different fills, which is why the competition measures over many scenarios.",
  "home.scenarios.aboutRegimes":
    "Official regimes: calm, cex-drift, informed-flow, whale, lending-incident, crash, depeg, vuln, spike, depeg-persist, cdp-incident, and launch. A scenario is one (regime, seed) pair; a competition replays a whole set of them and ranks agents per regime.",
  "home.scenarios.aboutEpisodes":
    "Stress events are randomized-but-deterministic overlays on the fair price (ramp, hold, decay), liquidity pulls that thin every AMM pool at once, and depegs where the environment leans on a stablecoin's pool until the window closes. Seeded victim positions make lending liquidations reachable for agents that watch health factors.",
  "explorer.about.p1":
    "Everything on these pages is derived from the run's own recorded files: the standings and per-interval results, the reconstructed observations and event stream, every transaction, each agent's own decision log, and the per-venue market series.",
  "explorer.about.p2":
    "The chain is the source of truth: every numeric series is reconstructed from on-chain reads after the run. Logs supply only reasoning, intent and identity.",
  "explorer.about.p3":
    "While a run is live the dashboard tails the log files and reads the chain over RPC — prices, blocks, the event tape and decision logs update in place. Scores and per-venue series appear the moment the run finishes.",
  "explorer.about.p4":
    "The local Blockscout explorer (npm run explorer) is the deep-dive tool: when it is running, every transaction, address and block on these pages links into it.",

  // ---- rounds bar (one scenario's clock) ----
  "rounds.segmentTitle": "Interval {i} · blocks {from}–{to} · {tx}",
  "rounds.txOutside": "transactions not counted — this view does not cover these blocks",
  "rounds.txNotStarted": "not started",
  "rounds.txN": "{n} tx",
  "rounds.heading": "Interval {i}",
  "rounds.blocks": "blocks {from}–{to}",
  "rounds.openExplorer": "open in explorer →",
  "rounds.close": "close ✕",
  "rounds.notScored":
    "no result for this interval — the run recorded no interval series",
  "rounds.scoredLater":
    "scored when the run finishes — results are reconstructed from chain history afterwards",
  "rounds.col.agent": "Agent",
  "rounds.col.delta": "Δ value",
  "rounds.col.logReturn": "Log return",
  "rounds.col.rank": "Rank",
  "rounds.bankrupt":
    "asset value at or below zero (bankrupt — no floor, no freeze)",
  "rounds.deltaNote":
    "Δ value is the raw change in account value, market exposure included — a do-nothing agent still moves with the price. Log return is the same change as a log growth rate. Neither is the score, which is one number for the whole epoch. Rank is cumulative since the first interval; the arrow is its change over this interval.",
  "rounds.envDid": "What the environment did",
  "rounds.replayStart": "▶ replay",
  "rounds.replayStartTitle": "Walk this run forward from its first block",
  "rounds.replayExit": "exit",
  "rounds.blk": "blk {b} / {to}",
  "rounds.play": "Play",
  "rounds.pause": "Pause",
  "rounds.playAgain": "Replay again",
  "rounds.replay": "replay",
  "rounds.progress": "{done}/{total} intervals",
  "rounds.progressBlocks": "{done}/{total} intervals × {blocks} blocks",
  "rounds.noRounds":
    "no intervals in this run — it was too short for a single one",
  "rounds.left": "{t} left",
  "rounds.replayPct": "replay {pct}%",

  // ---- agent page ----
  "agent.tab.standing": "Standing",
  "agent.tab.overview": "Overview",
  "agent.tab.rounds": "Intervals",
  "agent.tab.positions": "Positions",
  "agent.tab.trades": "Trade history",
  "agent.tab.log": "Decision log",
  "agent.back": "← back",
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
  "agent.standing.explainPractice":
    "Every day of the period this agent was scored in. P is its return over the day (end value ÷ start value − 1); T is where that return sat in the day's field (50 = the field's mean, ±10 = one standard deviation), and the score is the plain average of T over the days — every day counts the same.",
  "agent.standing.belowFloor":
    "Not placed on {n} day(s): it started them with less than a tenth of the field's median value. A return on that little is decided by fees and rounding, so those days are left out rather than scored.",
  "agent.standing.noSeries":
    "No interval detail for this agent — the scenario runs behind this competition were not collected, so the standing can be shown but not explained.",
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
    "no interval results yet — the per-interval series is built when the run finishes",
  "agent.roundsNote":
    "An interval is the rules' evaluation interval — the leaderboard's running progress inside an epoch. Log return is the raw change of this agent's account value over the interval. The score is one number for the whole epoch (P = V_K − V_0, standardised over the field), not a function of these intervals.",
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
  "market.runWideNote":
    "This tab is not narrowed by the interval you pick: its tables are a single snapshot taken at the run's last block.",
  "market.roundScope": "Interval {i} · blocks {from}–{to}",
  "market.scopeHint":
    "Pick an interval in the bar above and every panel below narrows to that interval's blocks.",
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
  // The audience does not operate this deployment, so a failed probe is stated as a missing
  // capability rather than as a command to run (issue #84 H).
  "explorer.offlineAudience":
    "Block-explorer links are unavailable. Everything below is this run's own record of what was included.",
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
  "explorer.wholeRun": "Whole run ({n} intervals)",
  "explorer.roundOption": "Interval {i} · blk {from}–{to}",
  "explorer.scopeBlocks": "blocks {from}–{to}",
  "explorer.scopeRound": "interval {i} · blocks {from}–{to}",
  "explorer.stat.scenario": "Scenario",
  "explorer.stat.latest": "Latest block",
  "explorer.stat.indexed": "Indexed block",
  "explorer.stat.txRun": "Tx this run",
  "explorer.stat.txRound": "Tx this interval",
  "explorer.stat.agents": "Active agents",
  "explorer.stat.blockTime": "Avg block time",
  "explorer.blocks": "Blocks",
  "explorer.transactions": "Transactions",
  "explorer.shown": "{n} shown",
  "explorer.noBlocks": "no block in this scope matches",
  "explorer.noTx": "no transaction in this scope matches",
  "explorer.openBlock": "Open block in Blockscout",
  "explorer.startToOpen": "start `npm run explorer` to open blocks",
  "explorer.blockNoLink": "block explorer unavailable",

  // ---- environment events, as the scenario board's "what the environment did here" strip reads them ----
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
    "Venue series sampled at each interval boundary ({n} points, every {every} blocks) while the run was going. Per-transaction volume and the trade markers need the post-run sweep, which a period's closed day does not get.",
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
    "What the environment did to this run. Its schedule is drawn from the seed before the first block: each episode is a trapezoid — it ramps up, holds, then decays — laid over the fair-price walk. The draw is random but reproducible, so the same seed always replays the same windows. This tab covers the whole run rather than the interval you picked, because a scenario is a property of the run.",
  "vp.scenario.seed": "Seed",
  "vp.scenario.seedSub":
    "flow seed {flow} · the label for this run's market conditions",
  "vp.scenario.scheduled": "Scheduled events",
  "vp.scenario.scheduledNone":
    "none — the fair-price walk was the only thing moving",
  "vp.scenario.window": "Run window",
  "vp.scenario.windowSub": "{blocks} blocks · {rounds} intervals",
  "vp.scenario.scheduleTitle":
    "Stress schedule (drawn from the seed at run start)",
  "vp.col.event": "Event",
  "vp.col.windowShape": "Window · ramp/hold/decay",
  "vp.col.rounds": "Intervals",
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
  "vp.scenario.flipped": "{type} (drawn as {from})",
  "vp.scenario.recovered": "{pct}% recovered",
  "vp.scenario.cexDrift": "changes the price walk — see the price chart",
  "vp.scenario.flowTrend": "tilts the order flow — see the swap volume",
  "vp.scenario.venueEvents": "Venue events",
  "vp.scenario.venueEventsSub":
    "liquidations, redemptions, slashes and open arb windows",
  "vp.scenario.notableTitle": "What the venues did, in block order",
  "vp.col.round": "Interval",
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
  "pos.kind.claim": "CLAIM",
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
  "pos.surplus": "Liquity collateral surplus",
  "pos.surplusMark": "valued at the WETH fair",
  "pos.surplusNote": "left by a closed Trove (full redemption or Recovery-Mode liquidation); claimable with claimCollateral()",
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
    "Participant units: agents registered under the same participant unit fold into one row, placed by the higher score. Each row names the agent that counted.",
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
  "home.col.form": "form",
  "home.formTitle": "T per epoch, oldest to newest — {n} scored, latest {latest}",
  "home.col.txs": "txs",
  "home.col.reverts": "reverted",
  "home.details": "details",
  "home.pin": "follow",
  "home.unpin": "unfollow",
  "home.pinTitle": "Highlight this agent in the table and the chart on this browser",
  "home.pinned": "following",

  // ---- world (the competition map) ----
  // The board the demo film is staged on, walked a block at a time. Every string here names either
  // a position on the block axis or a thing standing on the board.
  "world.col.agents":
    "{n} wallets · one process each, deciding every block · the benchmark included",
  "world.col.chain": "the chain · every transaction goes through it",
  "world.col.contracts": "contracts · state",
  "world.block": "block {n}",
  "world.blockRange": "blocks {from}\u2013{to}",
  "world.fair": "fair {price}",
  "world.emptyBlock": "no transaction in this block",
  "world.moreTxs": "+{n} more in the same block",
  "world.reverted": "{n} reverted",
  "world.metric.price": "pool price",
  "world.metric.oi": "open interest",
  "world.metric.utilisation": "utilisation",
  "world.metric.discount": "discount",
  "world.metric.peg": "eUSD",
  "world.metric.markets": "markets",
  "world.timeline": "Block axis",
  "world.at": "Block {block} · {i} / {n}",
  "world.atRange": "Blocks {from}\u2013{to} · {i} / {n}",
  "world.noFrames": "nothing to walk",
  "world.inRound": "interval {n}",
  "world.toStart": "back to the first block",
  "world.stepBack": "one block back",
  "world.stepForward": "one block on",
  "world.toEnd": "to the last block",
  "world.keys": "\u2190 \u2192 step · space plays",
  "world.chip.balance": "balance {usd} USDC",
  "world.chip.pnl": "gain {pnl}",
  "world.chip.unscored": "no scored mark yet",
  "world.thinking": "Agent Log",
  "world.openAgent": "{id}'s page →",
  "world.pickAgent": "Pick a wallet on the board to follow its own account of the run — the action it chose each block, and the reason it gave.",
  "world.logsWithheld":
    "Decision logs are a participant's own and are not served in the public view. The board still shows every transaction they sent.",
  "world.logExternal":
    "{id} runs on its owner's machine, so its reasoning is written there and never reaches this dashboard.",
  "world.logNotYet": "{id} has not written anything by this block yet.",
  "world.logSilent": "{id} logged no decisions in this window.",
  "world.chart.price": "Venue price against fair",
  "world.chart.fairLegend": "fair",
  "world.chart.balance": "Account value at each scored boundary",
  "world.chart.selectedLegend": "selected",
  "world.chart.fieldLegend": "the field",
  "world.chart.noBalance": "not scored yet",
  "world.thisBlock": "This block",
  "world.stat.txs": "transactions in the block",
  "world.stat.reverts": "reverted",
  "world.stat.senders": "agents trading",
  "world.environment": "What the environment did here",
  "world.quiet": "nothing scheduled at this block",
  "world.meta.agents": "{n} agents",
  "world.meta.venues": "{n} venues",
  "world.meta.wholeRun": "blocks {from}\u2013{to}",
  "world.meta.round": "interval {n}",
  "world.meta.grouped": "{n} blocks per step",
  "world.empty":
    "This run recorded no blocks to walk. A run in progress on another machine is read over its files, and the block log is written as it goes \u2014 the board fills in as the blocks arrive.",

  // ---- what the walk-through found: a live competition, a withheld schedule, an unplaced agent,
  // and the lookups a participant needs (issue #84 A/C/D/F/G/L/P/R/T/X2) ----
  "home.status.liveRound":
    "live · {label} · interval {round} of {rounds}",
  "home.status.liveRoundIn": "next interval in {t}",
  "home.status.liveBlock": "block {n}",
  "home.status.epochsAllOne": "1 epoch scored",
  "home.roundsSoFar": "{n} · so far",
  "home.standingsSoFar": "Standings · so far",
  "cursor.soFar": "So far · {n} intervals",
  "home.unscoredTitle":
    "In the record for {n} epoch(s) that did not score it: it had no starting value there (it registered part-way through). Rules §4.4.2 leaves such an epoch out of its score rather than counting it as zero.",
  "home.unscoredBadge": "not placed in {n}",

  // the standings could not be built — said, rather than falling through to a world's board
  "home.noStandings.title": "No standings yet",
  "home.noStandings.pending":
    "No epoch of this competition has been scored yet. The standings appear when the first one completes; until then the scenario below is what there is to watch.",
  "home.noStandings.failed":
    "The standings for this competition could not be built: {detail}. Its scenarios are still readable one at a time.",

  // find your own agent (there is no row to click when standings are not posted)
  "home.find.title": "Find your agent",
  "home.find.subtitle":
    "Your agent's name, or the wallet address you send from. An address the roster knows opens that agent's page; one it does not opens the transaction list filtered to it.",
  "home.find.placeholder": "agent name or 0x… address",
  "home.find.go": "open →",
  "home.find.noMatch":
    "No registered agent by that name or address. Press open to search the transactions for it.",
  "home.find.address": "{id} — registered to this address",

  // a scenario the runner never ran
  "home.scenarios.failed": "not run: {reason}",
  "home.scenarios.failedTitle":
    "This epoch did not complete, so it scores nobody (rules §4.4.2) and has no world to open. The other epochs keep their weights.",

  // agent page
  "agent.rankOf": "Rank {n} of {m}",
  "agent.rankScenario": "rank in this scenario",
  "agent.standingOffBadge": "standings not posted",
  "agent.standing.throughRound": "through interval {at}",
  "agent.standing.finalNote": "final result",
  "agent.standing.unscored":
    "Not placed in {n} epoch(s) of this competition: no starting value there, which is what a registration part-way through leaves behind. Those epochs are left out of the score rather than counted as zero (rules §4.4.2).",
  "agent.unscoredHere":
    "This run did not place this agent: it has no value at the run's first boundary, so there is no profit to compute over it. Its transactions and positions are below.",

  // explorer: search the whole list, show a page of it
  "explorer.showMore": "show {n} more",
  "explorer.searchAll": "searching all {n} transactions in scope",
  "explorer.coveredFrom":
    "the list covers blocks {from} and later — earlier ones are not held by this view",

  // the score-by-epoch legend: following an agent and opening its page are different acts
  "home.chart.openAgent": "open {id}'s page",

  // the environment's plan, in the public view
  "vp.scenario.scheduledWithheld":
    "withheld while the competition runs (rules §3.3) — this is not a claim that nothing was scheduled",
  "vp.scenario.scheduledNonePast":
    "no episode has opened yet — later windows are not published while the period runs",
  "vp.scenario.scheduledPast": "windows that have already closed",
  "vp.scenario.windowRounds": "{rounds} intervals",
  "vp.scenario.scheduleTitlePast": "Episodes that have already closed",
  "vp.scenario.scheduleWithheld":
    "Which episodes this epoch contains is not published while the competition runs (rules §3.3). It is published with the results (rules §7.2).",
  "vp.scenario.scheduleEmptyPast":
    "no episode of this period has closed yet — one that is open now, or still to come, is not listed",
  "vp.scenario.firingNotLive":
    "not shown live — what fires inside a window is sent once it closes; reload the page to see it",
  "vp.withheld.scenarioEvents":
    "not published while the competition runs (rules §3.3): whether anything was liquidated, redeemed or slashed in an epoch names its scenario. Published with the results (rules §7.2) — this is not a claim that nothing happened",
  "vp.withheld.liveEvents":
    "the live view does not receive what happened inside an episode's window: it is sent once the window closes, so reload the page to see the windows that have closed since",

  // ---- the header and the overview page (issue #183); values from data/competitionInfo.ts ----
  "tip.about":
    "About: {label}",
  "tip.close":
    "Close",
  "nav.overview":
    "Overview",
  "header.home":
    "ASCON Dashboard — overview",
  "header.nav":
    "Dashboard pages",
  "header.register":
    "Register",
  "header.submit":
    "Submit",
  "header.registerTipTitle":
    "Before you register",
  "header.registerTipDiscord":
    "Join the #ascon channel on the Nyx Foundation Discord first: registration is joining the channel and submitting the form (rules §1).",
  "header.registerTipDiscordLink":
    "Discord invite",
  "header.registerTipPeriod":
    "Registration closes at the end of {last} (JST). Each team member registers with the form; a team has at most five members.",
  "header.language":
    "Switch language",
  "overview.title":
    "ASCON",
  "overview.lead":
    "A competition for autonomous trading agents on a simulated DeFi economy. Every agent trades the same on-chain markets at the same time and is ranked across many market scenarios it is not shown in advance. This page is where the competition stands today; the rules on ascon.dev are the authority.",
  "overview.about":
    "The environment",
  "overview.aboutVenues":
    "Agents compete on a set of real DeFi protocols — automated market makers, a perpetual-futures exchange, a lending market, a liquid-staking vault and a collateralised stablecoin — deployed together on one chain (Eris, the simulator ASCON runs on). Which of them a given world runs is on its Markets page.",
  "overview.aboutEnvironment":
    "The environment drives the market: a reference price written on-chain every block, background order flow, a perp keeper, and scheduled stress episodes — crashes, liquidity pulls, stablecoin depegs, whale orders — that agents cannot opt out of.",
  "overview.aboutAgents":
    "A scenario is one world: a market regime drawn at a seed. In the live week each epoch runs a scenario from a set that is not disclosed in advance, so a strategy tuned to one path does not carry the ranking.",
  "overview.rulesLink":
    "Rules {section}",
  "overview.schedule.title":
    "Schedule",
  "overview.schedule.next":
    "Next",
  "overview.schedule.today":
    "today",
  "overview.schedule.tomorrow":
    "tomorrow",
  "overview.schedule.inDays":
    "in {n} days",
  "overview.schedule.complete":
    "Every date on the schedule has passed.",
  "overview.schedule.now":
    "now",
  "overview.schedule.done":
    "over",
  "overview.schedule.upcoming":
    "upcoming",
  "overview.schedule.tipJst":
    "All dates are Japan Standard Time. \"Now\" and the days left are decided by this browser's clock.",
  "overview.schedule.tipReserve":
    "{day} is a reserve day for re-running an epoch that could not finish. The results are followed by a seven-day objection period.",
  "overview.phase.registration":
    "Registration",
  "overview.phase.submission":
    "Submission & practice",
  "overview.phase.live":
    "Live competition",
  "overview.phase.review":
    "Review",
  "overview.phase.reportDeadline":
    "Report deadline",
  "overview.phase.results":
    "Results",
  "overview.milestone.registrationCloses":
    "Registration closes",
  "overview.milestone.submissionCloses":
    "Submissions close — agents are frozen",
  "overview.milestone.liveStarts":
    "The live competition starts",
  "overview.milestone.reportDue":
    "Report track deadline",
  "overview.milestone.results":
    "Results are announced",
  "overview.scoring.title":
    "Scoring",
  "overview.scoring.gist":
    "Highest average score wins",
  "overview.scoring.facts":
    "{k} epochs in the live week ({regimes} regimes × 5) · {blocks} blocks each",
  "overview.scoring.tipEpoch":
    "An epoch is one scenario run: {blocks} blocks, about {min} minutes. The live week runs {k} of them, and every agent starts each one from the same assets.",
  "overview.scoring.tipP":
    "P is the change in the agent's total asset value over the epoch, in USDC: its value at the last block minus its value at the first.",
  "overview.scoring.tipT":
    "T places P in that epoch's field: μ and σ are the mean and population standard deviation of P over every agent in the epoch, the benchmark excluded. 50 is the field's average; 10 points is one standard deviation.",
  "overview.scoring.tipW":
    "The score averages T with weights rising evenly from {first} for the first epoch to {last} for the last, so the ranking can still move late in the week.",
  "overview.scoring.tipTies":
    "Scores are ranked at two decimals. A tie goes to the smaller spread of the agent's own T values, then the better worst epoch, then the earlier final submission.",
  "overview.scoring.tipBankrupt":
    "Losing everything is not disqualification: a value at or below zero is scored as it is, with no floor.",
  "overview.scoring.tipSameBlocks":
    "Every agent is valued at the same blocks, never at a moment of its own choosing. Holdings the scorer cannot price are reported, never silently counted as zero.",
  "overview.scoring.tipPractice":
    "The practice standings shown during the submission period apply the same formula to daily returns. They are not the official scoring: nothing recorded in the practice environment counts toward the ranking (rules §2.7).",
  "overview.prize.title":
    "Prizes",
  "overview.prize.gist":
    "{total} in total · {first} for 1st",
  "overview.prize.facts":
    "Leaderboard {leaderboard} to the top {n} · Report track {report}",
  "overview.prize.tipLeaderboard":
    "Leaderboard track, {total}:",
  "overview.prize.rank":
    "{n}",
  "overview.prize.tipFloor":
    "From {from} place down, a prize requires a final score above {floor} — better than the average agent over the whole week.",
  "overview.prize.tipReport":
    "Report track, {total}: {list}. Any team that submitted an agent may enter, whatever its rank.",
  "overview.prize.award":
    "{name} {amount} × {n}",
  "overview.prize.award.best":
    "Best report",
  "overview.prize.award.excellence":
    "Excellence",
  "overview.prize.award.division":
    "Division (Trader / Hacker / Verifier)",
  "overview.prize.award.honorable":
    "Honorable mention",
  "overview.prize.tipBoth":
    "A team can win in both tracks.",
  "overview.submission.title":
    "Submission & limits",
  "overview.submission.gist":
    "One ZIP · replace it up to {n} times a day",
  "overview.submission.facts":
    "{ms} ms per decision · the LLM revises the code at most every {n} blocks",
  "overview.submission.tipZip":
    "Submit one ZIP: an SDK-compliant agent with its dependencies. It must use an LLM, through the inference service the organizer designates, to revise its own strategy.",
  "overview.submission.tipReplace":
    "During the submission period a submission can be replaced up to {n} times a day (days start at 00:00 JST). The one accepted last before the period ends is evaluated, and the agent is frozen from then on.",
  "overview.submission.tipRun":
    "Agents run on the organizer's servers with at most {cpu} vCPU / {mem} GB. decide() is called every block; if it has not returned within {ms} ms, that block is no action. A crashed agent is not restarted within the epoch. Agents cannot reach external networks directly.",
  "overview.submission.tipLlm":
    "The LLM never makes the per-block trading decision. At most once every {n} blocks (the default; the submission can set it) it receives the strategy's code, its trades and its PnL, and rewrites the code outside the trading path. Inference costs are the participant's.",
  "overview.submission.tipChain":
    "A block every {sec} seconds, {gas} gas per block. Transactions inside a block are ordered by priority fee, not by arrival. The reference price reaches every agent one block late, equally.",
  "overview.submission.tipSees":
    "An agent reads only confirmed on-chain state; other agents' pending transactions are not visible to it.",
  "overview.top.practice":
    "Practice standings · top {n}",
  "overview.top.soFar":
    "Standings so far · top {n}",
  "overview.top.final":
    "Final standings · top {n}",
  "overview.top.standings":
    "Standings · top {n}",
  "overview.top.tipPractice":
    "Standings from the practice environment: each day is scored on the agents' daily return. They are not the official scoring and do not count toward the ranking (rules §2.7).",
  "overview.top.tipOfficial":
    "The competition's standings: each agent's per-epoch deviation scores, averaged with the epoch weights over the epochs scored so far. They become final at the results announcement, after the review period.",
  "overview.top.tipScore":
    "Click an agent for its epoch-by-epoch breakdown.",
  "overview.top.all":
    "all standings →",
  "overview.top.empty":
    "No epoch has been scored yet.",
  "overview.links.title":
    "Links",
  "overview.links.guide":
    "Participant guide & SDK",
  "overview.links.guideBody":
    "How to build an agent, test it on your own machine, and submit it.",
  "overview.links.guideDoc":
    "Participant guide",
  "overview.links.updatesDoc":
    "Environment updates",
  "overview.links.repo":
    "SDK repository (GitHub)",
  "overview.links.rules":
    "Rules",
  "overview.links.rulesBody":
    "The authoritative text on the schedule, scoring, prizes and what is allowed. This page only summarises it.",
  "overview.links.rulesDoc":
    "Competition rules",
  "overview.links.termsDoc":
    "Participation terms",
  "overview.links.discord":
    "Discord #ascon",
  "overview.links.discordBody":
    "Questions go here. To register an agent in the practice environment, post its address here.",
  "overview.links.connect":
    "Practice environment",
  "overview.links.connectBody":
    "To connect an agent you run yourself: the chain's RPC, its block explorer, and the manifest listing every contract address.",
  "overview.links.manifest":
    "Environment manifest · {path}",

  // ---- the standings panel's "?" (what used to be column tooltips) ----
  "home.info.columns":
    "Δ is the rank change since the previous completed epoch, or since the previous interval while you scrub the bar above. Form is T per epoch, oldest to newest, against 50 (dotted); the number beside it is how many epochs were scored. Regime columns are the agent's mean T in that regime — an explanation of the score, not a second ranking.",
  "home.info.notes":
    "Notes are recorded facts, such as a stopped process — not penalties (rules §4.4.2). Hover or open the agent for the list.",
  "home.info.netPnl":
    "Net PnL (USDC) prices both ends at the run's final marks, so it exists only at a run's end: while you scrub, the finished figure is shown greyed out. It is context, not the score.",
  "home.info.details":
    "Details adds two columns: transactions included across the scored scenarios, and how many of them reverted.",
  "home.info.pin":
    "☆ follows an agent: it is highlighted in the table and the chart, in this browser only.",

  // ---- explanations behind a "?" on the scenario, markets and explorer pages (issue #183) ----
  "market.arbLegendLabel":
    "how to read this",
  "market.standingsAbout":
    "Net PnL (USDC) of each agent over this run, both ends at the run's final marks. \"—\" means the agent was not placed in this run: it had no value at the first boundary, so there is no profit to compute.",
  "market.submissionsAbout":
    "Transactions agents report having sent that are not yet in a block, with the priority fee bid on each. Once included, they are in the explorer.",
  "market.submissionsHidden":
    "Not shown while the competition runs.",
  "explorer.aboutPage":
    "Every block and transaction of the world selected on the left, as this dashboard recorded them. Search by transaction hash, block number, agent name or wallet address; when the block explorer is connected, each one links into it.",
  "scenario.standingsAbout":
    "Ranked by P = V_k − V_0 (USDC) in this world, through the last interval that has closed. One world is one draw, not the result: the competition's standings are on the Standings page.",
  "scenario.aboutBoard":
    "The board: every wallet on the left, the chain in the middle, the venues' contracts on the right. Each transaction is drawn from its sender through the chain to the contract it called. Walk it a block at a time on the block axis below.",
  "scenario.aboutInteract":
    "Pick a wallet on the board to follow its own account of the run; pick an interval in the bar above to narrow this page, Markets and Explorer to its blocks.",

  // ---- "score" in Japanese is 得点 per epoch and 平均得点 for the ranking (issue #183 follow-up) ----
  "overview.scoring.definition":
    "score = each epoch's deviation score; later epochs weigh more ({first} → {last}×)",
  "overview.scoring.rulesTerm":
    "",
  "overview.top.col.rank":
    "#",
  "overview.top.col.agent":
    "agent",
  "overview.top.col.score":
    "score",
  "overview.top.col.scored":
    "scored",
  "overview.top.days":
    "{n} days",
  "overview.top.daysOne":
    "1 day",
  "overview.top.epochs":
    "{n} epochs",
  "overview.top.epochsOne":
    "1 epoch",
  "overview.top.whatPractice":
    "score = each day's deviation score of the daily return",
  "overview.top.whatOfficial":
    "score = each epoch's deviation score, weighted by its order",
  "overview.top.spanDays":
    "{n} days",
  "overview.top.spanDaysOne":
    "1 day",
  "overview.top.spanEpochs":
    "{done} of {planned} epochs",
  "overview.top.spanEpochsAll":
    "{n} epochs",
  "overview.top.updated":
    "updated {time}",
  "agent.standing.col.t":
    "T",
  "agent.standing.col.w":
    "w",

  // ---- the overview's submission steps (issue #183 follow-up); the form URLs are announced on Discord ----
  "overview.steps.title":
    "How to submit",
  "overview.steps.tip":
    "Which steps are open today comes from the date alone: the dashboard does not know how far you have got. The guide sections linked from each step have the commands and the details.",
  "overview.steps.optional":
    "optional",
  "overview.steps.open":
    "open · {n} days left",
  "overview.steps.openOne":
    "open · 1 day left",
  "overview.steps.openToday":
    "open · last day today",
  "overview.steps.openNoEnd":
    "open",
  "overview.steps.running":
    "running · {n} days left",
  "overview.steps.runningOne":
    "running · 1 day left",
  "overview.steps.runningToday":
    "running · last day today",
  "overview.steps.before":
    "from {day}",
  "overview.steps.closed":
    "closed",
  "overview.steps.closedAll":
    "Submissions closed at the end of {day} (JST). The submission accepted last is the one evaluated, and agents are frozen.",
  "overview.steps.guide":
    "guide §{n}",
  "overview.steps.registrationForm":
    "registration form",
  "overview.steps.submissionForm":
    "submission form",
  "overview.steps.discord":
    "Discord #ascon",
  "overview.steps.register.name":
    "Register",
  "overview.steps.register.body":
    "Join #ascon on Discord first, then each team member sends the registration form.",
  "overview.steps.apiKey.name":
    "Register your inference API key",
  "overview.steps.apiKey.body":
    "Once, on a separate form; Discord #ascon has the link.",
  "overview.steps.build.name":
    "Build your agent",
  "overview.steps.build.body":
    "Copy my-arb and start from it.",
  "overview.steps.test.name":
    "Try it on your machine",
  "overview.steps.test.body":
    "Backtest it on the public scenarios and read its decisions and results.",
  "overview.steps.practice.name":
    "Run it in the practice environment",
  "overview.steps.practice.body":
    "Run it on your machine against the practice chain. Post its address in Discord #ascon to appear in the practice standings.",
  "overview.steps.zip.name":
    "Make the ZIP",
  "overview.steps.zip.body":
    "It needs a prompt.md with kind: improve.",
  "overview.steps.submit.name":
    "Submit",
  "overview.steps.submit.body":
    "Send the ZIP with the submission form (sign in with a Google account). Up to {n} a day; an email tells you within seconds whether it was accepted.",
  "overview.steps.freeze.name":
    "Frozen at the end of {day}",
  "overview.steps.freeze.body":
    "The submission accepted last when the period ends is the one evaluated. Nothing can change after that.",
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
  "nav.menu": "メニュー",
  "picker.competition": "競技",
  "picker.scenario": "シナリオ",
  "picker.singleRun": "— 単発 run —",
  "picker.world": "見ている世界",
  "picker.worldOf": "{n} 世界中 {i} 番目",
  "picker.worldRounds": "{n} 評価区間",
  "picker.worldLeader": "首位 {id}",
  "picker.worldEvents": "イベント: {list}",
  "picker.worldNoEvents": "イベントの予定なし",
  "picker.change": "変更",
  "picker.close": "閉じる",
  "picker.readOnly": "閲覧専用ビュー",
  "picker.noSignIn": "ログイン不要",

  "cursor.final": "最終 · 全 {n} 評価区間",
  "cursor.at": "評価区間 {at} / {max}",
  "cursor.play": "▶ 再生",
  "cursor.pause": "❚❚ 一時停止",
  "cursor.jumpFinal": "最終結果へ →",
  "cursor.complete": "{n} シナリオ · 終了",
  "cursor.completeOne": "1 シナリオ · 終了",
  "cursor.running": "{total} 中 {running} が進行中 · {ended} は先に終了",
  "cursor.atRound": "{n} シナリオ · 評価区間 {at}",
  "cursor.atRoundOne": "1 シナリオ · 評価区間 {at}",

  "home.stat.scenarios": "シナリオ",
  "home.stat.regimes": "レジーム",
  "home.stat.agents": "エージェント",
  "home.stat.rounds": "評価区間",
  "home.stat.recorded": "実施日",
  "home.roundsFinal": "{n} · 最終",
  "home.roundsAt": "{at} / {n}",
  "home.missingRounds":
    "{total} 本中 {missing} 本のシナリオ run が未回収です。順位には含まれますが、評価区間の詳細は表示できません。",
  "home.practiceBadge": "練習",
  "home.practiceNote":
    "これは練習順位で、公式採点ではありません。公式競技は提出バンドルをシナリオ行列で再生して別途採点され、ここの結果は一切反映されません。",
  "home.standingsFinal": "順位表 · 最終",
  "home.standingsTitle": "順位表",
  "home.standingsThrough": "順位表 · 評価区間 {at} 時点",
  "home.subtitlePractice":
    "平均得点: 期間の 1 日を 1 エポックとします。P はその日の USDC 損益ではなくリターン（終値 ÷ 始値 − 1）です。この world はリセットされないので元手が人によってずれていき、リターンにすることで「手持ちで何をしたか」を比べます。その日の得点は偏差値 T = 50 + 10 × (P − μ) / σ（全員横断）で、平均得点は得点の日ごとの単純平均です。その日の始値が場の中央値の 1/10 未満のエージェントは、その日は採点しません。全員の元手が同じなら、本番の順位と完全に一致します。",
  "home.subtitle":
    "平均得点: 各エポック（1 シナリオの run）で、エポック中の USDC 損益 P から得点（偏差値）T = 50 + 10 × (P − μ) / σ を全員横断で出し（μ・σ は場全体）、得点をエポック通しで平均した値です（後のエポックほど重みが大きく、最大 1.5 倍）。レジーム列はそのレジームでの得点の平均。行をクリックするとエポックごとの内訳が見られます。",
  "home.col.move": "変動",
  "home.col.agent": "エージェント",
  "home.col.score":
    "平均得点",
  "home.col.netPnl": "純損益",
  "home.scoreTitle":
    "採点エポック {n} · タイブレーク: 得点の標準偏差 {std}、最悪エポックの得点 {worst}",
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
  "home.scenarios.col.rounds": "評価区間",
  "home.scenarios.col.leader": "首位",
  "home.scenarios.col.events": "環境イベント",
  "home.scenarios.eventsTitle":
    "シードから引かれた時限イベントです。「予定なし」は世界が静かだったという意味ではありません。cex-drift のようなレジームは、窓を開けずに run 全体を形づくることがあります。",
  "home.scenarios.roundsAt": "{at} / {n}",
  "home.scenarios.ended": "終了",
  "home.scenarios.endedTitle":
    "カーソルより前に評価区間が尽きた世界です。最後の値がその世界の結果なので、順位表には残ります。",
  "home.scenarios.noEvents": "予定なし",
  "home.scenarios.noLeader": "結果はまだありません",
  "home.scenarios.missing": "このシナリオの評価区間の詳細は回収されていません",
  "home.scenarios.leaderTitle":
    "選択中の評価区間までの首位。P = V_k − V_0（USDC）で判定 — このエポックの得点（偏差値）のもとになる量",

  "units.title": "単位の関係",
  "units.competition": "競技",
  "units.competitionBody": "全シナリオを再生して一緒に順位を付けたもの。このページです。",
  "units.scenario": "シナリオ",
  "units.scenarioBody":
    "1 つの世界。レジームとシードの組を最初から最後まで走らせたもので、全エージェントが同時に取引します。",
  "units.round": "評価区間",
  "units.roundBody":
    "規約の評価区間で、1 ブロックではなく複数ブロックです。資産価値・順位変動・環境イベントを途中経過としてこの軸で読みます。得点に使うのはシナリオの最初と最後の境界だけです。",
  "units.block": "ブロック",
  "units.blockBody":
    "2 秒であり、1 回の行動機会です。同じブロック内の順序は優先手数料で決まります。",

  "scenario.fallbackTitle": "シナリオ",
  "scenario.seed": "シード {n}",
  "scenario.roundsBlocks": "{rounds} 評価区間 × {blocks} ブロック",
  "scenario.standings": "シナリオ内順位",
  "home.scenarios.aboutSeed":
    "シードは市場条件のラベルです。フェア価格の経路は (レジーム, シード) ごとに再現可能ですが、tx のタイミングと着順は再現されません — 同じシナリオを 2 回再生しても約定は変わります。だから競技は多数のシナリオで測ります。",
  "home.scenarios.aboutRegimes":
    "公式レジーム: calm・cex-drift・informed-flow・whale・lending-incident・crash・depeg・vuln・spike・depeg-persist・cdp-incident・launch。シナリオは 1 つの (レジーム, シード) の組で、競技はそのセット全体を再生してレジームごとに順位を付けます。",
  "home.scenarios.aboutEpisodes":
    "ストレスイベントは、フェア価格に重ねるランダム化された決定論オーバーレイ（ramp・hold・decay）、全 AMM プールを同時に薄くする流動性引き抜き、環境がステーブルのプールを窓の間だけ売り続けるデペグです。シード由来の victim ポジションがあるため、健全性係数を見ているエージェントには清算機会が届きます。",
  "explorer.about.p1":
    "このページ群の全てが run 自身の記録ファイルから導かれます: 順位と評価区間ごとの結果、再構成された観測とイベント列、全トランザクション、各エージェント自身の判断ログ、そして venue 別の市場系列です。",
  "explorer.about.p2":
    "真実の出典はチェーンです: 数値系列はすべて run 終了後にオンチェーン読み取りから再構成されます。ログが与えるのは理由・意図・帰属だけです。",
  "explorer.about.p3":
    "run の進行中はログファイルを tail し、チェーンを RPC で読みます — 価格・ブロック・イベントテープ・判断ログはその場で更新されます。得点と venue 別系列は run 終了と同時に現れます。",
  "explorer.about.p4":
    "ローカルの Blockscout エクスプローラ（npm run explorer）が深掘り用ツールです。起動していれば、ページ上の全トランザクション・アドレス・ブロックがリンクになります。",

  "rounds.segmentTitle": "評価区間 {i} · ブロック {from}–{to} · {tx}",
  "rounds.txOutside": "tx 数は数えていません — この表示はこれらのブロックを含みません",
  "rounds.txNotStarted": "未開始",
  "rounds.txN": "{n} tx",
  "rounds.heading": "評価区間 {i}",
  "rounds.blocks": "ブロック {from}–{to}",
  "rounds.openExplorer": "エクスプローラで開く →",
  "rounds.close": "閉じる ✕",
  "rounds.notScored":
    "この評価区間の結果はありません — この run は評価区間の系列を記録していません",
  "rounds.scoredLater":
    "採点は run 終了後 — 結果はチェーン履歴から再構成されます",
  "rounds.col.agent": "エージェント",
  "rounds.col.delta": "Δ資産",
  "rounds.col.logReturn": "対数リターン",
  "rounds.col.rank": "順位",
  "rounds.bankrupt":
    "資産価値がゼロ以下（破産。床処理も凍結も無し）",
  "rounds.deltaNote":
    "Δ資産は市場エクスポージャー込みの生の資産変化で、何もしないエージェントでも価格と一緒に動きます。対数リターンは同じ変化を対数成長率で表したものです。どちらも得点ではありません（得点はエポック全体で 1 つの数字です）。順位は最初の評価区間からの累積、矢印はこの評価区間での変動です。",
  "rounds.envDid": "環境が行ったこと",
  "rounds.replayStart": "▶ リプレイ",
  "rounds.replayStartTitle": "最初のブロックからこの run を再生する",
  "rounds.replayExit": "終了",
  "rounds.blk": "blk {b} / {to}",
  "rounds.play": "再生",
  "rounds.pause": "一時停止",
  "rounds.playAgain": "もう一度再生",
  "rounds.replay": "リプレイ",
  "rounds.progress": "{done}/{total} 評価区間",
  "rounds.progressBlocks": "{done}/{total} 評価区間 × {blocks} ブロック",
  "rounds.noRounds":
    "この run には評価区間がありません — 評価区間 1 つ分に満たない長さです",
  "rounds.left": "残り {t}",
  "rounds.replayPct": "リプレイ {pct}%",

  "agent.tab.standing": "総合成績",
  "agent.tab.overview": "概要",
  "agent.tab.rounds": "評価区間",
  "agent.tab.positions": "建玉",
  "agent.tab.trades": "取引履歴",
  "agent.tab.log": "判断ログ",
  "agent.back": "← 戻る",
  "agent.stat.score":
    "得点（このエポック）",
  "agent.stat.pnl": "損益 (USDC)",
  "agent.stat.drawdown": "最大ドローダウン",
  "agent.standing.rank": "順位",
  "agent.standing.rankValue": "{n} 体中 {r} 位",
  "agent.standing.score":
    "平均得点",
  "agent.standing.scoreTitle":
    "タイブレーク（§4.6）: 得点の標準偏差 {std}、最悪エポックの得点 {worst}",
  "agent.standing.netPnl": "純損益 (USDC)",
  "agent.standing.rounds":
    "採点エポック数",
  "agent.standing.explain":
    "このエージェントが採点された全エポックです。得点はそのエポックの場の中での損益の位置を表す偏差値です（50 = 場の平均、±10 = 標準偏差 1 つ分）。平均得点は得点の加重平均なので、1 つのレジームで大勝ちして他で負ける戦略は、安定した戦略より下に来ることがあります。得点の標準偏差は最初のタイブレークでもあります。",
  "agent.standing.explainPractice":
    "このエージェントが採点された期間中の全日です。P はその日のリターン（終値 ÷ 始値 − 1）、得点はそのリターンがその日の場の中でどこにあったかを表す偏差値です（50 = 場の平均、±10 = 標準偏差 1 つ分）。平均得点は得点の日ごとの単純平均で、どの日も同じ重みです。",
  "agent.standing.belowFloor":
    "{n} 日は採点していません: その日の始値が場の中央値の 1/10 未満でした。その程度の元手ではリターンが手数料と端数で決まるので、採点せずに外しています。",
  "agent.standing.noSeries":
    "このエージェントの評価区間の詳細がありません — 競技のシナリオ run が未回収のため、順位は示せても説明はできません。",
  "agent.standing.mean":
    "得点の平均",
  "agent.standing.std":
    "得点の標準偏差（タイブレーク 1）",
  "agent.standing.scoreLine":
    "平均得点（Σ w·得点 / Σ w）",
  "agent.standing.worst":
    "最悪エポックの得点（タイブレーク 2）",
  "agent.standing.byRegime": "レジーム別",
  "agent.standing.byEpoch":
    "エポック別",
  "agent.standing.col.regime": "レジーム",
  "agent.standing.col.scenario":
    "シナリオ",
  "agent.standing.col.rounds":
    "エポック",
  "agent.standing.col.mean":
    "得点の平均",
  "agent.standing.col.std":
    "得点の標準偏差",
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
    "この参加者はエージェントを自分のマシンで動かしているため、判断ログはそちらにあり、ここには届きません。このページに出ているのはすべてチェーン由来です（取引・建玉・得点）。",
  "agent.noRounds":
    "評価区間の結果はまだありません — 評価区間の系列は run 終了時に作られます",
  "agent.roundsNote":
    "評価区間は規約の評価区間（§0.1）で、エポック内でのリーダーボードの途中経過です。対数リターンはその評価区間でのこのエージェントの総資産価値の変化そのものです。得点はエポック全体で 1 つの数字（P = V_K − V_0 を場全体で標準化）で、評価区間の関数ではありません。",
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
  "market.runWideNote":
    "このタブは評価区間で絞り込まれません。表が run の最終ブロック時点の 1 断面だからです。",
  "market.roundScope": "評価区間 {i} · ブロック {from}–{to}",
  "market.scopeHint":
    "上の帯で評価区間を選ぶと、下のパネルがすべてその評価区間のブロックに絞られます。",
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
  "explorer.offlineAudience":
    "ブロックエクスプローラへのリンクは利用できません。以下はすべて、この run 自身が記録した「ブロックに入った内容」です。",
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
  "explorer.wholeRun": "run 全体（{n} 評価区間）",
  "explorer.roundOption": "評価区間 {i} · blk {from}–{to}",
  "explorer.scopeBlocks": "ブロック {from}–{to}",
  "explorer.scopeRound": "評価区間 {i} · ブロック {from}–{to}",
  "explorer.stat.scenario": "シナリオ",
  "explorer.stat.latest": "最新ブロック",
  "explorer.stat.indexed": "索引済みブロック",
  "explorer.stat.txRun": "この run の tx",
  "explorer.stat.txRound": "この評価区間の tx",
  "explorer.stat.agents": "稼働エージェント",
  "explorer.stat.blockTime": "平均ブロック時間",
  "explorer.blocks": "ブロック",
  "explorer.transactions": "トランザクション",
  "explorer.shown": "{n} 件表示",
  "explorer.noBlocks": "この範囲に一致するブロックはありません",
  "explorer.noTx": "この範囲に一致するトランザクションはありません",
  "explorer.openBlock": "Blockscout でブロックを開く",
  "explorer.startToOpen": "`npm run explorer` を起動するとブロックを開けます",
  "explorer.blockNoLink": "ブロックエクスプローラは利用できません",

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
  "tape.runCompleted":
    "run 終了、得点の再構成完了",

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
    "venue の系列は run 中に評価区間の境界ごとに記録したサンプルです（{n} 点、{every} ブロックごと）。tx 単位の出来高と取引マーカーは run 終了後の再構成が要るため、期間の閉じた日には出ません。",
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
    "環境がこの run に対して行ったことです。予定は最初のブロックより前にシードから引かれます。各イベントは台形で、立ち上がり（ramp）・維持（hold）・減衰（decay）の順にフェア価格の上へ重なります。引き方はランダムですが再現可能なので、同じシードは必ず同じ窓を再生します。このタブは選んだ評価区間ではなく run 全体を表示します。シナリオは run の属性だからです。",
  "vp.scenario.seed": "シード",
  "vp.scenario.seedSub": "フローシード {flow} · この run の市場条件のラベル",
  "vp.scenario.scheduled": "予定イベント",
  "vp.scenario.scheduledNone": "なし — 動いていたのはフェア価格の walk だけ",
  "vp.scenario.window": "run の範囲",
  "vp.scenario.windowSub": "{blocks} ブロック · {rounds} 評価区間",
  "vp.scenario.scheduleTitle": "ストレス予定（run 開始時にシードから決定）",
  "vp.col.event": "イベント",
  "vp.col.windowShape": "窓 · ramp/hold/decay",
  "vp.col.rounds": "評価区間",
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
  "vp.scenario.flipped": "{type}（{from} から反転）",
  "vp.scenario.recovered": "{pct}% 回復",
  "vp.scenario.cexDrift": "価格 walk 自体を変更 — 価格チャート参照",
  "vp.scenario.flowTrend": "オーダーフローを傾ける — スワップ出来高参照",
  "vp.scenario.venueEvents": "venue イベント",
  "vp.scenario.venueEventsSub": "清算・償還・スラッシュ・開いた裁定窓",
  "vp.scenario.notableTitle": "venue で起きたこと（ブロック順）",
  "vp.col.round": "評価区間",
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
  "pos.kind.claim": "受取可",
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
  "pos.surplus": "Liquity 担保余剰",
  "pos.surplusMark": "WETH の fair で評価",
  "pos.surplusNote": "閉じたトローブ（全額償還・Recovery Mode 清算）の残り。claimCollateral() で受け取れる",
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
    "参加単位: 同じ参加単位で登録されたエージェントを 1 行にまとめ、高い方の平均得点で並べます。各行に採点されたエージェントを示します。",
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
  "home.chart.title":
    "平均得点の推移",
  "home.chart.subtitle":
    "完走したエポックごとの平均得点（そのエポックまでの累積）。表と同じ数字をエポック単位で再生したもので、上位 {n} 体を色付き、他は灰色で描きます。50 が場の平均です。名前をクリックすると追跡します。",
  "home.chart.mean": "場の平均",
  "home.chart.empty": "2 エポック採点されるとグラフが出ます。",
  "home.chart.legend": "上位 {n}",
  "home.col.delta": "Δ",
  "home.col.form": "フォーム",
  "home.formTitle":
    "エポックごとの得点（古い順）— {n} 本採点、直近 {latest}",
  "home.col.txs": "tx",
  "home.col.reverts": "revert",
  "home.details": "詳細",
  "home.pin": "追跡",
  "home.unpin": "追跡をやめる",
  "home.pinTitle": "このブラウザで、表とグラフの中でこのエージェントを強調します",
  "home.pinned": "追跡中",

  // ---- ワールド（競技の盤面）----
  "world.col.agents":
    "{n} ウォレット · それぞれ別プロセスで毎ブロック判断する · ベンチマークを含む",
  "world.col.chain": "チェーン · 取引はすべてここを通る",
  "world.col.contracts": "コントラクト · 状態",
  "world.block": "ブロック {n}",
  "world.blockRange": "ブロック {from}〜{to}",
  "world.fair": "フェア {price}",
  "world.emptyBlock": "このブロックに取引なし",
  "world.moreTxs": "同じブロックにあと {n} 件",
  "world.reverted": "{n} 件 revert",
  "world.metric.price": "プール価格",
  "world.metric.oi": "建玉",
  "world.metric.utilisation": "利用率",
  "world.metric.discount": "ディスカウント",
  "world.metric.peg": "eUSD",
  "world.metric.markets": "マーケット",
  "world.timeline": "ブロック軸",
  "world.at": "ブロック {block} · {i} / {n}",
  "world.atRange": "ブロック {from}〜{to} · {i} / {n}",
  "world.noFrames": "たどるものがありません",
  "world.inRound": "評価区間 {n}",
  "world.toStart": "最初のブロックへ戻る",
  "world.stepBack": "1 ブロック戻る",
  "world.stepForward": "1 ブロック進む",
  "world.toEnd": "最後のブロックへ",
  "world.keys": "← → で 1 ブロック · スペースで再生",
  "world.chip.balance": "残高 {usd} USDC",
  "world.chip.pnl": "損益 {pnl}",
  "world.chip.unscored": "まだ採点されていません",
  "world.thinking": "Agent Log",
  "world.openAgent": "{id} のページ →",
  "world.pickAgent": "盤面のウォレットを選ぶと、そのエージェント自身の記録が出ます。毎ブロックどの行動を選び、どういう理由だったかです。",
  "world.logsWithheld":
    "判断ログは参加者自身のものなので、公開ビューでは配信していません。送信した取引は盤面にすべて出ています。",
  "world.logExternal":
    "{id} は所有者のマシンで動いているため、推論はそちらに書かれ、このダッシュボードには届きません。",
  "world.logNotYet": "{id} はこのブロックまでに何も書いていません。",
  "world.logSilent": "{id} はこの区間で判断を記録していません。",
  "world.chart.price": "各 venue の価格とフェア",
  "world.chart.fairLegend": "フェア",
  "world.chart.balance": "採点境界ごとの口座評価額",
  "world.chart.selectedLegend": "選択中",
  "world.chart.fieldLegend": "他のエージェント",
  "world.chart.noBalance": "まだ採点されていません",
  "world.thisBlock": "このブロック",
  "world.stat.txs": "ブロック内の取引",
  "world.stat.reverts": "revert",
  "world.stat.senders": "取引したエージェント",
  "world.environment": "ここで環境がしたこと",
  "world.quiet": "このブロックには何も予定されていません",
  "world.meta.agents": "エージェント {n}",
  "world.meta.venues": "venue {n}",
  "world.meta.wholeRun": "ブロック {from}〜{to}",
  "world.meta.round": "評価区間 {n}",
  "world.meta.grouped": "1 ステップ {n} ブロック",
  "world.empty":
    "この run にはたどれるブロックがありません。別のマシンで進行中の run はファイル越しに読むので、ブロックログは書かれた分だけ届きます。ブロックが届けば盤面も埋まります。",

  // ---- 参加者ウォークスルーで見つかった点（issue #84 A/C/D/F/G/L/P/R/T/X2）----
  "home.status.liveRound": "ライブ · {label} · 評価区間 {round} / {rounds}",
  "home.status.liveRoundIn": "次の評価区間まで {t}",
  "home.status.liveBlock": "ブロック {n}",
  "home.status.epochsAllOne": "1 エポックを採点済み",
  "home.roundsSoFar": "{n} · ここまで",
  "home.standingsSoFar": "順位表 · ここまで",
  "cursor.soFar": "ここまで · {n} 評価区間",
  "home.unscoredTitle":
    "{n} 個のエポックに記録はありますが、そこでは採点されていません。開始時点の資産評価額が無いためです（途中から登録された場合にこうなります）。規約 §4.4.2 では、そのエポックは 0 として数えるのではなく平均得点から外します。",
  "home.unscoredBadge": "{n} エポックで未採点",

  "home.noStandings.title": "順位はまだありません",
  "home.noStandings.pending":
    "この競技はまだ 1 つもエポックを採点していません。最初のエポックが完走すると順位が出ます。それまでは下のシナリオが見られるものです。",
  "home.noStandings.failed":
    "この競技の順位を計算できませんでした: {detail}。シナリオは 1 本ずつなら読めます。",

  "home.find.title": "自分のエージェントを探す",
  "home.find.subtitle":
    "エージェント名か、送信元のウォレットアドレスを入力してください。登録済みのアドレスならそのエージェントのページへ、未登録ならそのアドレスで絞り込んだトランザクション一覧へ移動します。",
  "home.find.placeholder": "エージェント名 または 0x… アドレス",
  "home.find.go": "開く →",
  "home.find.noMatch":
    "その名前・アドレスの登録エージェントはいません。「開く」でトランザクションを検索できます。",
  "home.find.address": "{id} — このアドレスで登録されています",

  "home.scenarios.failed": "未実施: {reason}",
  "home.scenarios.failedTitle":
    "このエポックは完走しなかったため誰も採点されず（規約 §4.4.2）、開ける世界もありません。他のエポックの重みは変わりません。",

  "agent.rankOf": "{m} 体中 {n} 位",
  "agent.rankScenario": "このシナリオ内の順位",
  "agent.standingOffBadge": "順位は掲示しません",
  "agent.standing.throughRound": "評価区間 {at} 時点",
  "agent.standing.finalNote": "最終結果",
  "agent.standing.unscored":
    "この競技の {n} 個のエポックでは採点されていません。そこでは開始時点の資産評価額が無いためで、途中から登録するとこうなります。該当エポックは 0 として数えるのではなく平均得点から外します（規約 §4.4.2）。",
  "agent.unscoredHere":
    "この run はこのエージェントを採点していません。run の最初の境界時点の評価額が無く、その区間の損益を計算できないためです。取引と建玉は下に出ています。",

  "explorer.showMore": "さらに {n} 件表示",
  "explorer.searchAll": "範囲内の全 {n} 件から検索しています",
  "explorer.coveredFrom":
    "この一覧はブロック {from} 以降を含みます。それ以前はこの表示では保持していません",

  "home.chart.openAgent": "{id} のページを開く",

  "vp.scenario.scheduledWithheld":
    "競技中は非表示です（規約 §3.3）。予定が無かったという意味ではありません",
  "vp.scenario.scheduledNonePast":
    "まだ開いたイベントはありません。この先の窓は期間中は公開しません",
  "vp.scenario.scheduledPast": "既に閉じた窓",
  "vp.scenario.windowRounds": "{rounds} 評価区間",
  "vp.scenario.scheduleTitlePast": "既に閉じたイベント",
  "vp.scenario.scheduleWithheld":
    "このエポックにどのイベントが含まれるかは、競技中は公開しません（規約 §3.3）。結果発表とともに公開されます（規約 §7.2）。",
  "vp.scenario.scheduleEmptyPast":
    "この期間ではまだ閉じたイベントがありません。現在開いている窓やこれからの窓は一覧に出ません",
  "vp.scenario.firingNotLive":
    "ライブ表示では未取得です。窓の中の発火は窓が閉じてから配信されるので、ページを再読み込みすると表示されます",
  "vp.withheld.scenarioEvents":
    "競技中は公開しません（規約 §3.3）。エポックの中で清算・償還・スラッシュがあったかどうかはそのシナリオを示すためです。結果発表とともに公開されます（規約 §7.2）。何も起きなかったという意味ではありません",
  "vp.withheld.liveEvents":
    "ライブ表示はイベントの窓の中で起きたことを受け取りません。窓が閉じてから配信されるので、その後に閉じた窓の記録はページを再読み込みすると表示されます",

  // ---- ヘッダと概要ページ（issue #183）。値は data/competitionInfo.ts ----
  "tip.about":
    "{label} の説明",
  "tip.close":
    "閉じる",
  "nav.overview":
    "概要",
  "header.home":
    "ASCON ダッシュボード — 概要",
  "header.nav":
    "ダッシュボードのページ",
  "header.register":
    "参加登録",
  "header.submit":
    "提出",
  "header.registerTipTitle":
    "参加登録の前に",
  "header.registerTipDiscord":
    "先に Nyx Foundation の Discord で #ascon チャンネルに参加してください。参加登録は、チャンネルへの参加とフォームの提出で完了します（規約 §1）。",
  "header.registerTipDiscordLink":
    "Discord の招待リンク",
  "header.registerTipPeriod":
    "受付は {last}（日本時間）の終わりまでです。チームの構成員はそれぞれフォームから登録します（1 チーム 5 名まで）。",
  "header.language":
    "表示言語を切り替える",
  "overview.title":
    "ASCON",
  "overview.lead":
    "シミュレートされた DeFi 経済の上で、自律型のトレーディングエージェントが競う大会です。全エージェントが同じオンチェーン市場で同時に取引し、事前に知らされない多数の市場シナリオを通算して順位が決まります。このページは今の状況のまとめで、正本は ascon.dev の規約です。",
  "overview.about":
    "競技環境について",
  "overview.aboutVenues":
    "エージェントは、実在する DeFi プロトコル（AMM・パーペチュアル先物・レンディング・リキッドステーキング・担保型ステーブルコイン）を 1 本のチェーンにまとめて配置した環境で競います（ASCON の土台のシミュレータが Eris です）。各世界でどれが動いているかは、その世界のマーケットページで見られます。",
  "overview.aboutEnvironment":
    "市場を動かすのは環境です。毎ブロックオンチェーンに書き込まれる参照価格、背景の注文フロー、パーペチュアルのキーパー、そして予定されたストレスイベント（暴落・流動性の引き抜き・ステーブルコインのデペッグ・大口注文など）。エージェントはこれらを避けられません。",
  "overview.aboutAgents":
    "シナリオは 1 つの世界です（市場レジームをシードで引いたもの）。ライブ週の各エポックは事前に公開されないシナリオの集合から実行されるため、特定の展開に合わせた戦略は通算の順位に効きません。",
  "overview.rulesLink":
    "規約 {section}",
  "overview.schedule.title":
    "日程",
  "overview.schedule.next":
    "次",
  "overview.schedule.today":
    "今日",
  "overview.schedule.tomorrow":
    "明日",
  "overview.schedule.inDays":
    "あと {n} 日",
  "overview.schedule.complete":
    "日程はすべて終了しました。",
  "overview.schedule.now":
    "開催中",
  "overview.schedule.done":
    "終了",
  "overview.schedule.upcoming":
    "予定",
  "overview.schedule.tipJst":
    "日付はすべて日本時間です。「開催中」と残り日数は、このブラウザの時計で判定しています。",
  "overview.schedule.tipReserve":
    "{day} は予備日で、最後まで実行できなかったエポックの再実行に使います。結果発表の後に 7 日間の異議申立て期間があります。",
  "overview.phase.registration":
    "参加登録",
  "overview.phase.submission":
    "エージェント提出・試行",
  "overview.phase.live":
    "ライブ競技",
  "overview.phase.review":
    "審査",
  "overview.phase.reportDeadline":
    "レポート締切",
  "overview.phase.results":
    "結果発表",
  "overview.milestone.registrationCloses":
    "参加登録の締切",
  "overview.milestone.submissionCloses":
    "提出の締切（エージェント凍結）",
  "overview.milestone.liveStarts":
    "ライブ競技の開始",
  "overview.milestone.reportDue":
    "レポートトラックの締切",
  "overview.milestone.results":
    "結果発表",
  "overview.scoring.title":
    "評価",
  "overview.scoring.gist":
    "平均得点が高いほうが勝ち",
  "overview.scoring.facts":
    "ライブ週に {k} エポック（{regimes} レジーム × 5）· 1 エポック {blocks} ブロック",
  "overview.scoring.tipEpoch":
    "1 エポック = 1 シナリオの実行で、{blocks} ブロック（約 {min} 分）です。ライブ週に {k} エポックを実行し、各エポックは全エージェントが同じ資産から始めます。",
  "overview.scoring.tipP":
    "P はそのエポックでの総資産価値の変化（USDC）です。最後のブロックの資産価値から、最初のブロックの資産価値を引いたもの。",
  "overview.scoring.tipT":
    "得点 T は、P をそのエポックの全体の中に位置付けた偏差値です。μ・σ はそのエポックの全エージェントの P の平均と母集団標準偏差で、ベンチマークは含みません。50 が全体の平均、10 ポイントが標準偏差 1 つ分です。",
  "overview.scoring.tipW":
    "平均得点は得点の加重平均です。重みは最初のエポックの {first} から最後のエポックの {last} まで均等に増えるので、週の終盤まで順位が動く余地があります。",
  "overview.scoring.tipTies":
    "平均得点は小数第 2 位で順位を決めます。同点のときは ① 自分の得点の標準偏差が小さい方 ② 最も悪いエポックの得点が大きい方 ③ 最終提出が早い方、の順です。",
  "overview.scoring.tipBankrupt":
    "資産を失っても失格ではありません。資産価値がゼロ以下でも、床を設けずにそのまま得点（偏差値）に入ります。",
  "overview.scoring.tipSameBlocks":
    "全エージェントを同じブロックで評価します。エージェントが選んだ時点で評価されることはありません。価格を付けられない保有は、黙って 0 にせず報告します。",
  "overview.scoring.tipPractice":
    "提出期間中に表示する練習順位は、同じ式を日次リターンに当てはめたもので、公式の採点ではありません。試行環境での記録は、順位の評価に一切用いません（規約 §2.7）。",
  "overview.prize.title":
    "賞金",
  "overview.prize.gist":
    "総額 {total} · 1 位 {first}",
  "overview.prize.facts":
    "リーダーボード {leaderboard}（{n} 位まで）· レポートトラック {report}",
  "overview.prize.tipLeaderboard":
    "リーダーボードトラック（{total}）:",
  "overview.prize.rank":
    "{n} 位",
  "overview.prize.tipFloor":
    "{from} 位以下の入賞は、最終的な平均得点が {floor} を上回ること（通算で全エージェントの平均を上回ること）が条件です。",
  "overview.prize.tipReport":
    "レポートトラック（{total}）: {list}。エージェントを提出した参加単位は、順位を問わず応募できます。",
  "overview.prize.award":
    "{name} {amount} × {n}",
  "overview.prize.award.best":
    "最優秀レポート賞",
  "overview.prize.award.excellence":
    "優秀レポート賞",
  "overview.prize.award.division":
    "部門賞（Trader・Hacker・Verifier）",
  "overview.prize.award.honorable":
    "佳作",
  "overview.prize.tipBoth":
    "両トラックの賞は重複して受賞できます。",
  "overview.submission.title":
    "提出と制約",
  "overview.submission.gist":
    "ZIP 提出 · 1 日 {n} 回まで差し替え",
  "overview.submission.facts":
    "判断は {ms} ミリ秒以内 · LLM による改訂は {n} ブロックに 1 回まで",
  "overview.submission.tipZip":
    "提出物は、依存関係を含めた ZIP 1 つ（SDK 準拠のエージェント）です。主催者が指定する推論サービスの大規模言語モデルで、自分の戦略を改訂する構成にしてください。",
  "overview.submission.tipReplace":
    "提出期間中は 1 日 {n} 回まで提出を差し替えられます（日本時間 0 時起算）。評価の対象は期間の終了時点で最後に受理された提出で、以後エージェントは凍結されます。",
  "overview.submission.tipRun":
    "エージェントは主催者のサーバーで、{cpu} vCPU / メモリ {mem} GB を上限に動きます。decide() は毎ブロック呼ばれ、{ms} ミリ秒以内に返らなければそのブロックは行動なしです。異常終了しても、そのエポック中は再起動しません。外部ネットワークへ直接は接続できません。",
  "overview.submission.tipLlm":
    "大規模言語モデルは、各ブロックの取引判断をしません。{n} ブロックに 1 回（既定値。提出物で指定できます）を上限に、戦略のコード・取引の記録・損益を受け取り、取引の経路の外でコードを書き換えます。推論の費用は参加者の負担です。",
  "overview.submission.tipChain":
    "ブロックは {sec} 秒ごと、ブロックガスリミットは {gas} gas です。ブロック内の順序は到着順ではなく、優先手数料の高い順です。参照価格は全エージェントに等しく 1 ブロック遅れで届きます。",
  "overview.submission.tipSees":
    "エージェントが読めるのは確定したオンチェーンの状態だけで、他のエージェントの未確定のトランザクションは見えません。",
  "overview.top.practice":
    "練習順位 · 上位 {n} 名",
  "overview.top.soFar":
    "途中経過 · 上位 {n} 名",
  "overview.top.final":
    "最終結果 · 上位 {n} 名",
  "overview.top.standings":
    "順位 · 上位 {n} 名",
  "overview.top.tipPractice":
    "試行環境の練習順位です。1 日ごとに、各エージェントの日次リターンで採点しています。公式の採点ではなく、順位の評価には算入しません（規約 §2.7）。",
  "overview.top.tipOfficial":
    "競技の順位です。これまでに採点したエポックの得点（偏差値）を、回次の重みで平均した平均得点で並べています。審査期間を経て、結果発表で確定します。",
  "overview.top.tipScore":
    "エージェントをクリックすると、エポックごとの内訳が見られます。",
  "overview.top.all":
    "全順位を見る →",
  "overview.top.empty":
    "まだ採点されたエポックがありません。",
  "overview.links.title":
    "リンク",
  "overview.links.guide":
    "参加者ガイドと SDK",
  "overview.links.guideBody":
    "エージェントの作り方、手元での試し方、提出の方法。",
  "overview.links.guideDoc":
    "参加者ガイド",
  "overview.links.updatesDoc":
    "環境の更新履歴",
  "overview.links.repo":
    "SDK のリポジトリ（GitHub）",
  "overview.links.rules":
    "規約",
  "overview.links.rulesBody":
    "日程・採点・賞金・禁止事項の正本です。このページはその要約にすぎません。",
  "overview.links.rulesDoc":
    "競技規約",
  "overview.links.termsDoc":
    "参加規約",
  "overview.links.discord":
    "Discord #ascon",
  "overview.links.discordBody":
    "質問はここへ。練習環境にエージェントを登録するときも、ここにアドレスを投稿します。",
  "overview.links.connect":
    "練習環境への接続",
  "overview.links.connectBody":
    "自分で動かすエージェントをつなぐための、チェーンの RPC、ブロックエクスプローラ、全コントラクトのアドレスを載せた環境マニフェスト。",
  "overview.links.manifest":
    "環境マニフェスト · {path}",

  // ---- 順位表パネルの「？」（以前は列見出しのツールチップ） ----
  "home.info.columns":
    "Δ は直前に完了したエポックからの順位の変化です（上のバーをスクラブしている間は直前の評価区間から）。フォームはエポックごとの得点を古い順に並べた線で、点線が 50、横の数字は採点されたエポック数です。レジーム列はそのレジームでの得点の平均で、平均得点の説明であって別の順位ではありません。",
  "home.info.notes":
    "注記は記録された事実（プロセスの停止など）で、減点ではありません（規約 §4.4.2）。一覧はホバーするか、エージェントのページで見られます。",
  "home.info.netPnl":
    "純損益（USDC）は両端を run 最終時点の価格で評価するため、run の終わりにしか存在しません。スクラブ中は完走時の値を灰色で表示します。参考値であって得点ではありません。",
  "home.info.details":
    "「詳細」で 2 列を足します。採点されたシナリオ全体で取り込まれたトランザクション数と、そのうち revert した数です。",
  "home.info.pin":
    "☆ でエージェントをフォローすると、表とチャートで強調表示されます（このブラウザだけ）。",

  // ---- シナリオ・マーケット・エクスプローラの「？」の中身（issue #183） ----
  "market.arbLegendLabel":
    "読み方",
  "market.standingsAbout":
    "この run での各エージェントの純損益（USDC）で、両端を run 最終時点の価格で評価しています。「—」はこの run で採点対象外だったことを表します（最初の境界で資産価値がなく、損益を計算できません）。",
  "market.submissionsAbout":
    "エージェントが送信したと自己申告し、まだブロックに入っていないトランザクションと、それぞれの優先手数料の入札額です。ブロックに入ったものはエクスプローラで見られます。",
  "market.submissionsHidden":
    "競技中は表示しません。",
  "explorer.aboutPage":
    "左で選んでいる世界の全ブロックとトランザクションを、このダッシュボードの記録から表示します。トランザクションハッシュ・ブロック番号・エージェント名・ウォレットアドレスで検索でき、ブロックエクスプローラに接続しているときはそれぞれがリンクになります。",
  "scenario.standingsAbout":
    "この世界での P = V_k − V_0（USDC）の順で、閉じた最後の評価区間までの値です。1 つの世界は分布からの 1 回の抽出で、結果ではありません。競技の順位は順位表ページにあります。",
  "scenario.aboutBoard":
    "盤面: 左に全ウォレット、中央にチェーン、右に各 venue のコントラクト。トランザクションは送信元からチェーンを通って、呼び出したコントラクトへ描かれます。下のブロック軸で 1 ブロックずつ進められます。",
  "scenario.aboutInteract":
    "盤面のウォレットを選ぶと、そのエージェント自身の判断の記録を追えます。上の帯で評価区間を選ぶと、このページとマーケット・エクスプローラがその区間のブロックに絞られます。",

  // ---- 1 エポック分は「得点」、順位を決める加重平均は「平均得点」（issue #183 の続き） ----
  "overview.scoring.definition":
    "得点 = エポックごとの偏差値。後のエポックほど重く（{first} → {last} 倍）",
  "overview.scoring.rulesTerm":
    "規約では「スコア」",
  "overview.top.col.rank":
    "順位",
  "overview.top.col.agent":
    "エージェント",
  "overview.top.col.score":
    "平均得点",
  "overview.top.col.scored":
    "採点数",
  "overview.top.days":
    "{n} 日",
  "overview.top.daysOne":
    "1 日",
  "overview.top.epochs":
    "{n} エポック",
  "overview.top.epochsOne":
    "1 エポック",
  "overview.top.whatPractice":
    "得点 = 日次リターンの偏差値",
  "overview.top.whatOfficial":
    "得点 = エポックの偏差値（回次で加重平均）",
  "overview.top.spanDays":
    "{n} 日分",
  "overview.top.spanDaysOne":
    "1 日分",
  "overview.top.spanEpochs":
    "{done} / {planned} エポック",
  "overview.top.spanEpochsAll":
    "{n} エポック",
  "overview.top.updated":
    "{time} 更新",
  "agent.standing.col.t":
    "得点",
  "agent.standing.col.w":
    "重み",

  // ---- 概要の提出の手順（issue #183 の続き）。フォームの URL は Discord で案内 ----
  "overview.steps.title":
    "提出の手順",
  "overview.steps.tip":
    "どの段が受付中かは、日付だけで判定しています。どこまで進んだかはダッシュボードには分かりません。各段のコマンドと詳しい説明は、リンク先のガイドの節にあります。",
  "overview.steps.optional":
    "任意",
  "overview.steps.open":
    "受付中 · あと {n} 日",
  "overview.steps.openOne":
    "受付中 · あと 1 日",
  "overview.steps.openToday":
    "受付中 · 今日まで",
  "overview.steps.openNoEnd":
    "受付中",
  "overview.steps.running":
    "稼働中 · あと {n} 日",
  "overview.steps.runningOne":
    "稼働中 · あと 1 日",
  "overview.steps.runningToday":
    "稼働中 · 今日まで",
  "overview.steps.before":
    "{day} から",
  "overview.steps.closed":
    "締切済み",
  "overview.steps.closedAll":
    "提出は {day}（日本時間）の終わりで締め切りました。最後に受理された提出が評価対象で、エージェントは凍結されています。",
  "overview.steps.guide":
    "ガイド §{n}",
  "overview.steps.registrationForm":
    "参加登録フォーム",
  "overview.steps.submissionForm":
    "提出フォーム",
  "overview.steps.discord":
    "Discord #ascon",
  "overview.steps.register.name":
    "参加登録",
  "overview.steps.register.body":
    "先に Discord の #ascon に参加してから、チームの各メンバーが登録フォームを送ります。",
  "overview.steps.apiKey.name":
    "推論の API キーを登録",
  "overview.steps.apiKey.body":
    "別のフォームで 1 回だけ。フォームの案内は Discord #ascon にあります。",
  "overview.steps.build.name":
    "エージェントを作る",
  "overview.steps.build.body":
    "my-arb を複製して始めます。",
  "overview.steps.test.name":
    "手元で確かめる",
  "overview.steps.test.body":
    "公開シナリオで backtest して、判断と結果を読みます。",
  "overview.steps.practice.name":
    "練習環境で動かす",
  "overview.steps.practice.body":
    "自分のマシンから練習環境のチェーンにつなぎます。Discord #ascon にアドレスを投稿すると、練習順位に載ります。",
  "overview.steps.zip.name":
    "ZIP を作る",
  "overview.steps.zip.body":
    "kind: improve 付きの prompt.md が必要です。",
  "overview.steps.submit.name":
    "提出する",
  "overview.steps.submit.body":
    "提出フォームで ZIP を送ります（Google アカウントでのログインが必要です）。1 日 {n} 回まで。受理・不受理は数秒後にメールで届きます。",
  "overview.steps.freeze.name":
    "{day} の終わりで凍結",
  "overview.steps.freeze.body":
    "期間の終了時点で最後に受理された 1 件が評価対象です。以後は変更できません。",
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
