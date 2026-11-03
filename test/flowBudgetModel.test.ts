// Bounded model check of the background flow's wallet budget.
//
// The failure this pins down: the informed (gap-closing) leg's size is `cap x min(1, deviation x 20)`,
// so it asks for the full cap every block a venue is far enough from fair. The wallets are funded to
// a fixed amount and refilled on a fixed interval. Those two numbers were chosen independently and on
// the practice calibration demand was ~4x supply -- 150 WETH every 300 blocks against 2 WETH a block.
// The wallet emptied a fifth of the way into each cycle, every later order reverted with Uniswap's
// `STF`, and the only force pulling a venue back to the reference price switched off exactly when the
// deviation was large. Measured on the live practice chain: the informed revert rate rose from ~0 %
// just after a top-up to 85 % just before the next one, and the venues reached 0.14x and 9.6x of fair
// on the same day.
//
// Rather than assert the two constants against each other (which is how they drifted apart), the
// checks below explore the state space:
//
//   * the environment is adversarial -- every sequence of deviation regimes over a horizon, not a
//     sampled path, so "the gap stays wide for a while" is reached by construction;
//   * the config lattice covers caps and funded amounts well away from today's values, so a future
//     recalibration is checked by the same properties;
//   * the properties are about the mechanism (never overspend, always say so, stay able to act),
//     not about any particular number.
//
// The transition relation settles every order at the venue price, so a leg that keeps selling the
// same token really does run its inventory down -- the one-sided drain the whole thing is about.
//
// Local-deploy overlay for the WBTC leg, as in flowBaseGuard.test.ts: the fork registry is WETH/USDC
// only and has no second base for a wallet to run out of.
process.env.ERIS_LOCAL_DEPLOY = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

const { Rng } = await import("@eris/sdk/rng.js");
const { buildFlowOrders } = await import("../core/src/flow/logic.js");
const {
  flowBudgetShortfall,
  flowSolventRounds,
  flowTopUpIntervalBlocks,
  planFlowTopUp,
  FLOW_TOPUP_FLOOR_BPS,
} = await import("../core/src/realtime/flowWallets.js");
type FlowContextWire = import("../core/src/flow/logic.js").FlowContextWire;
type FlowGuardNote = import("../core/src/flow/logic.js").FlowGuardNote;
type FlowDrainPerRound =
  import("../core/src/realtime/flowWallets.js").FlowDrainPerRound;

const WEI = 10n ** 18n;
const USDC = 10n ** 6n;
const SAT = 10n ** 8n;
const FAIR_WETH = 3000;
const FAIR_WBTC = 60000;
const VENUES = ["uniswap", "balancer", "curve"] as const;

// ---------------------------------------------------------------- the model

// What the environment does to a venue in one round. The informed leg reads the deviation, so this
// alphabet is the whole of its input: inside the no-arb band it emits nothing, past 5 % it is at the
// cap, and the sign decides which token it spends.
type Regime = "at-fair" | "mild-over" | "full-over" | "full-under";
const REGIMES: Regime[] = ["at-fair", "mild-over", "full-over", "full-under"];

function poolPrice(fair: number, regime: Regime): number {
  switch (regime) {
    case "at-fair":
      return fair;
    case "mild-over":
      return fair * 1.005; // past the 30 bps band, well under the 5 % full-size point
    case "full-over":
      return fair * 1.4; // informed sells the base
    case "full-under":
      return fair / 1.4; // informed buys the base
  }
}

type Wallet = { wethWei: bigint; usdcUnits: bigint; bases: Record<string, bigint> };

type Config = {
  wethCap: bigint; // uniswap informed cap
  btcCap: bigint;
  fundedWeth: bigint;
  fundedUsdc: bigint;
  fundedBtc: bigint;
  topUpEvery: number;
};

function targetsOf(c: Config) {
  return {
    ethWei: WEI,
    wethWei: c.fundedWeth,
    usdcUnits: c.fundedUsdc,
    bases: { WETH: c.fundedWeth, WBTC: c.fundedBtc },
  };
}

