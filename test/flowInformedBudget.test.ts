// The informed side's budget, read from the committed configs.
//
// flowTrendInventory.test.ts (issue #112) does this for the *uninformed* lean: it derives how much
// one-way flow a flowTrend window sends through a venue wallet and requires the regime to fund both
// sides of it. Nothing did the same for the *informed* leg, and that is where the practice chain
// came apart: the gap-closing size is `cap x min(1, deviation x 20)`, so the leg asks for its whole
// cap every block the venue is far enough from fair, and the funded amount and the refill interval
// were picked independently of it. Demand was ~3.7x supply, the wallet emptied a fifth of the way
// into each refill cycle, and every later order reverted with Uniswap's `STF` -- so the only force
// pulling a venue back to the reference price switched off exactly when the deviation was widest.
//
// The mechanism is checked in flowBudgetModel.test.ts over a synthetic lattice. This file checks the
// numbers this repository actually ships, which is the part that drifted.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  MUTABLE_CONFIG_KEYS,
  configDiff,
  configWorld,
} from "../core/src/realtime/periodResume.js";
import {
  constantProductBaseToMoveDown,
  flowBudgetShortfall,
  informedBaseTargets,
  flowTopUpIntervalBlocks,
  informedQuoteNotionals,
  informedQuoteTarget,
  type FlowDrainPerRound,
  type FlowWalletTargets,
} from "../core/src/realtime/flowWallets.js";

const OFFICIAL = (
  parse(readFileSync("config/scenarios/public.yaml", "utf8")) as {
    regimes: string[];
  }
).regimes;
const FILES = [
  ...OFFICIAL.map((n) => `config/regimes/${n}.yaml`),
  "config/practice.yaml",
];

// The state dump's opening fair, as in flowTrendInventory.test.ts. A leg's quote-side order is its
// base cap at this price, so these are what turn a cap into USDC units.
const ANCHOR: Record<string, number> = { WETH: 3000, WBTC: 60_000 };
const DECIMALS: Record<string, number> = { WETH: 18, WBTC: 8 };

type Doc = {
  run: { blocks?: number };
  funding: {
    flowWethWei: string;
    flowUsdcUnits: string;
    flowBase?: Record<string, string>;
    informedFlowWethWei?: string;
    informedFlowBase?: Record<string, string>;
  };
  flow: {
    informedMaxWethWei: string;
    balancerMaxWethWei: string;
    curveMaxWethWei: string;
    baseMax?: Record<string, string>;
    baseInformedMax?: Record<string, string>;
    topUpEveryBlocks?: number;
  };
};

function load(path: string): Doc {
  const doc = parse(readFileSync(path, "utf8")) as Doc;
  // Every one of these is stated in all thirteen files today. Reading a default here instead would
  // let a regime drop a key and be checked against a number it does not contain.
  for (const key of [
    "informedMaxWethWei",
    "balancerMaxWethWei",
    "curveMaxWethWei",
  ] as const)
    assert.ok(doc.flow?.[key], `${path}: flow.${key} is not stated`);
  for (const key of ["flowWethWei", "flowUsdcUnits"] as const)
    assert.ok(doc.funding?.[key], `${path}: funding.${key} is not stated`);
  return doc;
}

/** The bases the flow trades in this config, WETH aside. */
function extraBases(doc: Doc): string[] {
  return Object.keys(doc.flow.baseMax ?? {}).filter((s) => s !== "WETH");
}

/**
 * What an informed wallet actually holds, which is not quite what the config states: the coordinator
 * derives the quote side from the base legs at the opening fair prices (`informedQuoteTarget`) and
 * keeps `funding.flowUsdcUnits` as the floor. Checking the config's number instead would check
 * something no wallet ever holds.
 */
