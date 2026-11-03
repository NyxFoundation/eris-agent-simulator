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
  flowBudgetShortfall,
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
  const bases: Record<string, bigint> = { WETH: BigInt(doc.funding.flowWethWei) };
  for (const [symbol, v] of Object.entries(doc.funding.flowBase ?? {}))
    bases[symbol] = BigInt(v);
  // Through the same builder the coordinator uses, not a second reading of the YAML: the resolved
  // config carries a `WETH: 0` entry in `flowBaseAmounts` that a YAML-only view does not have, and
  // a test that quietly disagreed with the runtime about which amounts count would pass while the
  // derivation did nothing.
  const perBase = informedQuoteNotionals(
    BigInt(doc.funding.flowWethWei),
    Object.fromEntries(
      Object.entries(doc.funding.flowBase ?? {}).map(([k, v]) => [k, BigInt(v)]),
    ),
    (amount, symbol) =>
      ANCHOR[symbol] === undefined ? null : toQuote(amount, symbol),
  );
  return {
    ethWei: 0n,
    wethWei: BigInt(doc.funding.flowWethWei),
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
  // caps, and does. 36 rather than the 17 it was before the quote side was derived -- doubling what
  // the gap-closing wallets hold doubles how long a refill lasts, so the wallets are visited half as
  // often for the same guarantee.
  const doc = load("config/practice.yaml");
  assert.equal(doc.flow.topUpEveryBlocks, 300, "the config still asks for 300");
  const derived = flowTopUpIntervalBlocks(
    doc.flow.topUpEveryBlocks!,
    targets(doc),
    drain(doc),
  );
  assert.equal(derived, 36, "the derived interval moved: the caps or the funding changed");
});

for (const name of OFFICIAL) {
  test(`config/regimes/${name}.yaml: the flow is funded for its declared price gaps`, () => {
    // Without a top-up (every official regime) the funded amount is the whole budget, so the longest
    // run of full-size rounds a regime can declare has to fit inside it. A crash drops the reference
    // price under the pool, so the leg sells and spends the base side; a spike raises it over the
    // pool, so the leg buys and spends the shared quote side.
    const doc = load(`config/regimes/${name}.yaml`);
    assert.equal(
      doc.flow.topUpEveryBlocks ?? 0,
      0,
      "an official regime funds its wallets once",
    );
    const r = runway(doc);
    const longest = (v: unknown): number =>
      Array.isArray(v) ? Number(v[1]) : Number(v ?? 0);
    const events =
      (doc as unknown as { stress?: { events?: Array<Record<string, unknown>> } })
        .stress?.events ?? [];
    let sell = 0;
    let buy = 0;
    for (const e of events) {
      if (e.type !== "crash" && e.type !== "spike") continue;
      const blocks =
        longest(e.rampBlocks) + longest(e.holdBlocks) + longest(e.decayBlocks);
      const windows = e.count ? longest(e.count) : 1;
      // `flipProb` lets a crash resolve as a spike and the other way about, so a regime that can
      // flip has to be funded for whichever side it lands on.
      const canFlip = Number(e.flipProb ?? 0) > 0;
      if (e.type === "crash" || canFlip) sell += blocks * windows;
      if (e.type === "spike" || canFlip) buy += blocks * windows;
    }
    const shortestBase = Math.min(...Object.values(r.bases));
    const check = (
      side: "buy" | "sell",
      blocks: number,
      rounds: number,
    ): void => {
      assert.ok(
        blocks <= rounds,
        `${blocks} blocks of declared ${side === "buy" ? "upward" : "downward"} gap ` +
          `against ${rounds} rounds of ${side === "buy" ? "quote" : "base"}`,
      );
    };
    check("sell", sell, shortestBase);
    check("buy", buy, r.quote);
  });
}