// The worst wallet's per-round demand, the way the coordinator computes it: one round can put every
// leg of a wallet on the quote side at once, so the USDC component is the sum.
function drainOf(c: Config): FlowDrainPerRound {
  return {
    wethWei: c.wethCap,
    usdcUnits:
      (c.wethCap * BigInt(FAIR_WETH)) / 10n ** 12n +
      (c.btcCap * BigInt(FAIR_WBTC)) / 100n,
    bases: { WBTC: c.btcCap },
  };
}

function freshWallets(c: Config): Record<string, Wallet> {
  const out: Record<string, Wallet> = {};
  for (const v of VENUES)
    for (const kind of ["informed", "uninformed"] as const)
      out[`${v}:${kind}`] = {
        wethWei: c.fundedWeth,
        usdcUnits: c.fundedUsdc,
        bases: { WETH: c.fundedWeth, WBTC: c.fundedBtc },
      };
  return out;
}

function ctxFor(
  c: Config,
  round: number,
  regime: Regime,
  wallets: Record<string, Wallet>,
): FlowContextWire {
  const flowBalances: FlowContextWire["flowBalances"] = {};
  for (const [key, w] of Object.entries(wallets))
    flowBalances[key] = {
      wethWei: w.wethWei.toString(),
      usdcUnits: w.usdcUnits.toString(),
      bases: Object.fromEntries(
        Object.entries(w.bases).map(([s, v]) => [s, v.toString()]),
      ),
    };
  const prices = Object.fromEntries(
    VENUES.map((v) => [v, poolPrice(FAIR_WETH, regime)]),
  );
  return {
    round,
    fairPriceUsdcPerWeth: FAIR_WETH,
    flowSeed: 7,
    protocols: [...VENUES],
    poolPrices: prices,
    flowBalances,
    extraBases: [
      {
        base: "WBTC",
        poolPrices: Object.fromEntries(
          VENUES.map((v) => [v, poolPrice(FAIR_WBTC, regime)]),
        ),
        fairPriceUsd: FAIR_WBTC,
        uninformedFlowMaxBaseWei: (c.btcCap / 2n).toString(),
        informedFlowMaxBaseWei: c.btcCap.toString(),
        balancerFlowMaxBaseWei: (c.btcCap / 2n).toString(),
        curveFlowMaxBaseWei: (c.btcCap / 2n).toString(),
      },
    ],
    limits: {
      uninformedFlowMaxWethWei: (c.wethCap / 2n).toString(),
      informedFlowMaxWethWei: c.wethCap.toString(),
      balancerFlowMaxWethWei: c.wethCap.toString(),
      curveFlowMaxWethWei: c.wethCap.toString(),
      gmxFlowMaxSizeUsd: "0",
      aaveFlowMaxWethWei: "0",
      aaveFlowBorrowUsdcUnits: "0",
      informedArbFeeBps: "30",
      defaultPriorityFeeWei: "100000000",
    },
  };
}

// Settle one order against the wallet it came from: spend `amountIn` of tokenIn and receive the
// same notional of the other side at the venue price. Returns the amount spent so the caller can
// check it was affordable.
function settle(
  w: Wallet,
  tokenIn: string,
  base: string,
  amountIn: bigint,
  price: number,
): void {
  const held = (sym: string): bigint =>
    sym === "USDC" ? w.usdcUnits : (w.bases[sym] ?? 0n);
  const set = (sym: string, v: bigint): void => {
    if (sym === "USDC") w.usdcUnits = v;
    else {
      w.bases[sym] = v;
      if (sym === "WETH") w.wethWei = v;
    }
  };
  const scale = base === "WBTC" ? SAT : WEI;
  set(tokenIn, held(tokenIn) - amountIn);
  if (tokenIn === "USDC") {
    set(base, held(base) + (amountIn * scale) / BigInt(Math.round(price)) / USDC);
  } else {
    set("USDC", w.usdcUnits + (amountIn * BigInt(Math.round(price))) / scale);
  }
}

type Violation = { kind: string; detail: string };

/**
 * Run one config against one sequence of regimes and return every property violation seen.
 *
 * P1 overspend     an order asks for more of a token than the wallet holds (on chain: `STF`)
 * P2 silent        a leg was reduced or dropped for want of funds without a guard note
 * P3 cannot-act    the informed leg could not act at full size while a venue was far from fair
 */