function targets(doc: Doc): FlowWalletTargets {
  const big = (m?: Record<string, string>): Record<string, bigint> =>
    Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, BigInt(v)]));
  // The informed wallets' base side, through the coordinator's own resolution (funding.informedFlow*
  // floored at the flow amounts).
  const informed = informedBaseTargets({
    flowWethWei: BigInt(doc.funding.flowWethWei),
    flowBaseAmounts: big(doc.funding.flowBase),
    informedFlowWethWei: BigInt(
      doc.funding.informedFlowWethWei ?? doc.funding.flowWethWei,
    ),
    informedFlowBaseAmounts: {
      ...big(doc.funding.flowBase),
      ...big(doc.funding.informedFlowBase),
    },
  });
  const bases: Record<string, bigint> = { WETH: informed.wethWei, ...informed.bases };
  // Through the same builder the coordinator uses, not a second reading of the YAML: the resolved
  // config carries a `WETH: 0` entry in `flowBaseAmounts` that a YAML-only view does not have, and
  // a test that quietly disagreed with the runtime about which amounts count would pass while the
  // derivation did nothing.
  const perBase = informedQuoteNotionals(
    informed.wethWei,
    informed.bases,
    (amount, symbol) =>
      ANCHOR[symbol] === undefined ? null : toQuote(amount, symbol),
  );
  return {
    ethWei: 0n,
    wethWei: informed.wethWei,
    usdcUnits: informedQuoteTarget(BigInt(doc.funding.flowUsdcUnits), perBase),
    bases,
  };
}

function toQuote(amount: bigint, symbol: string): bigint {
  return (
    (amount * BigInt(Math.round(ANCHOR[symbol] * 100))) /
    (100n * 10n ** BigInt(DECIMALS[symbol] - 6))
  );
}

/**
 * The worst venue wallet's demand for one round: the uniswap wallet, whose informed WETH cap is the
 * largest and which carries every extra base's leg as well. Each leg can be a buy in the same round,
 * so the quote side is the sum while each base side stands alone.
 */
function drain(doc: Doc): FlowDrainPerRound {
  const wethCap = BigInt(doc.flow.informedMaxWethWei);
  const bases: Record<string, bigint> = {};
  let usdcUnits = toQuote(wethCap, "WETH");
  for (const symbol of extraBases(doc)) {
    const cap = BigInt(
      doc.flow.baseInformedMax?.[symbol] ?? doc.flow.baseMax?.[symbol] ?? "0",
    );
    if (cap <= 0n) continue;
    bases[symbol] = cap;
    usdcUnits += toQuote(cap, symbol);
  }
  return { wethWei: wethCap, usdcUnits, bases };
}

/** Rounds of full-size flow each side of the wallet pays for. */
function runway(doc: Doc): { bases: Record<string, number>; quote: number } {
  const t = targets(doc);
  const d = drain(doc);
  const bases: Record<string, number> = {
    WETH: Number(t.wethWei / d.wethWei),
  };
  for (const [symbol, cap] of Object.entries(d.bases))
    bases[symbol] = Number((t.bases[symbol] ?? 0n) / cap);
  return { bases, quote: Number(t.usdcUnits / d.usdcUnits) };
}

// --------------------------------------------------------------- invariants

