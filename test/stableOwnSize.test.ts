// Rules §4.1: a market-priced stable is marked at the effective price of the holder's own size, not
// at the $1,000 probe's mid times the size.
//
// The case that made it a rule: the USDC/DAI pool is 100k/100k (A=100) and nobody is endowed DAI,
// so an agent that buys 70,000 USDC of it and holds through the bell leaves the pool short of DAI.
// The probe then reads ~1.05, and 69,090 DAI marked at it is 72,532 -- for DAI that sells back for
// 69,986. With nobody holding DAI to sell into the pool, the push survives the five-block median.
//
// Runs under the local-deploy overlay (the registry that carries DAI and its pool); every read is
// faked, and the env is set before the dynamic imports below.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";

const { setEnabledProtocolIds } = await import(
  "@eris/sdk/protocols/enabled.js"
);
const { TOKENS, STABLE_MARKET_LEGS } = await import("@eris/sdk/constants.js");
const { marketPricedStables, PAR_STABLE_PRICES } = await import(
  "@eris/sdk/stables.js"
);
const { toPriceFeedAnswer } = await import("@eris/sdk/priceFeed.js");
const { readValueSnapshotAtBlock, ownSizeStableAdjustments } = await import(
  "../core/src/realtime/reconstruct.js"
);

const WAD = 10n ** 18n;
const USDC_UNIT = 10n ** 6n;
const BOUNDARY = 110;
const WINDOW = [106, 107, 108, 109];

const DAI = TOKENS.DAI!.address;
const USDC = TOKENS.USDC.address;
const DAI_POOL = STABLE_MARKET_LEGS.DAI!.pool;

const AGENT = {
  id: "a1",
  address: "0x00000000000000000000000000000000000a0001" as Address,
};
const HELD = 69_090n * WAD;
// The pool after the push: the $1,000 probe pays 1.05 either way, the whole holding sells for 69,986.
const PROBE_PRICE = 1.05;
const OWN_SIZE_SALE = 69_986n * USDC_UNIT;

type Read = {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
};

function pushedPool(read: Read): unknown {
  if (read.functionName === "latestAnswer") return toPriceFeedAnswer(2_000);
  if (read.functionName === "answerOf") return 0n;
  if (read.functionName === "getEthBalance") return 0n;
  if (read.functionName === "balanceOf")
    return read.address.toLowerCase() === DAI.toLowerCase() ? HELD : 0n;
  if (
    read.functionName === "get_dy" &&
    read.address.toLowerCase() === DAI_POOL.toLowerCase()
  ) {
    const [i, , dx] = read.args as bigint[];
    // DAI (index 1, 18 dp) -> USDC (index 0, 6 dp), or the other way.
    if (i === 1n)
      return dx === HELD
        ? OWN_SIZE_SALE
        : BigInt(Math.round((Number(dx / 10n ** 12n) * PROBE_PRICE)));
    return BigInt(Math.round(Number(dx * 10n ** 12n) / PROBE_PRICE));
  }
  return undefined;
}

function chain(answer: (read: Read, block: number) => unknown) {
  return {
    multicall: async ({
      contracts,
      blockNumber,
    }: {
      contracts: Read[];
      blockNumber: bigint;
    }) =>
      contracts.map((c) => {
        const result = answer(c, Number(blockNumber));
        return result === undefined
          ? { status: "failure" as const }
          : { status: "success" as const, result };
      }),
    readContract: async () => {
      throw new Error("no contract");
    },
  } as never;
}

async function snapshot(answer: (read: Read, block: number) => unknown) {
  return readValueSnapshotAtBlock({
    publicClient: chain(answer),
    agents: [AGENT],
    enabledIds: ["curve"],
    activeStables: [USDC, DAI],
    priceFeed: "0x00000000000000000000000000000000feed0001" as Address,
    blockNumber: BOUNDARY,
    medianWindow: WINDOW,
  });
}

test("a bought-up DAI holding is scored at what it sells for, not at the probe's mid", async () => {
  setEnabledProtocolIds(["curve"]);
  try {
    const snap = await snapshot((read) => pushedPool(read));
    const v = snap.values[0];
    // The face mark is still the mid times the size, and says how far above the score it sits.
    assert.ok(Math.abs(v.markedValueUsdc - 69_090 * PROBE_PRICE) < 1e-3);
    assert.ok(v.markedValueUsdc > 72_500);
    // The score is the sale of the whole holding.
    assert.ok(Math.abs(v.valueUsdc - 69_986) < 1e-6, `got ${v.valueUsdc}`);
    assert.ok(Math.abs(v.alphaValueUsdc - 69_986) < 1e-6);
    assert.deepEqual(snap.unpriced, []);
  } finally {
    setEnabledProtocolIds([]);
  }
});

