// On-chain evidence for the self-improvement loop (issue #76).
//
// The loop used to revise on a snapshot: two PnL numbers, twelve bare decisions and the latest
// observation. Everything here exists because a model given that cannot tell three different
// failures apart -- a window it never saw open, transactions that never landed, and an edge that
// does not cover the round trip all arrive as the same dip. So the tests are about whether the
// difference survives into the context, not about the formatting.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentObservation } from "@eris/sdk/types.js";
import {
  digestMarketHistory,
  digestTrades,
  MarketHistory,
  sampleObservation,
  TradeLedger,
  marketMoveUsdc,
  VALUE_MARK_DELAY_BLOCKS,
} from "../example/agents/runtime/evidence.js";
import {
  buildRevisionContext,
  loadImproveAgent,
} from "../example/agents/runtime/improve.js";

type ObsOpts = {
  block: number;
  fairWeth?: number;
  uniWeth?: number;
  curveWeth?: number;
  fairWbtc?: number;
  uniWbtc?: number;
  value?: number;
  dai?: { priceUsdc: number; marketQuoted?: boolean };
  eusd?: { priceUsdc: number; marketQuoted?: boolean };
  lstDiscountBps?: number;
  eusdDiscountBps?: number;
  // Spot holdings in whole units. Sets the raw fields the sampler reads (wethWei / baseBalances /
  // baseDecimals), because that is the shape a real observation has.
  holdings?: { WETH?: number; WBTC?: number };
};

// Only the fields the sampler reads. Cast at the boundary: an AgentObservation carries thirty
// fields none of which change what is under test, and spelling them out would hide the four that do.
function obs(o: ObsOpts): AgentObservation {
  const fair = o.fairWeth ?? 3000;
  return {
    round: o.block,
    fairPriceUsdcPerWeth: fair,
    ...(o.fairWbtc !== undefined
      ? { fairPricesUsd: { WETH: fair, WBTC: o.fairWbtc } }
      : {}),
    inventory: { valueUsdc: o.value ?? 25_000 },
    ...(o.holdings
      ? {
          baseBalances: {
            ...(o.holdings.WETH !== undefined
              ? { WETH: BigInt(Math.round(o.holdings.WETH * 1e18)).toString() }
              : {}),
            ...(o.holdings.WBTC !== undefined
              ? { WBTC: BigInt(Math.round(o.holdings.WBTC * 1e8)).toString() }
              : {}),
          },
          baseDecimals: { WETH: 18, WBTC: 8 },
        }
      : {}),
    balances: {
      ...(o.holdings?.WETH !== undefined
        ? {
            ethWei: "0",
            wethWei: BigInt(Math.round(o.holdings.WETH * 1e18)).toString(),
          }
        : {}),
      stables: {
        USDC: { priceUsdc: 1, marketQuoted: false },
        ...(o.dai
          ? {
              DAI: {
                priceUsdc: o.dai.priceUsdc,
                marketQuoted: o.dai.marketQuoted !== false,
              },
            }
          : {}),
        ...(o.eusd
          ? {
              EUSD: {
                priceUsdc: o.eusd.priceUsdc,
                marketQuoted: o.eusd.marketQuoted !== false,
              },
            }
          : {}),
      },
    },
    protocols: {
      ...(o.uniWeth !== undefined || o.uniWbtc !== undefined
        ? {
            uniswap: {
              ...(o.uniWeth !== undefined
                ? { pool: { priceUsdcPerWeth: o.uniWeth } }
                : {}),
              ...(o.uniWbtc !== undefined
                ? { markets: { WBTC: { priceUsdcPerWeth: o.uniWbtc } } }
                : {}),
            },
          }
        : {}),
      ...(o.lstDiscountBps !== undefined
        ? { lst: { discountBps: o.lstDiscountBps, marketQuoted: true } }
        : {}),
      ...(o.eusdDiscountBps !== undefined
        ? { liquity: { discountBps: o.eusdDiscountBps, marketQuoted: true } }
        : {}),
      ...(o.curveWeth !== undefined
        ? {
            curve: {
              priceUsdcPerWeth: o.curveWeth,
              effectiveHalfSpreadBps: 12,
            },
          }
        : {}),
    },
  } as unknown as AgentObservation;
}