for (const path of FILES) {
  test(`${path}: one round of gap-closing flow is affordable`, () => {
    // The satisfiability check. Below this no refill cadence helps -- a wallet funded with less than
    // a single round's demand is short however often it is visited -- so it is the one bound that
    // holds whatever else a config does.
    const short = flowBudgetShortfall(targets(load(path)), drain(load(path)), 1);
    assert.deepEqual(
      short.map((s) => `${s.symbol}: funded ${s.funded}, needs ${s.needed}`),
      [],
    );
  });

  test(`${path}: every base the flow trades is funded with that base`, () => {
    // Issue #124's property. A base the wallet holds none of can only ever be bought, so the venue's
    // gap closes from one side and its residual against the reference price sits open -- which is
    // how WBTC came to be several times further off than WETH. #99 fixed the guard that let the sell
    // go out against nothing; this is the funding the guard then needs.
    const doc = load(path);
    for (const symbol of extraBases(doc)) {
      if (BigInt(doc.flow.baseMax?.[symbol] ?? "0") <= 0n) continue;
      assert.ok(
        BigInt(doc.funding.flowBase?.[symbol] ?? "0") > 0n,
        `flow.baseMax.${symbol} trades it, funding.flowBase.${symbol} does not fund it`,
      );
    }
  });

  test(`${path}: no base is starved relative to another`, () => {
    // The other half of #124: funding every base is not enough if one of them runs out first. Each
    // base's runway is its funded amount over its own cap, and they have to match -- otherwise the
    // venue keeps closing the WETH gap long after it has stopped closing the WBTC one, and the
    // asymmetry shows up as a residual that is wider on one base for no reason a reader can see.
    const r = runway(load(path));
    const values = Object.values(r.bases);
    assert.equal(
      new Set(values).size,
      1,
      `base runways differ: ${JSON.stringify(r.bases)}`,
    );
  });
}

test("the gap-closing side buys for as many rounds as it sells", () => {
  // Each base has a funded amount of its own; all of their buy sides come out of one quote balance.
  // `funding.flowUsdcUnits` mirrors the WETH leg alone -- it was written when WETH was the only base
  // -- so with two bases the wallet sold for 75 rounds and bought for 37, and the side that ran out
  // first is the one that pulls a venue back *up* to the reference price. On the practice chain the
  // reverted informed orders were 120 USDC-in against 93 WBTC-in.
  //
  // The coordinator now derives the informed wallets' quote level as the sum of the legs
  // (`informedQuoteTarget`), with the configured number as a floor, so this asserts the symmetry
  // itself rather than pinning how far short it falls. The uninformed wallets still hold the
  // configured amount: their USDC is a calibration knob (#79, #112), not this.
  for (const path of FILES) {
    const doc = load(path);
    const t = targets(doc);
    const d = drain(doc);
    // Cross-multiplied, so the comparison is the ratio itself rather than two truncated round
    // counts -- 75 against 75 reads as 75 against 74 after integer division.
    for (const [symbol, cap] of [
      ["WETH", d.wethWei] as const,
      ...Object.entries(d.bases),
    ]) {
      const funded = symbol === "WETH" ? t.wethWei : (t.bases[symbol] ?? 0n);
      assert.ok(
        t.usdcUnits * cap >= funded * d.usdcUnits,
        `${path}: the quote side pays for fewer rounds than ${symbol} does ` +
          `(${t.usdcUnits} USDC / ${d.usdcUnits} per round against ${funded} ${symbol} / ${cap})`,
      );
    }
  }
});

test("the official regimes and the practice period fund the flow wallets identically", () => {
  // flowTrendInventory.test.ts pins flowWethWei/flowUsdcUnits; the bases belong to the same shape,
  // and a regime whose wallets hold a different basket is a second answer to what the flow is.
  const shapes = FILES.map((p) => {
    const f = load(p).funding;
    return JSON.stringify({
      flowWethWei: f.flowWethWei,
      flowUsdcUnits: f.flowUsdcUnits,
      flowBase: f.flowBase ?? null,
      informedFlowWethWei: f.informedFlowWethWei ?? null,
      informedFlowBase: f.informedFlowBase ?? null,
    });
  });
  assert.equal(
    new Set(shapes).size,
    1,
    `flow wallet funding differs:\n${FILES.map((p, i) => `${p} ${shapes[i]}`).join("\n")}`,
  );
});