test("the own-size sale is medianed over the window: one good block does not set it", async () => {
  setEnabledProtocolIds(["curve"]);
  try {
    // The pool absorbed the holding at par in the boundary block alone.
    const snap = await snapshot((read, block) =>
      block === BOUNDARY &&
      read.functionName === "get_dy" &&
      (read.args as bigint[])[2] === HELD
        ? 69_090n * USDC_UNIT
        : pushedPool(read),
    );
    assert.ok(Math.abs(snap.values[0].valueUsdc - 69_986) < 1e-6);
  } finally {
    setEnabledProtocolIds([]);
  }
});

test("a holding whose own-size quote never returns stays at the mid, and says so", async () => {
  setEnabledProtocolIds(["curve"]);
  try {
    const snap = await snapshot((read) =>
      read.functionName === "get_dy" && (read.args as bigint[])[2] === HELD
        ? undefined
        : pushedPool(read),
    );
    assert.ok(
      Math.abs(snap.values[0].valueUsdc - 69_090 * PROBE_PRICE) < 1e-3,
    );
    assert.equal(snap.unpriced.length, 1);
    assert.equal(snap.unpriced[0].reason, "mid-fallback");
    assert.equal(snap.unpriced[0].source, "own-size-DAI");
    assert.equal(snap.unpriced[0].amountRaw, HELD.toString());
  } finally {
    setEnabledProtocolIds([]);
  }
});

test("own-size adjustments: a held stable is sold, an owed one bought back, each against the mid", async () => {
  setEnabledProtocolIds(["curve"]);
  try {
    const [market] = marketPricedStables([DAI]);
    assert.ok(market);
    const key = DAI.toLowerCase();
    const prices = { ...PAR_STABLE_PRICES, byToken: { [key]: 1 } };
    const asked: Array<{ fn: string; block: bigint }> = [];
    const { adjustments, fallbacks } = await ownSizeStableAdjustments({
      call: async (reads, block) =>
        reads.map((r) => {
          asked.push({ fn: r.functionName, block });
          // 10,000 DAI sells for 9,900; 5,000 DAI costs 5,100 to buy back.
          return r.functionName === "get_dy" ? 9_900n * USDC_UNIT : 5_100n * USDC_UNIT;
        }),
      blockNumber: BigInt(BOUNDARY),
      window: WINDOW,
      markets: [market],
      stablePrices: prices,
      units: [
        { longs: { [key]: 10_000n * WAD }, shorts: { [key]: 5_000n * WAD } },
        { longs: {}, shorts: {} },
      ],
    });
    // Sold 100 below the mid, bought back 100 above it.
    assert.ok(Math.abs(adjustments[0] - -200) < 1e-6);
    assert.equal(adjustments[1], 0);
    assert.deepEqual(fallbacks, []);
    // One sale and one buyback, at the boundary and at each earlier block of the window.
    assert.equal(asked.length, 2 * (1 + WINDOW.length));
  } finally {
    setEnabledProtocolIds([]);
  }
});

test("own-size adjustments: an agent with no market-priced stable reads nothing", async () => {
  setEnabledProtocolIds(["curve"]);
  try {
    const [market] = marketPricedStables([DAI]);
    const { adjustments } = await ownSizeStableAdjustments({
      call: async () => {
        throw new Error("nothing to quote");
      },
      blockNumber: BigInt(BOUNDARY),
      window: WINDOW,
      markets: [market],
      stablePrices: PAR_STABLE_PRICES,
      units: [{ longs: {}, shorts: {} }],
    });
    assert.deepEqual(adjustments, [0]);
  } finally {
    setEnabledProtocolIds([]);
  }
});

test("an LP share hands its market-priced stable leg to the scorer, and nothing else", async () => {
  const { poolShareValueUsdc } = await import("@eris/sdk/valuation.js");
  const prices = {
    ...PAR_STABLE_PRICES,
    byToken: { [DAI.toLowerCase()]: 1.05 },
  };
  // 1% of 50,000 USDC + 50,000 DAI: the DAI leg is counted at the mid and handed over at its size;
  // USDC is the numéraire and is not.
  const share = poolShareValueUsdc(
    {
      tokens: [USDC, DAI],
      balances: [50_000n * USDC_UNIT, 50_000n * WAD],
      totalSupply: 100n * WAD,
    },
    WAD,
    { WETH: 2_000 },
    prices,
  );
  assert.ok(Math.abs(share.valueUsdc - (500 + 500 * 1.05)) < 1e-9);
  assert.deepEqual(share.stableUnits, { [DAI.toLowerCase()]: 500n * WAD });
});