test("sampleObservation: every venue's gap is measured against that base's fair price", () => {
  // ADR 0013 put the non-WETH markets in a side map. A sampler that reads only the WETH pool is
  // blind to exactly the bases where the gaps live -- the thin ones distort further and stay
  // distorted longer.
  const s = sampleObservation(
    obs({
      block: 10,
      fairWeth: 3000,
      uniWeth: 3006,
      curveWeth: 2994,
      fairWbtc: 60_000,
      uniWbtc: 60_600,
    }),
  );
  assert.equal(s.block, 10);
  assert.equal(Math.round(s.venues["uniswap:WETH"].gapBps), 20);
  assert.equal(Math.round(s.venues["curve:WETH"].gapBps), -20);
  assert.equal(Math.round(s.venues["uniswap:WBTC"].gapBps), 100);
  // The venue quoted its own round-trip cost; an edge below twice this is fee bleed however wide
  // the gap looks, so it has to survive into the digest.
  assert.equal(s.venues["curve:WETH"].halfSpreadBps, 12);
});

test("sampleObservation: a venue with no fair price to compare against is not invented", () => {
  // A gap needs a reference. Reporting one against a missing fair price would put a number in front
  // of the model that means nothing, which is worse than reporting nothing.
  const s = sampleObservation(obs({ block: 1, fairWbtc: undefined, uniWbtc: 60_000 }));
  assert.equal(s.venues["uniswap:WBTC"], undefined);
});

test("MarketHistory: a ring the length of the revision interval, and one entry per block", () => {
  const history = new MarketHistory(3);
  for (const block of [1, 2, 3, 4]) history.push(obs({ block }));
  assert.equal(history.size, 3);
  assert.deepEqual(
    history.since(null).map((s) => s.block),
    [2, 3, 4],
  );
  // The block watcher can re-fire the same block on a reconnect. A duplicate would double-count
  // every bucket the digest reports.
  history.push(obs({ block: 4 }));
  assert.equal(history.size, 3);
  assert.deepEqual(
    history.since(3).map((s) => s.block),
    [3, 4],
  );
});

test("digestMarketHistory: a depeg window is reported with its edges, not just its latest price", () => {
  // This is the case the whole issue is about. Before, the model saw "DAI is 0.9990 now" at the
  // moment of the revision and could not tell whether the window had opened, how deep it went, or
  // whether it was still open.
  const history = new MarketHistory(64);
  history.push(obs({ block: 100, dai: { priceUsdc: 1.0 } }));
  history.push(obs({ block: 101, dai: { priceUsdc: 0.991 } }));
  history.push(obs({ block: 102, dai: { priceUsdc: 0.982 } }));
  history.push(obs({ block: 103, dai: { priceUsdc: 0.9995 } }));
  const text = digestMarketHistory(history.since(null)).join("\n");
  assert.match(text, /blocks 100\.\.103 \(4 observed\)/);
  assert.match(
    text,
    /DAI: outside b101\.\.b102 \(2 blocks\), worst -180\.0 bps \(0\.9820\) @b102/,
  );
  assert.match(text, /back inside/);
});

test("digestMarketHistory: a window that has not closed says so", () => {
  const history = new MarketHistory(64);
  history.push(obs({ block: 200, dai: { priceUsdc: 1 } }));
  history.push(obs({ block: 201, dai: { priceUsdc: 0.97 } }));
  const text = digestMarketHistory(history.since(null)).join("\n");
  assert.match(text, /STILL OUTSIDE/);
});

test("digestMarketHistory: an unquoted stable does not close a window it never closed", () => {
  // `marketQuoted: false` is par by convention or by fallback, not an observation. Reading it as
  // "back at par" would report a recovery the market never made.
  const history = new MarketHistory(64);
  history.push(obs({ block: 300, dai: { priceUsdc: 0.97 } }));
  history.push(obs({ block: 301, dai: { priceUsdc: 1, marketQuoted: false } }));
  history.push(obs({ block: 302, dai: { priceUsdc: 0.96 } }));
  const text = digestMarketHistory(history.since(null)).join("\n");
  // Two windows, not one recovery in the middle: the quiet block is absent from both.
  assert.match(text, /outside b300\.\.b300/);
  assert.match(text, /outside b302\.\.b302/);
});

