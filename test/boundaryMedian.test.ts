// Rules §4.1: at a scoring point, a market-derived price is the median of the values over the
// preceding blocks, the scoring block included (付録A: 5). Reference prices (the environment's fair
// for the bases) are not market-derived and are used as they are.
//
// This file pins, venue by venue, which price each scored position reads off a market and at which
// blocks. Scoring breaks silently -- a mark that moves reads like a trading result -- and a whole-run
// golden is impossible (runs are nondeterministic), so the net is stretched at the function level:
// each adapter's staged valuation is driven with canned reads and the mark it returns is checked.
//
// It runs under the local-deploy overlay, because that is the only registry that carries every
// venue at once (LST, Liquity, the WBTC pools). No chain is needed: every read is faked, and the env
// is set before the dynamic imports below. Node's test runner gives each file its own process.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { driveValuation } from "./helpers/valuationRun.js";

const { setEnabledProtocolIds } =
  await import("@eris/sdk/protocols/enabled.js");
const { TOKENS, LST, LIQUITY } = await import("@eris/sdk/constants.js");
const { marketsFor } = await import("@eris/sdk/markets.js");
const { PAR_STABLE_PRICES } = await import("@eris/sdk/stables.js");
const { uniswapAdapter, lpPositionValuation, liquidityToTokenAmounts } =
  await import("@eris/sdk/protocols/uniswap.js");
const { balancerAdapter, balancerPools } =
  await import("@eris/sdk/protocols/balancer.js");
const { curveAdapter } = await import("@eris/sdk/protocols/curve.js");
const { lstValuationRun } = await import("@eris/sdk/protocols/lst.js");
const { aaveAdapter } = await import("@eris/sdk/protocols/aave.js");
const { liquityValuationRun } = await import("@eris/sdk/protocols/liquity.js");
const { MarkMedian } = await import("../core/src/realtime/reconstruct.js");
type ValuationContext = import("@eris/sdk/protocols/types.js").ValuationContext;
type ValuationRead = import("@eris/sdk/protocols/types.js").ValuationRead;

const WAD = 10n ** 18n;
const USDC_UNIT = 10n ** 6n;
const FAIR = 2000;
const BOUNDARY = 110;

const AGENT = {
  id: "a1",
  address: "0x00000000000000000000000000000000000a0001" as Address,
};

const WETH = TOKENS.WETH.address;
const USDC = TOKENS.USDC.address;

function ctx(overrides: Partial<ValuationContext> = {}): ValuationContext {
  return {
    publicClient: {} as never,
    blockNumber: BOUNDARY,
    horizonBlock: BOUNDARY,
    agents: [AGENT],
    activeStables: [USDC],
    fairByBase: () => ({ WETH: FAIR, WBTC: 60_000 }),
    stablePrices: () => PAR_STABLE_PRICES,
    ...overrides,
  };
}

const is = (read: ValuationRead, fn: string, address?: Address) =>
  read.functionName === fn &&
  (address === undefined ||
    read.address.toLowerCase() === address.toLowerCase());

// ---------------------------------------------------------------------------
// Uniswap V3 LP: the pool's tick decides how the liquidity splits into the two tokens
// ---------------------------------------------------------------------------

const UNI_WETH = marketsFor("uniswap").find((m) => m.base === "WETH")!.uniswap!;
// token0 = WETH (0x5FbD...) < token1 = USDC (0xe7f1...) in the local registry.
const TICK_LOWER = -201000;
const TICK_UPPER = -199000;
const LIQUIDITY = 700_000_000_000_000n;
const TOKEN_ID = 42n;

function uniPosition() {
  return [
    0n,
    "0x0000000000000000000000000000000000000000",
    WETH,
    USDC,
    UNI_WETH.fee,
    TICK_LOWER,
    TICK_UPPER,
    LIQUIDITY,
    0n,
    0n,
    0n,
    0n,
  ] as const;
}

// A pool with no fee growth, so the mark is principal alone and what moves it is the tick.
function uniAnswer(tick: number) {
  return (read: ValuationRead): unknown => {
    if (is(read, "slot0", UNI_WETH.pool)) return [0n, tick, 0, 0, 0, 0, true];
    if (is(read, "slot0")) return [0n, 0, 0, 0, 0, 0, true];
    if (is(read, "balanceOf")) return 1n;
    if (is(read, "tokenOfOwnerByIndex")) return TOKEN_ID;
    if (is(read, "positions")) return uniPosition();
    if (is(read, "feeGrowthGlobal0X128") || is(read, "feeGrowthGlobal1X128"))
      return 0n;
    if (is(read, "ticks")) return [0n, 0n, 0n, 0n, 0n, 0n, 0, true];
    return undefined;
  };
}

function principalAt(tick: number): number {
  const { amount0, amount1 } = liquidityToTokenAmounts({
    liquidity: LIQUIDITY,
    tick,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
  });
  return (Number(amount0) / 1e18) * FAIR + Number(amount1) / 1e6;
}