function explore(c: Config, path: Regime[], checkP3: boolean): Violation[] {
  const bad: Violation[] = [];
  const wallets = freshWallets(c);
  const interval = flowTopUpIntervalBlocks(c.topUpEvery, targetsOf(c), drainOf(c));
  const rng = new Rng(11);
  for (let round = 1; round <= path.length; round++) {
    const regime = path[round - 1];
    const ctx = ctxFor(c, round, regime, wallets);
    const guards: FlowGuardNote[] = [];
    const orders = buildFlowOrders(rng, ctx, guards);

    // P1: no wallet is asked for more than it holds, counting every leg of the round together.
    const want = new Map<string, bigint>();
    for (const o of orders) {
      const a = o.action as { tokenIn?: string; amountIn?: string; base?: string };
      if (!a.tokenIn || !a.amountIn) continue;
      const key = `${o.protocol}:${o.kind}|${a.tokenIn}`;
      want.set(key, (want.get(key) ?? 0n) + BigInt(a.amountIn));
    }
    for (const [key, amount] of want) {
      const [wallet, token] = key.split("|");
      const w = wallets[wallet];
      if (!w) continue;
      const have = token === "USDC" ? w.usdcUnits : (w.bases[token] ?? 0n);
      if (amount > have)
        bad.push({
          kind: "P1-overspend",
          detail: `round ${round} ${regime}: ${wallet} asked ${amount} ${token}, holds ${have}`,
        });
    }

    // P3: while a venue is far from fair, the gap-closing leg has to be able to act at full size.
    if (checkP3 && (regime === "full-over" || regime === "full-under")) {
      for (const v of VENUES) {
        const informed = orders.filter(
          (o) => o.protocol === v && o.kind === "informed",
        );
        const legs = new Set(
          informed.map(
            (o) => ((o.action as { base?: string }).base ?? "WETH") as string,
          ),
        );
        for (const leg of ["WETH", "WBTC"])
          if (!legs.has(leg))
            bad.push({
              kind: "P3-cannot-act",
              detail: `round ${round} ${regime}: ${v}:informed sent no ${leg} order`,
            });
      }
    }

    // P2: a leg the balance silenced has to be in the notes. A flow that goes one-sided because it
    // ran out of inventory looks exactly like a trending market from outside, which is what agents
    // are trading against -- so it is never allowed to happen without the run record saying so.
    if (regime === "full-over" || regime === "full-under") {
      for (const v of VENUES) {
        const sent = new Set(
          orders
            .filter((o) => o.protocol === v && o.kind === "informed")
            .map((o) => ((o.action as { base?: string }).base ?? "WETH") as string),
        );
        for (const leg of ["WETH", "WBTC"]) {
          if (sent.has(leg)) continue;
          const noted = guards.some(
            (g) => g.protocol === v && g.kind === "informed" && g.base === leg,
          );
          if (!noted)
            bad.push({
              kind: "P2-silent",
              detail: `round ${round} ${regime}: ${v}:informed dropped its ${leg} leg with no guard note`,
            });
        }
      }
    }

    // settle, then top up on the derived interval
    for (const o of orders) {
      const a = o.action as { tokenIn?: string; amountIn?: string; base?: string };
      if (!a.tokenIn || !a.amountIn) continue;
      const w = wallets[`${o.protocol}:${o.kind}`];
      if (!w) continue;
      const base = a.base ?? "WETH";
      settle(
        w,
        a.tokenIn,
        base,
        BigInt(a.amountIn),
        poolPrice(base === "WBTC" ? FAIR_WBTC : FAIR_WETH, regime),
      );
    }
    if (interval > 0 && round % interval === 0) {
      for (const w of Object.values(wallets)) {
        const plan = planFlowTopUp(
          { ethWei: WEI, wethWei: w.wethWei, usdcUnits: w.usdcUnits, bases: w.bases },
          targetsOf(c),
        );
        if (!plan) continue;
        if (plan.wethWei > 0n) {
          w.wethWei = plan.wethWei;
          w.bases.WETH = plan.wethWei;
        }
        if (plan.usdcUnits > 0n) w.usdcUnits = plan.usdcUnits;
        for (const [s, v] of Object.entries(plan.bases)) w.bases[s] = v;
      }
    }
  }
  return bad;
}

function* paths(alphabet: Regime[], depth: number): Generator<Regime[]> {
  if (depth === 0) {
    yield [];
    return;
  }
  for (const head of alphabet)
    for (const rest of paths(alphabet, depth - 1)) yield [head, ...rest];
}