test("digestMarketHistory: gaps are counted into buckets, because the runtime does not know the threshold", () => {
  // A single threshold would have to be the strategy's own and the runtime cannot see it. The
  // ladder lets a strategy that fires at 10 bps read its own threshold off the counts -- and lets
  // one that should move it see that too.
  const history = new MarketHistory(64);
  history.push(obs({ block: 1, fairWeth: 3000, uniWeth: 3000.3 })); // 1 bps
  history.push(obs({ block: 2, fairWeth: 3000, uniWeth: 3006 })); // 20 bps
  history.push(obs({ block: 3, fairWeth: 3000, uniWeth: 3021 })); // 70 bps
  const text = digestMarketHistory(history.since(null)).join("\n");
  // over 5 / 10 / 25 / 50 bps out of 3 samples
  assert.match(text, /uniswap:WETH: .*— over: 2\/2\/1\/1/);
  assert.match(text, /blocks with \|gap\| over 5\/10\/25\/50 bps of 3/);
});

test("TradeLedger: a decision is joined to inclusion latency, ordering and what it was worth after", () => {
  // The three faults behind "the arbitrage does not win" are late, reverted, and edge below the
  // round trip. Each has a different fix and only the last one is a threshold change.
  const ledger = new TradeLedger();
  ledger.submitted({ hash: "0xa", decidedAtBlock: 40, actionType: "swap", base: "WETH" });
  ledger.resolved("0xa", { status: "success", txIndex: 7, blockNumber: 42 });
  ledger.mark(42, 25_000);
  ledger.mark(42 + VALUE_MARK_DELAY_BLOCKS, 24_990);

  const agg = ledger.aggregate(null);
  assert.equal(agg.sent, 1);
  assert.equal(agg.included, 1);
  assert.equal(agg.reverted, 0);
  assert.equal(agg.meanInclusionLatencyBlocks, 2);
  assert.equal(agg.meanTxIndex, 7);
  assert.equal(agg.rawValueDeltaUsdc, -10);

  const outcomes = ledger.outcomesByBlock(null).get(40);
  assert.ok(outcomes);
  assert.match(outcomes[0], /swap WETH: included @\+2 idx 7, value -10\.00 after 3b/);
});

test("TradeLedger: a revert is a different fault from a miss, and reads as one", () => {
  const ledger = new TradeLedger();
  ledger.submitted({ hash: "0xb", decidedAtBlock: 10, actionType: "swap" });
  ledger.resolved("0xb", { status: "reverted", txIndex: 3, blockNumber: 11 });
  ledger.submitted({ hash: "0xc", decidedAtBlock: 12, actionType: "swap" });
  const agg = ledger.aggregate(null);
  assert.equal(agg.reverted, 1);
  assert.equal(agg.pending, 1);
  assert.match(ledger.outcomesByBlock(null).get(10)![0], /reverted @\+1 idx 3/);
  assert.match(ledger.outcomesByBlock(null).get(12)![0], /not mined yet/);
});

test("TradeLedger: gas refills are the runtime's housekeeping, not the strategy's trades", () => {
  // Counting them would put a revert rate on a decision the strategy never made. send.ts excludes
  // them from the competition signal for exactly the same reason.
  const ledger = new TradeLedger();
  ledger.submitted({ hash: "0xd", decidedAtBlock: 5, actionType: "gasRefillUnwrap" });
  ledger.resolved("0xd", { status: "reverted", blockNumber: 6 });
  assert.equal(ledger.aggregate(null).sent, 0);
  assert.match(digestTrades(ledger.aggregate(null))[0], /none were sent/);
});

test("TradeLedger: the interval is what is aggregated, not the run", () => {
  const ledger = new TradeLedger();
  ledger.submitted({ hash: "0xe", decidedAtBlock: 10, actionType: "swap" });
  ledger.submitted({ hash: "0xf", decidedAtBlock: 70, actionType: "swap" });
  assert.equal(ledger.aggregate(60).sent, 1);
  assert.equal(ledger.aggregate(null).sent, 2);
});