test("uniswap: an LP position splits at the boundary block's tick", async () => {
  const tick = -200300;
  const { values } = await driveValuation(
    uniswapAdapter.valueAtBlock!(ctx()),
    uniAnswer(tick),
  );
  const v = values[AGENT.id];
  assert.ok(v.valueUsdc > 2_000, `expected ~$3,000 of LP, got ${v.valueUsdc}`);
  assert.ok(Math.abs(v.valueUsdc - principalAt(tick)) < 1e-6);
  assert.equal(v.liquidatableValueUsdc, v.valueUsdc);
  assert.deepEqual(v.unpriced, []);
  // Same answer as the primitive, fed the same tick.
  const direct = lpPositionValuation(uniPosition() as never, {
    tickByPool: { [UNI_WETH.pool.toLowerCase()]: tick },
    fairByBase: { WETH: FAIR },
  });
  assert.ok(Math.abs(v.valueUsdc - direct.valueUsdc) < 1e-6);
});

// ---------------------------------------------------------------------------
// Balancer BPT / Curve LP: a share of the pool's reserves, valued at the reference prices
// ---------------------------------------------------------------------------

const BAL_WETH = balancerPools()[0];

function balancerAnswer(reserves: {
  weth: bigint;
  usdc: bigint;
  supply: bigint;
}) {
  return (read: ValuationRead): unknown => {
    if (is(read, "getPoolTokens")) {
      const poolId = (read.args?.[0] as string).toLowerCase();
      if (poolId !== BAL_WETH.poolId.toLowerCase()) return undefined;
      return [[WETH, USDC], [reserves.weth, reserves.usdc], 0n];
    }
    if (is(read, "totalSupply", BAL_WETH.bpt)) return reserves.supply;
    if (is(read, "balanceOf", BAL_WETH.bpt)) return reserves.supply / 100n; // 1%
    if (is(read, "balanceOf")) return 0n;
    return undefined;
  };
}

test("balancer: a BPT is its share of the boundary block's reserves", async () => {
  const { values } = await driveValuation(
    balancerAdapter.valueAtBlock!(ctx()),
    balancerAnswer({
      weth: 100n * WAD,
      usdc: 50_000n * USDC_UNIT,
      supply: 1_000n * WAD,
    }),
  );
  // 1% of 100 WETH + 50,000 USDC = 1 WETH (2,000) + 500 USDC.
  assert.ok(Math.abs(values[AGENT.id].valueUsdc - 2_500) < 1e-9);
  assert.equal(
    values[AGENT.id].liquidatableValueUsdc,
    values[AGENT.id].valueUsdc,
  );
});

const CURVE_WETH = marketsFor("curve").find((m) => m.base === "WETH")!.curve!;

// resolveCurvePools reads coins(i) until one reverts, then token() (absent here: the pool is its
// own LP token, as twocrypto-ng is).
const curveClient = {
  readContract: async (req: {
    address: Address;
    functionName: string;
    args?: bigint[];
  }) => {
    if (req.functionName === "coins") {
      const i = Number(req.args?.[0]);
      const pool = req.address.toLowerCase();
      const base =
        pool === CURVE_WETH.pool.toLowerCase() ? WETH : TOKENS.WBTC.address;
      if (i === 0) return USDC;
      if (i === 1) return base;
      throw new Error("coins: out of range");
    }
    throw new Error(`unexpected ${req.functionName}`);
  },
} as never;

function curveAnswer(reserves: { usdc: bigint; weth: bigint; supply: bigint }) {
  return (read: ValuationRead): unknown => {
    const mine = read.address.toLowerCase() === CURVE_WETH.pool.toLowerCase();
    if (is(read, "balances"))
      return mine
        ? Number(read.args?.[0]) === 0
          ? reserves.usdc
          : reserves.weth
        : 0n;
    if (is(read, "totalSupply")) return mine ? reserves.supply : 0n;
    if (is(read, "balanceOf")) return mine ? reserves.supply / 100n : 0n;
    return undefined;
  };
}

test("curve: an LP token is its share of the boundary block's reserves", async () => {
  const { values } = await driveValuation(
    curveAdapter.valueAtBlock!(ctx({ publicClient: curveClient })),
    curveAnswer({
      usdc: 50_000n * USDC_UNIT,
      weth: 100n * WAD,
      supply: 1_000n * WAD,
    }),
  );
  assert.ok(Math.abs(values[AGENT.id].valueUsdc - 2_500) < 1e-9);
});

// ---------------------------------------------------------------------------
// LST: the realizable mark is the better of the queue and a pool sale at the holder's own size
// ---------------------------------------------------------------------------

// accountSummaryAt -> (shares, shareAssets, claimable, reachable, unreachable, openRequests)
const LST_SHARES = 10n * WAD;

function lstAnswer(saleWei: bigint) {
  return (read: ValuationRead): unknown => {
    if (is(read, "withdrawalDelayBlocks")) return 1_000n; // outlives the run
    if (is(read, "queueThroughputWeiPerBlock")) return 0n;
    if (is(read, "accountSummaryAt"))
      return [LST_SHARES, 10n * WAD, 0n, 0n, 0n, 0n];
    if (is(read, "get_dy")) return saleWei;
    return undefined;
  };
}