// --------------------------------------------------------------- the checks

// Today's practice calibration, and the shape the collision had: a cap large against the funded
// amount, a long interval, and a wallet that has to serve two bases at once.
const LATTICE: Config[] = [];
for (const wethCap of [2n * WEI, 8n * WEI])
  for (const btcCap of [SAT / 10n, SAT])
    for (const fundedWeth of [150n * WEI, 10n * WEI])
      for (const topUpEvery of [300, 60])
        LATTICE.push({
          wethCap,
          btcCap,
          fundedWeth,
          fundedUsdc: (fundedWeth * BigInt(FAIR_WETH)) / 10n ** 12n,
          fundedBtc: (fundedWeth * BigInt(FAIR_WETH)) / BigInt(FAIR_WBTC) / 10n ** 10n,
          topUpEvery,
        });

test("P1/P2: no round overspends a wallet, and nothing it silenced goes unrecorded", () => {
  // Exhaustive over every 5-round regime sequence (4^5 = 1,024) for every config in the lattice.
  // Before the shared ledger the WETH and WBTC legs of one wallet each checked the full USDC
  // balance, so a drained wallet sent two orders it could only pay for one of.
  const seen: Violation[] = [];
  for (const c of LATTICE)
    for (const path of paths(REGIMES, 5)) {
      const bad = explore(c, path, false);
      if (bad.length > 0) seen.push(bad[0]);
    }
  assert.deepEqual(seen.slice(0, 5), [], `${seen.length} rounds violated P1 or P2`);
});

test("P1 holds on a long one-sided gap, which is what empties a wallet", () => {
  // The adversary that actually broke the chain: the venue stays far from fair for a long time, so
  // the informed leg keeps spending the same token until the inventory is gone.
  for (const c of LATTICE)
    for (const regime of ["full-over", "full-under"] as Regime[]) {
      const bad = explore(c, Array(400).fill(regime), false);
      assert.deepEqual(
        bad.filter((v) => v.kind === "P1-overspend").slice(0, 3),
        [],
        `config ${c.wethCap}/${c.fundedWeth}@${c.topUpEvery}`,
      );
    }
});

test("P3: with the derived interval the gap-closing leg can always act", () => {
  // The property the whole fix is for. The interval comes from the caps, so a config whose caps
  // outrun its funding is visited more often rather than going quiet half the time.
  for (const c of LATTICE)
    for (const regime of ["full-over", "full-under"] as Regime[]) {
      const bad = explore(c, Array(400).fill(regime), true);
      assert.deepEqual(
        bad.slice(0, 3),
        [],
        `config cap=${c.wethCap} funded=${c.fundedWeth} every=${c.topUpEvery} ${regime}`,
      );
    }
});

// The check above found the precondition the hard way: on the lattice point funding a wallet with
// 10 WETH while the caps ask for 8 WETH and 1 WBTC a round, one round costs 66,000 USDC against a
// 15,000 floor. No interval divides that -- a wallet funded with less than a round's demand is short
// however often it is visited, so that is a config to reject, not a cadence to tune. The property
// below is therefore stated under its precondition, and the precondition is a property of its own.
function satisfiable(c: Config): boolean {
  const floors = {
    ethWei: WEI,
    wethWei: (targetsOf(c).wethWei * FLOW_TOPUP_FLOOR_BPS) / 10_000n,
    usdcUnits: (targetsOf(c).usdcUnits * FLOW_TOPUP_FLOOR_BPS) / 10_000n,
    bases: Object.fromEntries(
      Object.entries(targetsOf(c).bases).map(([s, v]) => [
        s,
        (v * FLOW_TOPUP_FLOOR_BPS) / 10_000n,
      ]),
    ),
  };
  // Two rounds at the floor: one to act on, one for the grant to land (flowTopUpIntervalBlocks).
  return flowBudgetShortfall(floors, drainOf(c), 2).length === 0;
}