test("buildRevisionContext: the interval reaches the model, not only the instant", () => {
  const history = new MarketHistory(64);
  history.push(obs({ block: 60, fairWeth: 3000, uniWeth: 3000, dai: { priceUsdc: 1 } }));
  history.push(obs({ block: 61, fairWeth: 3000, uniWeth: 3030, dai: { priceUsdc: 0.98 } }));
  history.push(obs({ block: 62, fairWeth: 3000, uniWeth: 3000, dai: { priceUsdc: 1 } }));

  const ledger = new TradeLedger();
  ledger.submitted({ hash: "0x1", decidedAtBlock: 61, actionType: "swap" });
  ledger.resolved("0x1", { status: "reverted", txIndex: 9, blockNumber: 63 });

  const context = buildRevisionContext({
    block: 120,
    valueUsdc: 24_900,
    initialValueUsdc: 25_000,
    sinceLastRevisionUsdc: -100,
    currentVersion: 1,
    history: [],
    recent: [{ round: 61, action: { type: "swap" }, reason: "30bps gap" }],
    observation: null,
    sinceBlock: 60,
    market: history.since(60),
    trades: ledger.aggregate(60),
    outcomes: ledger.outcomesByBlock(60),
  });

  // The old sections are still there -- this is an addition, not a replacement.
  assert.match(context, /PnL since the run started: -100\.00/);
  assert.match(context, /PnL since the last revision: -100\.00/);
  // The trajectory: the window opened at 61 and closed, which "DAI is 1.0 now" cannot say.
  assert.match(context, /DAI: outside b61\.\.b61/);
  assert.match(context, /uniswap:WETH: .*100\.0 @b61/);
  // Attribution: the swap was not a bad threshold, it reverted two blocks late.
  assert.match(context, /1 sent = 0 succeeded \+ 1 mined-but-reverted \+ 0 never mined/);
  assert.match(context, /block 61: \{"type":"swap"\} — 30bps gap \[swap: reverted @\+2 idx 9\]/);
  assert.match(context, /since the last revision at block 60/);
});

test("buildRevisionContext: with no evidence yet it degrades to what it always said", () => {
  // The first revision of a run, and any participant runtime that does not collect the history,
  // must still get a usable context rather than a page of empty headings.
  const context = buildRevisionContext({
    block: 60,
    valueUsdc: 25_000,
    initialValueUsdc: 25_000,
    sinceLastRevisionUsdc: null,
    currentVersion: 0,
    history: [],
    recent: [{ round: 59, reason: "no gap" }],
    observation: null,
  });
  assert.match(context, /block 59: no action — no gap/);
  assert.doesNotMatch(context, /market history/);
  assert.doesNotMatch(context, /transactions since the last revision/);
});

test("every bundled prompt.md loads, and names the evidence it is told to read", () => {
  // The prompts were the other half of issue #76: the runtime can collect all the evidence it likes
  // and the model will still answer "leave it alone" if nothing tells it where to look. This also
  // guards the `kind: improve` marker across all of them, which is the only thing separating an
  // improvement policy from a retired per-decision prompt.
  const agentsDir = fileURLToPath(new URL("../example/agents/", import.meta.url));
  const dirs = readdirSync(agentsDir).filter((d) =>
    existsSync(join(agentsDir, d, "prompt.md")),
  );
  // peg-arb is the agent that trades the depeg regime, and it had no policy at all until #76 --
  // the one regime whose event is entirely diagnosable had no self-improving subject.
  assert.ok(dirs.includes("peg-arb"), "peg-arb has no prompt.md");
  for (const dir of dirs) {
    const agent = loadImproveAgent(join(agentsDir, dir));
    assert.equal(agent.name, dir, `${dir}: frontmatter name should be the directory`);
    for (const needle of [
      "transactions since the last revision",
      "market history",
      "mean inclusion latency",
      agent.language === "python" ? "executorPy" : "executorTs",
      "revertTo",
    ])
      assert.ok(
        agent.body.includes(needle),
        `${dir}/prompt.md does not mention ${needle}`,
      );
    // The automatic rollback was removed in ADR 0018 §5. A prompt that still promises one is
    // telling the model a speculative rewrite is free, which is exactly backwards.
    assert.ok(
      !/rolled back automatically/.test(agent.body),
      `${dir}/prompt.md still promises an automatic rollback`,
    );
  }
});


test("digestMarketHistory: a premium and a discount are told apart, because the sign survives", () => {
  // eUSD can sit above par as well as below, and the two mean opposite things: below is a
  // redemption worth taking, above is underwriting at a price the liquidation discount has to earn
  // back first. An unsigned "worst 1.0150" cannot say which.
  const history = new MarketHistory(64);
  history.push(obs({ block: 10, dai: { priceUsdc: 1.02 } }));
  const text = digestMarketHistory(history.since(null)).join("\n");
  assert.match(text, /worst 200\.0 bps \(1\.0200\)/);
  assert.match(text, /negative is below a dollar/);
});