test("the practice period's refill interval is derived, not the 300 it configures", () => {
  // The collision itself: 300 blocks against a 12,000 USDC round. The interval has to come from the
  // caps, and does. 99: it was 17 before the quote side was derived and 36 before the gap-closing
  // wallets held the worst gap's base (400 WETH, 150 before) -- the more they hold, the longer a
  // refill lasts, so the wallets are visited less often for the same guarantee.
  const doc = load("config/practice.yaml");
  assert.equal(doc.flow.topUpEveryBlocks, 300, "the config still asks for 300");
  const derived = flowTopUpIntervalBlocks(
    doc.flow.topUpEveryBlocks!,
    targets(doc),
    drain(doc),
  );
  assert.equal(derived, 99, "the derived interval moved: the caps or the funding changed");
});

// ------------------------------------------------- the gaps the regimes declare

// The deployer's spot depth per venue (deployer/src/protocols/*: 1,000 WETH / 50 WBTC against 3M USDC
// on each of Uniswap, Balancer and Curve). A down gap is closed by selling base into the pool until
// it reaches fair, so this, not a block count, is what a wallet has to hold.
const POOL_BASE: Record<string, bigint> = {
  WETH: 1_000n * 10n ** 18n,
  WBTC: 50n * 10n ** 8n,
};
const POOL_QUOTE_UNITS = 3_000_000n * 10n ** 6n;
// Curve's twocrypto concentrates its liquidity around the price scale, so the same move takes more
// base than the constant-product formula says -- in principle. Measured on the deployer's pools
// (2026-11-04), selling 1 WETH / 0.05 WBTC per 2-second block so the scale re-pegs as it does in a
// run: a 39.2% fall took 290 WETH and 14.5 WBTC (the formula: 282 / 14.1), a 48.8% rise 690k USDC
// (formula: 660k), each in steps of 10 blocks, so the overshoot is the step. 1.05 covers both.
const CURVE_DEPTH_MULT = 1.05;

type GapEvent = {
  type: string;
  count?: number | [number, number];
  magnitudeRange?: [number, number];
  flipProb?: number;
};

/**
 * The largest cumulative move a regime declares, each way: every window at its largest magnitude
 * and its largest count, all landing on the same side. A crash moves the reference price down, a
 * spike up; `flipProb` lets either land on the other side, so a regime that can flip is counted on
 * both. The windows compound: two 22% crashes leave 0.78^2 of the opening price.
 */
function worstMoves(name: string): { down: number; up: number } {
  const doc = parse(readFileSync(`config/regimes/${name}.yaml`, "utf8")) as {
    stress?: { events?: GapEvent[] };
  };
  let downKeep = 1;
  let upMult = 1;
  for (const e of doc.stress?.events ?? []) {
    if (e.type !== "crash" && e.type !== "spike") continue;
    const mag = e.magnitudeRange![1];
    const n = Array.isArray(e.count) ? e.count[1] : (e.count ?? 1);
    const canFlip = Number(e.flipProb ?? 0) > 0;
    if (e.type === "crash" || canFlip) downKeep *= (1 - mag) ** n;
    if (e.type === "spike" || canFlip) upMult *= (1 + mag) ** n;
  }
  return { down: 1 - downKeep, up: upMult - 1 };
}

const WORST = OFFICIAL.map((name) => ({ name, ...worstMoves(name) }));
const WORST_DOWN = Math.max(...WORST.map((w) => w.down));
const WORST_UP = Math.max(...WORST.map((w) => w.up));

// The reference price also walks (kappa 0 in every official regime), and that move lands on top of
// the gaps. ADR 0029: the epoch-end spread of fair is ~4.4% (0.23% a block x sqrt(360)). The wallets
// are funded for the worst declared gap compounded with 3 sd of it, each way, so running dry takes
// both every window at its extreme and a walk far out in its tail.
const WALK_SD = 0.044;
const WALK_SIGMAS = 3;
const FUNDED_DOWN = 1 - (1 - WORST_DOWN) * (1 - WALK_SIGMAS * WALK_SD);
const FUNDED_UP = (1 + WORST_UP) * (1 + WALK_SIGMAS * WALK_SD) - 1;