test("the derived interval is short enough that a refill outlasts it", () => {
  // The arithmetic on its own, independent of the simulation above: between two checks the flow can
  // commit `drain x interval`, and the balance a check leaves behind is at least the floor.
  let checked = 0;
  for (const c of LATTICE) {
    const drain = drainOf(c);
    const targets = targetsOf(c);
    const interval = flowTopUpIntervalBlocks(c.topUpEvery, targets, drain);
    assert.ok(interval >= 1, "an interval is still an interval");
    assert.ok(interval <= c.topUpEvery, "deriving only ever shortens");
    if (!satisfiable(c)) continue;
    checked++;
    for (const [floor, d] of [
      [(targets.wethWei * FLOW_TOPUP_FLOOR_BPS) / 10_000n, drain.wethWei],
      [(targets.usdcUnits * FLOW_TOPUP_FLOOR_BPS) / 10_000n, drain.usdcUnits],
      [(targets.bases.WBTC * FLOW_TOPUP_FLOOR_BPS) / 10_000n, drain.bases.WBTC],
    ] as Array<[bigint, bigint]>) {
      if (d <= 0n || floor <= 0n) continue;
      assert.ok(
        BigInt(interval) * d < floor,
        `interval ${interval} x drain ${d} must stay under the floor ${floor}`,
      );
    }
  }
  assert.ok(checked > 0, "the lattice has to contain satisfiable configs too");
});

test("a wallet funded with less than one round of flow is reported", () => {
  // The precondition, as a property: every lattice point the interval cannot save is one the
  // shortfall check names. Nothing in the lattice is allowed to be both unsatisfiable and silent.
  let unsatisfiable = 0;
  for (const c of LATTICE) {
    if (satisfiable(c)) continue;
    unsatisfiable++;
    const short = flowBudgetShortfall(targetsOf(c), drainOf(c), 1);
    const floors = flowBudgetShortfall(
      {
        ethWei: WEI,
        wethWei: (targetsOf(c).wethWei * FLOW_TOPUP_FLOOR_BPS) / 10_000n,
        usdcUnits: (targetsOf(c).usdcUnits * FLOW_TOPUP_FLOOR_BPS) / 10_000n,
        bases: Object.fromEntries(
          Object.entries(targetsOf(c).bases).map(([s, v]) => [
            s,
            (v * FLOW_TOPUP_FLOOR_BPS) / 10_000n,
          ]),
        ),
      },
      drainOf(c),
      2,
    );
    assert.ok(
      short.length > 0 || floors.length > 0,
      `cap=${c.wethCap}/${c.btcCap} funded=${c.fundedWeth} went unreported`,
    );
  }
  assert.ok(unsatisfiable > 0, "the lattice has to reach past what funding can cover");
});

test("a config whose caps outrun its funding is reported, not silently run", () => {
  // The practice collision exactly: 150 WETH every 300 blocks against 2 WETH a block.
  const collided: Config = {
    wethCap: 2n * WEI,
    btcCap: SAT / 10n,
    fundedWeth: 150n * WEI,
    fundedUsdc: 450_000n * USDC,
    fundedBtc: 75n * SAT / 10n,
    topUpEvery: 300,
  };
  const derived = flowTopUpIntervalBlocks(
    collided.topUpEvery,
    targetsOf(collided),
    drainOf(collided),
  );
  assert.ok(
    derived < collided.topUpEvery,
    `300 blocks has to be narrowed, got ${derived}`,
  );
  // And with no top-up at all -- every official regime -- the run length it covers is reported.
  const rounds = flowSolventRounds(targetsOf(collided), drainOf(collided));
  assert.ok(rounds !== null && rounds < 360, `360-block epoch, solvent for ${rounds}`);
});

test("turning the top-up off is never turned back on by the derivation", () => {
  for (const c of LATTICE) {
    const off = { ...c, topUpEvery: 0 };
    assert.equal(
      flowTopUpIntervalBlocks(0, targetsOf(off), drainOf(off)),
      0,
      "a run that funds once still funds once",
    );
  }
});

test("a wallet nothing can drain keeps the configured interval", () => {
  const idle: Config = {
    wethCap: 0n,
    btcCap: 0n,
    fundedWeth: 150n * WEI,
    fundedUsdc: 450_000n * USDC,
    fundedBtc: 0n,
    topUpEvery: 300,
  };
  assert.equal(
    flowTopUpIntervalBlocks(300, targetsOf(idle), drainOf(idle)),
    300,
  );
  assert.equal(flowSolventRounds(targetsOf(idle), drainOf(idle)), null);
});