test("digestMarketHistory: the LST and CDP discounts are series too, not only the stables", () => {
  // The first cut of this file sampled only the venues that quote a price against a fair price, so
  // lst-carry and redemption-arb were pointed at evidence the digest never produced.
  const history = new MarketHistory(64);
  history.push(obs({ block: 1, lstDiscountBps: 3, eusdDiscountBps: 2 }));
  history.push(obs({ block: 2, lstDiscountBps: 140, eusdDiscountBps: 90 }));
  const text = digestMarketHistory(history.since(null)).join("\n");
  assert.match(text, /lst:market-vs-redemption: open b2\.\.b2 \(1 blocks\), widest 140\.0 bps @b2/);
  assert.match(text, /liquity:EUSD-vs-par: open b2\.\.b2 .* — STILL OPEN/);
});

test("digestMarketHistory: the round-trip cost reported is the widest of the interval", () => {
  // Curve's dynamic fee moves. Reporting the latest half-spread lets a calm final block understate
  // a cost that was double for most of the window, which is how fee bleed reads as a threshold
  // problem.
  const history = new MarketHistory(64);
  history.push(obs({ block: 1, curveWeth: 3000 }));
  const text = digestMarketHistory(history.since(null)).join("\n");
  assert.match(text, /round trip cost up to 24\.0 bps here/);
});

test("TradeLedger: the gap a trade was decided on is carried next to what it earned", () => {
  // "I fired at 30 bps and it netted -3 USDC" is the fee-bleed diagnosis. Without the quoted gap the
  // model can see the loss and not what the strategy thought it was buying.
  const history = new MarketHistory(64);
  history.push(obs({ block: 20, fairWeth: 3000, uniWeth: 3009 })); // 30 bps
  const ledger = new TradeLedger({
    gapAt: (block, protocol, base) => history.gapAt(block, protocol, base),
  });
  ledger.submitted({
    hash: "0x9",
    decidedAtBlock: 20,
    actionType: "swap",
    protocol: "uniswap",
  });
  ledger.resolved("0x9", { status: "success", txIndex: 1, blockNumber: 20 });
  ledger.mark(20, 25_000);
  ledger.mark(20 + VALUE_MARK_DELAY_BLOCKS, 24_997);
  const agg = ledger.aggregate(null);
  assert.equal(Math.round(agg.meanQuotedGapBps ?? 0), 30);
  assert.match(
    ledger.outcomesByBlock(null).get(20)![0],
    /decided on a 30\.0 bps gap/,
  );
  assert.match(
    digestTrades(agg).join("\n"),
    /mean gap the strategy fired on: 30\.0 bps/,
  );
});

test("digestTrades: mined and reverted are stated as a partition, not as two numbers to add", () => {
  const ledger = new TradeLedger();
  for (const [hash, status] of [
    ["0xa", "success"],
    ["0xb", "reverted"],
  ] as const) {
    ledger.submitted({ hash, decidedAtBlock: 1, actionType: "swap" });
    ledger.resolved(hash, { status, blockNumber: 2 });
  }
  ledger.submitted({ hash: "0xc", decidedAtBlock: 1, actionType: "swap" });
  const text = digestTrades(ledger.aggregate(null)).join("\n");
  assert.match(text, /3 sent = 1 succeeded \+ 1 mined-but-reverted \+ 1 never mined/);
  // And a trade that has not had time to settle is said to be missing from the value figure rather
  // than quietly absent from it.
  assert.match(text, /have not had 3 blocks to settle/);
});

test("MarketHistory: the buffer can be grown once the revision interval is known", () => {
  // The first block has to have somewhere to go before prompt.md has been parsed, and a buffer
  // shorter than the interval hands the model a window that stops before the event.
  const history = new MarketHistory(2);
  history.ensureCapacity(4);
  for (const block of [1, 2, 3, 4]) history.push(obs({ block }));
  assert.equal(history.size, 4);
  // Growing only: shrinking would drop samples the current interval still needs.
  history.ensureCapacity(1);
  history.push(obs({ block: 5 }));
  assert.equal(history.size, 4);
});