test("lst: with the queue out of reach, the mark is the boundary block's pool sale", async () => {
  const { values } = await driveValuation(
    lstValuationRun(LST!, ctx()),
    lstAnswer((LST_SHARES * 98n) / 100n),
  );
  // Face value still reads par; the realizable one is what the pool pays, 2% under.
  assert.ok(Math.abs(values[AGENT.id].valueUsdc - 10 * FAIR) < 1e-6);
  assert.ok(
    Math.abs(values[AGENT.id].liquidatableValueUsdc - 9.8 * FAIR) < 1e-6,
  );
});

test("aave: LST collateral the queue cannot free is haircut to the boundary block's pool sale", async () => {
  const answer = (read: ValuationRead): unknown => {
    // 30,000 USD of collateral (the aggregator's par), no debt.
    if (is(read, "getUserAccountData"))
      return [30_000n * 10n ** 8n, 0n, 0n, 0n, 0n, 0n];
    if (is(read, "balanceOf", LST!.aaveAToken)) return LST_SHARES;
    if (is(read, "get_dy")) return (LST_SHARES * 98n) / 100n;
    if (is(read, "convertToAssets")) return LST_SHARES;
    if (is(read, "estimateDelayBlocks")) return 1_000n;
    return undefined;
  };
  const { values } = await driveValuation(
    aaveAdapter.valueAtBlock!(ctx()),
    answer,
  );
  const v = values[AGENT.id];
  assert.equal(v.valueUsdc, 30_000);
  // 0.2 WETH of par the exit cannot recover, at the WETH fair.
  assert.ok(Math.abs(v.liquidatableValueUsdc - (30_000 - 0.2 * FAIR)) < 1e-6);
});

// ---------------------------------------------------------------------------
// Liquity: own-size exits for the Stability Pool deposit and the Trove's debt
// ---------------------------------------------------------------------------

const GAS_COMPENSATION = 200n * WAD;

function liquityAnswer(q: { depositSale: bigint; debtBuyback: bigint }) {
  return (read: ValuationRead): unknown => {
    if (is(read, "LUSD_GAS_COMPENSATION")) return GAS_COMPENSATION;
    if (is(read, "getEntireDebtAndColl"))
      return [4_200n * WAD, 3n * WAD, 0n, 0n];
    if (is(read, "getCompoundedLUSDDeposit")) return 1_000n * WAD;
    if (is(read, "getDepositorETHGain")) return 0n;
    if (is(read, "get_dy")) return q.depositSale;
    if (is(read, "get_dx")) return q.debtBuyback;
    return undefined;
  };
}

test("liquity: the realizable mark uses the boundary block's own-size quotes", async () => {
  const { values } = await driveValuation(
    liquityValuationRun(LIQUITY!, ctx()),
    liquityAnswer({
      depositSale: 990n * USDC_UNIT,
      debtBuyback: 4_040n * USDC_UNIT,
    }),
  );
  const v = values[AGENT.id];
  // Trove 3 ETH (6,000) less a 4,040 USDC buyback, plus the deposit sold for 990.
  assert.ok(Math.abs(v.liquidatableValueUsdc - (6_000 - 4_040 + 990)) < 1e-6);
  // The face mark prices both legs at the mid (par here).
  assert.ok(Math.abs(v.valueUsdc - (6_000 - 4_000 + 1_000)) < 1e-6);
});

// ---------------------------------------------------------------------------
// The window itself
// ---------------------------------------------------------------------------

// A probe client for the stable window: the pool quotes par at every block.
const parProbeClient = {
  readContract: async (req: { functionName: string; args?: bigint[] }) => {
    if (req.functionName !== "get_dy") throw new Error("unexpected read");
    const [i, , dx] = req.args as bigint[];
    // DAI (18 dp) at index 1, USDC (6 dp) at index 0: 1:1 either way.
    return i === 1n ? dx / 10n ** 12n : dx * 10n ** 12n;
  },
} as never;

test("the window: with no market-priced stable, the boundary is marked live (PINS CURRENT BUG)", async () => {
  setEnabledProtocolIds(["uniswap", "balancer", "lst", "liquity", "aave"]);
  try {
    const median = new MarkMedian({
      publicClient: parProbeClient,
      activeStables: [USDC],
      windowBlocks: 5,
      floorBlock: 100,
    });
    // §4.1 applies to every market-derived price, but until now the window existed only for the
    // stables' probe: with none of those in the run, no boundary was medianed at all.
    assert.equal(await median.at(BOUNDARY), undefined);
    assert.equal(median.summary(), undefined);
  } finally {
    setEnabledProtocolIds([]);
  }
});

test("the window: the stables' probe is medianed and named as the only surface (PINS CURRENT BUG)", async () => {
  setEnabledProtocolIds(["uniswap", "curve"]);
  try {
    const median = new MarkMedian({
      publicClient: parProbeClient,
      activeStables: [USDC, TOKENS.DAI!.address],
      windowBlocks: 5,
      floorBlock: 100,
    });
    const prices = await median.at(BOUNDARY);
    assert.ok(prices);
    assert.deepEqual(median.summary()?.surfaces, ["stables"]);
  } finally {
    setEnabledProtocolIds([]);
  }
});
