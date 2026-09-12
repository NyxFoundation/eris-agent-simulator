// Issue #112: a flowTrend lean is delivered by the flow wallets' inventory, not by the event alone.
// An uninformed sell larger than the wallet's base balance flips to a buy (core/src/flow/logic.ts,
// baseHeld) and a buy is capped at the wallet's USDC (capUsdc), so a hold that leans one way for 30
// blocks spends the wallet's whole balance on that side. Measured on informed-flow#101 with the
// wallets funded like agents (0 WETH / 25k USDC): x1.37 for 3 blocks against a declared x2-3 for 12.
//
// This test derives, from each official regime's own flow and stress sections, how much one-way
// flow the largest possible lean sends through one venue wallet, and requires the regime to fund
// both sides of it. It also pins the eleven regimes to one funding: the flow is machinery shared by
// the set, and a regime whose wallets behave differently is a second answer to what the flow is.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const OFFICIAL = [
  "calm",
  "cex-drift",
  "crash",
  "depeg",
  "depeg-persist",
  "informed-flow",
  "lending-incident",
  "spike",
  "vuln",
  "whale",
  "cdp-incident",
  "launch",
];

// The state dump's opening fair (backtest/state, market.json `fair.WETH`); the USDC side of a
// lean is its WETH side at this price.
const FAIR_USDC_PER_WETH = 3000;

type Doc = {
  funding: { flowWethWei?: string; flowUsdcUnits?: string; usdcUnits: string };
  flow: { uninformedMaxWethWei: string; uninformedArrivalRate: string };
  stress?: {
    events?: {
      type: string;
      magnitudeRange?: [number, number];
      rampBlocks?: number;
      holdBlocks?: number;
      decayBlocks?: number;
    }[];
  };
};

function load(name: string): Doc {
  return parse(readFileSync(`config/regimes/${name}.yaml`, "utf8")) as Doc;
}

// One-way WETH a venue wallet sends through the sum of the regime's flowTrend windows, every window
// drawn at its largest magnitude and all of them leaning the same way. The uninformed size is
// lognormal with mean uninformedMax x 0.5 (logic.ts), arrivals are Poisson(rate) per block, and the
// trapezoid's ramp and decay count half.
function worstCaseOneWayWeth(doc: Doc): number {
  const meanWeth = (Number(doc.flow.uninformedMaxWethWei) / 1e18) * 0.5;
  const rate = Number(doc.flow.uninformedArrivalRate);
  let total = 0;
  for (const e of doc.stress?.events ?? []) {
    if (e.type !== "flowTrend") continue;
    const mag = Math.max(...(e.magnitudeRange ?? [1, 1]));
    const blocks = (e.rampBlocks ?? 0) / 2 + (e.holdBlocks ?? 0) + (e.decayBlocks ?? 0) / 2;
    total += meanWeth * mag * rate * blocks;
  }
  return total;
}

test("informed-flow's two x3 windows are ~103 WETH of one-way flow per venue wallet", () => {
  const w = worstCaseOneWayWeth(load("informed-flow"));
  assert.ok(w > 100 && w < 106, `one-way WETH ${w}`);
});

for (const name of OFFICIAL) {
  test(`config/regimes/${name}.yaml funds both sides of its largest flowTrend lean`, () => {
    const doc = load(name);
    const need = worstCaseOneWayWeth(doc);
    const weth = Number(doc.funding.flowWethWei ?? "0") / 1e18;
    const usdc = Number(doc.funding.flowUsdcUnits ?? doc.funding.usdcUnits) / 1e6;
    assert.ok(
      weth >= need,
      `${name}: flowWethWei ${weth} WETH < ${need.toFixed(1)} WETH the lean's sell side spends`,
    );
    assert.ok(
      usdc >= need * FAIR_USDC_PER_WETH,
      `${name}: flowUsdcUnits ${usdc} USDC < ${(need * FAIR_USDC_PER_WETH).toFixed(0)} the lean's buy side spends`,
    );
  });
}

test("the official regimes fund the flow wallets identically", () => {
  const funding = OFFICIAL.map((n) => {
    const f = load(n).funding;
    return `${f.flowWethWei}/${f.flowUsdcUnits}`;
  });
  assert.equal(new Set(funding).size, 1, `flow funding differs across regimes: ${funding.join(" ")}`);
  assert.equal(funding[0], "150000000000000000000/450000000000");
});