test("TradeLedger: a baseline taken long after inclusion is refused, not used", () => {
  // The block loop can miss a block under load. A baseline one block late is still a baseline;
  // five blocks late is the market, and attributing the market to a trade is exactly the confusion
  // the value delta exists to remove.
  const ledger = new TradeLedger();
  ledger.submitted({ hash: "0xlate", decidedAtBlock: 10, actionType: "swap" });
  ledger.resolved("0xlate", { status: "success", blockNumber: 11 });
  ledger.mark(20, 25_000);
  ledger.mark(23, 24_000);
  const agg = ledger.aggregate(null);
  assert.equal(agg.attributedTrades, 0);
  assert.equal(agg.rawValueDeltaUsdc, null);
  assert.match(
    digestTrades(agg).join("\n"),
    /the block they landed in was not observed/,
  );
});

test("TradeLedger: a baseline one block late is still a baseline", () => {
  // The bound is inclusive at includedAtBlock + VALUE_BASELINE_SLACK_BLOCKS. The block loop misses a
  // block under load often enough that refusing the very next one would throw away most of the
  // attribution the interval has.
  const ledger = new TradeLedger();
  ledger.submitted({ hash: "0x1b", decidedAtBlock: 10, actionType: "swap" });
  ledger.resolved("0x1b", { status: "success", blockNumber: 11 });
  ledger.mark(11 + 1, 25_000);
  ledger.mark(11 + 1 + VALUE_MARK_DELAY_BLOCKS, 25_050);
  const agg = ledger.aggregate(null);
  assert.equal(agg.attributedTrades, 1);
  assert.equal(agg.rawValueDeltaUsdc, 50);
});

test("TradeLedger: a quoted gap is only attributed to an action a venue gap was the reason for", () => {
  // `stableSwap` is a curve action and carries no base, so the naive lookup would hand it the WETH
  // pool's gap -- a number in front of the model that had nothing to do with the decision.
  const history = new MarketHistory(8);
  history.push(obs({ block: 5, fairWeth: 3000, uniWeth: 3030 }));
  const ledger = new TradeLedger({
    gapAt: (block, protocol, base) => history.gapAt(block, protocol, base),
  });
  ledger.submitted({
    hash: "0xstable",
    decidedAtBlock: 5,
    actionType: "stableSwap",
    protocol: "curve",
  });
  ledger.submitted({
    hash: "0xswap",
    decidedAtBlock: 5,
    actionType: "swap",
    protocol: "uniswap",
  });
  ledger.mark(5, 25_000);
  const agg = ledger.aggregate(null);
  // One of the two, not both, and the mean is that one's gap rather than an average over a
  // fabricated second reading.
  assert.equal(Math.round(agg.meanQuotedGapBps ?? 0), 100);
  assert.equal(agg.quotedOnRichVenue, 1);
  assert.equal(agg.quotedOnCheapVenue, 0);
});


test("buildRevisionContext: a version carried in from another epoch is not differenced against this one", () => {
  // Found in a live smoke run: a version installed at 25,000 USDC in a seeded epoch was rendered as
  // "-323,996.08 USDC vs the run start" against an epoch funded at ~349,000. Every epoch is funded
  // afresh, so the subtraction compares two different worlds and reads as a catastrophe that never
  // happened.
  const context = buildRevisionContext({
    block: 1245,
    valueUsdc: 343_527,
    initialValueUsdc: 349_000,
    sinceLastRevisionUsdc: null,
    currentVersion: 1,
    epochId: "this-epoch",
    epochs: ["last-epoch", "this-epoch"],
    history: [
      {
        version: 1,
        source: "return null;",
        notes: "carried in",
        installedAtBlock: 12,
        valueAtInstall: 25_000,
        epochId: "last-epoch",
      },
      {
        version: 2,
        source: "return null;",
        notes: "installed here",
        installedAtBlock: 1200,
        valueAtInstall: 348_000,
        epochId: "this-epoch",
      },
    ],
    recent: [],
    observation: null,
  });
  assert.match(context, /v1 @ block 12 in epoch 1 of 2 \(last-epoch\) \(value then: 25000\.00 USDC, in that epoch\)/);
  // This epoch's own version keeps the relative frame, which is the one the model reasons in.
  assert.match(context, /v2 @ block 1200 in epoch 2 of 2 \(this-epoch\) \(value then: -1000\.00 USDC vs the run start\)/);
});