test("the worst declared moves are the ones the funding was sized against", () => {
  // Pinned so a regime that widens its gaps fails here, by name, instead of silently outgrowing the
  // wallets: crash.yaml's two 22% windows on the same side, each way.
  assert.equal(WORST_DOWN.toFixed(4), "0.3916");
  assert.equal(WORST_UP.toFixed(4), "0.4884");
  // With the walk: what the wallets are actually checked against below.
  assert.equal(FUNDED_DOWN.toFixed(4), "0.4719");
  assert.equal(FUNDED_UP.toFixed(4), "0.6849");
  assert.deepEqual(
    WORST.filter((w) => w.down === WORST_DOWN).map((w) => w.name),
    ["crash"],
  );
});

for (const path of FILES) {
  test(`${path}: the gap-closing wallets hold the base side of the worst declared down gap`, () => {
    // Without a top-up (every official regime) the funded amount is the whole budget. A gap does not
    // recover (ADR 0029 Amendment 1), so after a down gap the pools stay above fair until the informed
    // leg has sold them down to it, and nothing else in the environment does. Funded like the other
    // flow wallets (150 WETH), it ran dry after the second down gap of crash#125 and the WETH pools
    // ended 300-1,037bps above fair. The amount is the same in every run (rules §3.3), so it is the
    // worst gap of any official regime with the walk on top (FUNDED_DOWN) -- the practice period
    // included, whose gaps are far smaller.
    const t = targets(load(path));
    for (const [symbol, reserve] of Object.entries(POOL_BASE)) {
      const held = symbol === "WETH" ? t.wethWei : (t.bases[symbol] ?? 0n);
      const cp = constantProductBaseToMoveDown(reserve, FUNDED_DOWN);
      const curve = (cp * BigInt(Math.round(CURVE_DEPTH_MULT * 1000))) / 1000n;
      const need = cp > curve ? cp : curve;
      assert.ok(
        held >= need,
        `${symbol}: informed wallets hold ${held}, a ${(FUNDED_DOWN * 100).toFixed(1)}% fall ` +
          `takes ${cp} on Uniswap/Balancer and ${curve} on Curve`,
      );
    }
  });

  test(`${path}: the gap-closing wallets hold the quote side of the worst declared up gap`, () => {
    // The mirror: an up gap is closed by buying base out of the pool, every base out of one quote
    // balance. The quote side is derived from the base side (informedQuoteTarget), so this holds as
    // long as the up gap is no wider than the down gap in pool terms -- checked rather than assumed.
    const t = targets(load(path));
    const perBase = (BigInt(Math.ceil((Math.sqrt(1 + FUNDED_UP) - 1) * 1e6)) * POOL_QUOTE_UNITS) / 1_000_000n;
    const curve = (perBase * BigInt(Math.round(CURVE_DEPTH_MULT * 1000))) / 1000n;
    const need = (perBase > curve ? perBase : curve) * BigInt(Object.keys(POOL_BASE).length);
    assert.ok(
      t.usdcUnits >= need,
      `informed wallets hold ${t.usdcUnits} USDC units, a ${(FUNDED_UP * 100).toFixed(1)}% rise ` +
        `on every base takes ${need}`,
    );
  });
}

test("a running practice period resumes with the informed base level added", () => {
  // Every SimConfig key outside MUTABLE_CONFIG_KEYS is part of a period's world, and a period saved
  // before a key existed refuses to resume -- which stops the chain. The practice period was started
  // before these two keys; a resume funds nobody, so the new level reaches the wallets through the
  // refill.
  for (const key of ["informedFlowWethWei", "informedFlowBaseAmounts"])
    assert.ok((MUTABLE_CONFIG_KEYS as readonly string[]).includes(key), key);
  const before = { seed: 1, flowWethWei: 150n };
  const after = {
    ...before,
    informedFlowWethWei: 400n,
    informedFlowBaseAmounts: { WBTC: 2_000_000_000n },
  };
  assert.deepEqual(configDiff(configWorld(before, {}), configWorld(after, {})), []);
});