test("sampleObservation: spot holdings are read in whole units, native ETH folded into WETH", () => {
  const sample = sampleObservation(
    obs({ block: 1, holdings: { WETH: 8, WBTC: 0.4 } }),
  );
  assert.equal(sample.holdings.WETH, 8);
  assert.equal(sample.holdings.WBTC, 0.4);
  // A base without decimals is left out, not guessed at eighteen.
  const noDecimals = obs({ block: 2, holdings: { WBTC: 1 } });
  delete (noDecimals as unknown as { baseDecimals?: unknown }).baseDecimals;
  assert.equal(sampleObservation(noDecimals).holdings.WBTC, undefined);
});

test("marketMoveUsdc: what the inventory would have done at fair prices, or null when nothing is priced", () => {
  assert.equal(
    marketMoveUsdc({ WETH: 8, WBTC: 0.4 }, { WETH: 3000, WBTC: 60000 }, { WETH: 3010, WBTC: 59900 }),
    8 * 10 + 0.4 * -100,
  );
  assert.equal(marketMoveUsdc({ WETH: 8 }, {}, { WETH: 3010 }), null);
  assert.equal(marketMoveUsdc({}, { WETH: 3000 }, { WETH: 3010 }), null);
  // A feed that read zero at either end is unpublished, not a price: the live run of 2026-09-07
  // started observing while WBTC's feed was still 0, and the whole 0.4 WBTC became a "market move"
  // of +24,176 USDC the block the feed came alive.
  assert.equal(
    marketMoveUsdc({ WETH: 8, WBTC: 0.4 }, { WETH: 3000, WBTC: 0 }, { WETH: 3010, WBTC: 60440 }),
    80,
  );
  const unpublished = sampleObservation(
    obs({ block: 1, fairWeth: 3000, fairWbtc: 0, holdings: { WETH: 8, WBTC: 0.4 } }),
  );
  assert.equal(unpublished.fair.WBTC, undefined);
});

test("TradeLedger: the market's move on held inventory is separated from what the trade did", () => {
  // The smoke run of 2026-09-07: a do-nothing agent was credited with +6,562 USDC over the trading
  // agent's own windows, because the delta was the whole portfolio's mark. The counterfactual is
  // the pre-trade inventory at the settled block's fair prices; what is left is the trade.
  const history = new MarketHistory(64);
  history.push(obs({ block: 40, fairWeth: 3000, value: 25_000, holdings: { WETH: 8 } }));
  history.push(obs({ block: 42, fairWeth: 3005, value: 25_040, holdings: { WETH: 8 } }));
  history.push(obs({ block: 45, fairWeth: 3010, value: 25_100, holdings: { WETH: 8 } }));
  const ledger = new TradeLedger({ sampleAt: (b) => history.at(b) });
  ledger.submitted({ hash: "0xb", decidedAtBlock: 40, actionType: "swap", base: "WETH" });
  ledger.resolved("0xb", { status: "success", txIndex: 2, blockNumber: 42 });
  for (const b of [42, 45]) ledger.mark(b, history.at(b)!.valueUsdc, history.at(b));

  const agg = ledger.aggregate(null);
  // Baseline is the decision block (25,000), not the inclusion mark (25,040): the fill itself is
  // part of what the trade did.
  assert.equal(agg.rawValueDeltaUsdc, 100);
  assert.equal(agg.marketValueDeltaUsdc, 80); // 8 WETH x (3010 - 3000)
  assert.equal(agg.tradeValueDeltaUsdc, 20);
  assert.equal(agg.splitTrades, 1);
  const outcome = ledger.outcomesByBlock(null).get(40)![0];
  assert.match(outcome, /value \+100\.00 after 3b \(market \+80\.00, trade \+20\.00\)/);
  const digest = digestTrades(agg).join("\n");
  assert.match(digest, /holding that inventory at fair prices would have made \+80\.00 USDC/);
  assert.match(digest, /the trades themselves made \+20\.00 USDC/);
  assert.doesNotMatch(digest, /not what the market did/);
});

test("TradeLedger: an agent whose value only tracks its holdings shows the trades doing nothing", () => {
  // The invariant the fix is for: if the mark moves exactly with holdings x fair, the trade figure
  // is zero however large the raw delta is.
  const history = new MarketHistory(64);
  const held = 8;
  for (const [block, fair] of [[10, 3000], [12, 3100], [15, 3250]] as const)
    history.push(
      obs({ block, fairWeth: fair, value: 1_000 + held * fair, holdings: { WETH: held } }),
    );
  const ledger = new TradeLedger({ sampleAt: (b) => history.at(b) });
  ledger.submitted({ hash: "0xn", decidedAtBlock: 10, actionType: "swap" });
  ledger.resolved("0xn", { status: "success", blockNumber: 12 });
  for (const b of [12, 15]) ledger.mark(b, history.at(b)!.valueUsdc, history.at(b));
  const agg = ledger.aggregate(null);
  assert.equal(agg.rawValueDeltaUsdc, held * 250);
  assert.equal(agg.marketValueDeltaUsdc, held * 250);
  assert.equal(Math.abs(agg.tradeValueDeltaUsdc ?? 1) < 1e-6, true);
});

test("TradeLedger: without holdings the raw figure is kept but labelled as unseparated", () => {
  const ledger = new TradeLedger();
  ledger.submitted({ hash: "0xu", decidedAtBlock: 40, actionType: "swap" });
  ledger.resolved("0xu", { status: "success", blockNumber: 42 });
  ledger.mark(42, 25_000);
  ledger.mark(45, 25_100);
  const agg = ledger.aggregate(null);
  assert.equal(agg.rawValueDeltaUsdc, 100);
  assert.equal(agg.marketValueDeltaUsdc, null);
  assert.equal(agg.tradeValueDeltaUsdc, null);
  assert.match(ledger.outcomesByBlock(null).get(40)![0], /market share unknown; baseline taken after inclusion/);
  assert.match(digestTrades(agg).join("\n"), /could not be separated/);
});

test("buildRevisionContext: the PnL lines carry the do-nothing counterfactual next to them", () => {
  const context = buildRevisionContext({
    block: 120,
    valueUsdc: 27_196.79,
    initialValueUsdc: 25_000,
    sinceLastRevisionUsdc: -90,
    holdSinceStartUsdc: 2_100.12,
    holdSinceLastRevisionUsdc: -180.5,
    currentVersion: 0,
    history: [],
    recent: [],
    observation: null,
  });
  assert.match(
    context,
    /PnL since the run started: 2196\.79 USDC \(holding the inventory you had then would be \+2100\.12 USDC; the difference, \+96\.67 USDC, is what trading did\)/,
  );
  assert.match(
    context,
    /PnL since the last revision: -90\.00 USDC \(holding the inventory you had then would be -180\.50 USDC; the difference, \+90\.50 USDC, is what trading did\)/,
  );
  // Without the counterfactual the line is what it always was.
  const plain = buildRevisionContext({
    block: 120,
    valueUsdc: 24_900,
    initialValueUsdc: 25_000,
    sinceLastRevisionUsdc: null,
    currentVersion: 0,
    history: [],
    recent: [],
    observation: null,
  });
  assert.match(plain, /PnL since the run started: -100\.00 USDC\n/);
});

test("digestMarketHistory: eUSD is reported once, in the stables section, when the registry prices it", () => {
  // The registry prices eUSD as a stable since #27 (negative = below a dollar). The liquity adapter
  // reports the same price as a discount with the sign flipped (positive = below par), and a live
  // context showed one depeg as "-90 bps" in one section and "+90 bps" in the next.
  const history = new MarketHistory(8);
  history.push(obs({ block: 1, eusd: { priceUsdc: 0.991 }, eusdDiscountBps: 90 }));
  history.push(obs({ block: 2, eusd: { priceUsdc: 0.991 }, eusdDiscountBps: 90 }));
  const text = digestMarketHistory(history.since(null)).join("\n");
  assert.match(text, /EUSD: outside b1\.\.b2 .*worst -90\.0 bps/);
  assert.doesNotMatch(text, /liquity:EUSD-vs-par/);
  // Without a registry entry the adapter's figure is the only one there is, and it is kept.
  const bare = new MarketHistory(8);
  bare.push(obs({ block: 1, eusdDiscountBps: 90 }));
  assert.match(digestMarketHistory(bare.since(null)).join("\n"), /liquity:EUSD-vs-par/);
});
