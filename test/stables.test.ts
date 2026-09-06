// A registry stable is worth what its market pays, not $1 (issue #27).
//
// Three things are pinned here: the two-sided probe and its explicit did-not-quote state; that a
// depegged stable is marked down in both the live path an agent reads and the historical
// cross-section the scorer builds; and that a stable whose market went silent is *reported* rather
// than counted as a dollar in silence.
//
// It runs under the local-deploy overlay, because the fork registry is WETH/USDC only and has no
// market-priced stable to be right or wrong about. No chain is needed -- the addresses come from
// the committed constants.local.ts and every read here is faked -- so the env is set before the
// dynamic imports below rather than by the caller. Node's test runner gives each file its own
// process, so this does not leak into any other test.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";

const {
  marketPricedStables,
  decodeStableProbes,
  stableQuoteFrom,
  stablePriceUsdc,
  PAR_STABLE_PRICES,
} = await import("@eris/sdk/stables.js");
const { balanceToInventory, valueUsdc } = await import("@eris/sdk/pnl.js");
const { poolShareValueUsdc, tokenAmountUsd } =
  await import("@eris/sdk/valuation.js");
const { TOKENS } = await import("@eris/sdk/constants.js");
const { readValueSnapshotAtBlock } =
  await import("../core/src/realtime/reconstruct.js");
const { toPriceFeedAnswer } = await import("@eris/sdk/priceFeed.js");
const { setEnabledProtocolIds } = await import("@eris/sdk/protocols/enabled.js");
const { validateAction } = await import("@eris/sdk/action.js");

// A market-priced stable belongs to the venue that owns its pool, and marketPricedStables() is
// gated on the run having enabled it. Say so explicitly rather than relying on whichever module
// happened to initialise the registry first.
setEnabledProtocolIds(["uniswap", "curve"]);

const WAD = 10n ** 18n;
const USDC_UNIT = 10n ** 6n;
const FAIR = { WETH: 2000 };

const MARKETS = marketPricedStables();
// A deploy without the DAI/USDC pool has no second market-priced stable, and the eUSD one needs the
// liquity venue. Skip rather than assert on a deployment nobody promised.
const DAI = MARKETS.find((m) => m.symbol === "DAI");
const skip = DAI
  ? false
  : "this deployment prices no stable from a market (regenerate constants.local.ts from a deploy that seeded the DAI/USDC pool)";

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

test(
  "the mark is the geometric mean of both executable directions",
  { skip },
  () => {
    const m = DAI!;
    // Selling 1,000 fetches 980 USDC; 1,000 USDC buys 1,010.101... of the stable, i.e. 0.99 each.
    const quote = stableQuoteFrom(
      m,
      980n * USDC_UNIT,
      1_010_101_010_101_010_101_010n,
      6,
    );
    assert.equal(quote.quoted, true);
    assert.ok(Math.abs(quote.sellPriceUsdc - 0.98) < 1e-9);
    assert.ok(Math.abs(quote.buyPriceUsdc - 0.99) < 1e-6);
    assert.ok(Math.abs(quote.priceUsdc - Math.sqrt(0.98 * 0.99)) < 1e-6);
    // And it sits strictly between the two, which is the point of asking both sides: the sell side
    // alone would mark the holding 50bps lower than an unwind actually straddles.
    assert.ok(quote.priceUsdc > quote.sellPriceUsdc);
    assert.ok(quote.priceUsdc < quote.buyPriceUsdc);
  },
);

test("one side is better than none", { skip }, () => {
  const sellOnly = stableQuoteFrom(DAI!, 970n * USDC_UNIT, undefined, 6);
  assert.equal(sellOnly.quoted, true);
  assert.ok(Math.abs(sellOnly.priceUsdc - 0.97) < 1e-9);
});

test("a market that will not quote is par, and says so", { skip }, () => {
  const quote = stableQuoteFrom(DAI!, undefined, undefined, 6);
  // Not zero: zero would read as a 10000bps discount, i.e. an infinite free arb -- the failure mode
  // the LST venue hit first (issue #38).
  assert.equal(quote.priceUsdc, 1);
  assert.equal(quote.quoted, false);
});

test("decoding pairs each market with its own two reads", { skip }, () => {
  const prices = decodeStableProbes(
    [DAI!],
    [980n * USDC_UNIT, 1_010_101_010_101_010_101_010n],
  );
  assert.equal(prices.unquoted.length, 0);
  assert.ok(
    Math.abs(
      prices.byToken[DAI!.token.toLowerCase()] - Math.sqrt(0.98 * 0.99),
    ) < 1e-6,
  );
});

test("a silent market is named, and still has a usable price", { skip }, () => {
  const prices = decodeStableProbes([DAI!], [undefined, undefined]);
  assert.equal(prices.unquoted.length, 1);
  assert.equal(prices.unquoted[0].symbol, "DAI");
  assert.equal(prices.byToken[DAI!.token.toLowerCase()], 1);
});

test("USDC is never market-priced: it is the unit", () => {
  // Even if a deploy handed the registry a USDC leg, the numéraire stays $1 by definition -- every
  // competition metric is denominated in it (issue #27, "Settled").
  assert.equal(
    MARKETS.some(
      (m) => m.token.toLowerCase() === TOKENS.USDC.address.toLowerCase(),
    ),
    false,
  );
  assert.equal(stablePriceUsdc(PAR_STABLE_PRICES, TOKENS.USDC.address), 1);
});

// ---------------------------------------------------------------------------
// What the marks do to a value
// ---------------------------------------------------------------------------

function depegged(price: number) {
  return {
    byToken: { [DAI!.token.toLowerCase()]: price },
    unquoted: [],
    quotes: [],
  };
}

// 1,000 USDC and 1,000 DAI, no ETH exposure at all.
function held() {
  return {
    ethWei: 0n,
    wethWei: 0n,
    usdcUnits: 1_000n * USDC_UNIT,
    bases: { WETH: 0n },
    stables: {
      [TOKENS.USDC.address.toLowerCase()]: 1_000n * USDC_UNIT,
      [DAI!.token.toLowerCase()]: 1_000n * WAD,
    },
  };
}

test(
  "a depegged stable is marked down, and USDC beside it is not",
  { skip },
  () => {
    assert.ok(Math.abs(valueUsdc(held(), FAIR, depegged(0.95)) - 1_950) < 1e-9);
    // Same holdings, no market: the old behaviour, and still the right one for a dollar nothing
    // quotes.
    assert.equal(valueUsdc(held(), FAIR, PAR_STABLE_PRICES), 2_000);
  },
);

test("the live and historical paths cannot disagree", { skip }, () => {
  // balanceToInventory is what an agent's observation carries; valueUsdc is what the scorer's
  // cross-section sums. They are the same call, which is the point -- an agent that sees 1,950 in
  // its inventory is scored at 1,950.
  const live = balanceToInventory(held(), FAIR, depegged(0.95));
  assert.equal(live.valueUsdc, valueUsdc(held(), FAIR, depegged(0.95)));
  // The budget field stays native USDC: it is what a USDC leg can be sized against, and the
  // depegged stable cannot be spent in a USDC pool.
  assert.equal(live.usdc, 1_000);
});

test(
  "a snapshot with no breakdown falls back to usdcUnits at par",
  { skip },
  () => {
    // Every hand-assembled snapshot in the codebase looks like this, and there is nothing better to
    // do with one: the per-stable balances simply are not there.
    const bare = { ethWei: 0n, wethWei: 0n, usdcUnits: 500n * USDC_UNIT };
    assert.equal(valueUsdc(bare, FAIR, depegged(0.95)), 500);
  },
);

test("a registry stable's price reaches an LP leg too", { skip }, () => {
  // A pool holding the depegged stable is worth less, which is where a position could hide if only
  // spot balances were marked.
  const reserves = {
    tokens: [TOKENS.WETH.address, DAI!.token],
    balances: [10n * WAD, 20_000n * WAD],
    totalSupply: 100n * WAD,
  };
  const share = poolShareValueUsdc(reserves, 10n * WAD, FAIR, depegged(0.95));
  // 10% of 10 WETH at $2000, plus 10% of 20,000 DAI at 0.95.
  assert.ok(Math.abs(share.valueUsdc - (2_000 + 1_900)) < 1e-6);
  assert.equal(share.unpriced.length, 0);
});

test(
  "tokenAmountUsd prices USDC at par whatever the probes said",
  { skip },
  () => {
    assert.equal(
      tokenAmountUsd(
        TOKENS.USDC.address,
        250n * USDC_UNIT,
        FAIR,
        depegged(0.95),
      ),
      250,
    );
  },
);

// ---------------------------------------------------------------------------
// The historical cross-section, end to end
// ---------------------------------------------------------------------------

type Call = {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
};

const PRICE_FEED = "0x00000000000000000000000000000000feed0001" as Address;
const AGENT = {
  id: "a1",
  address: "0x00000000000000000000000000000000000a0001" as Address,
};

// A cross-section where the agent holds 1,000 USDC and 1,000 DAI and nothing else, and the pool
// answers `sell`/`buy` for the two probe directions.
function snapshotWith(probe: (call: Call) => bigint | undefined) {
  const client = {
    multicall: async ({ contracts }: { contracts: Call[] }) =>
      contracts.map((c) => {
        if (c.functionName === "latestAnswer")
          return {
            status: "success" as const,
            result: toPriceFeedAnswer(2000),
          };
        if (c.functionName === "getEthBalance")
          return { status: "success" as const, result: 0n };
        if (c.functionName === "get_dy") {
          const result = probe(c);
          return result === undefined
            ? { status: "failure" as const }
            : { status: "success" as const, result };
        }
        if (c.address.toLowerCase() === DAI!.token.toLowerCase())
          return { status: "success" as const, result: 1_000n * WAD };
        if (c.address.toLowerCase() === TOKENS.USDC.address.toLowerCase())
          return { status: "success" as const, result: 1_000n * USDC_UNIT };
        return { status: "success" as const, result: 0n };
      }),
  } as never;
  return readValueSnapshotAtBlock({
    publicClient: client,
    agents: [AGENT],
    enabledIds: [],
    activeStables: [TOKENS.USDC.address, DAI!.token],
    priceFeed: PRICE_FEED,
    blockNumber: 100,
  });
}

test(
  "the scorer marks a depegged stable at the pool, not at par",
  { skip },
  async () => {
    // Both directions say 0.95: selling 1,000 DAI fetches 950 USDC, and 1,000 USDC buys 1,052.6 DAI.
    const s = await snapshotWith((c) =>
      (c.args?.[0] as bigint) === BigInt(DAI!.stableIndex)
        ? 950n * USDC_UNIT
        : 1_052_631_578_947_368_421_052n,
    );
    assert.deepEqual(s.unpriced, []);
    assert.ok(Math.abs(s.values[0].valueUsdc - (1_000 + 950)) < 0.5);
    // α marks the stable live too: unlike a base's fair price, a peg's discount is a dislocation
    // against a price something enforces, so removing it would cancel the thing being measured.
    assert.equal(s.values[0].alphaValueUsdc, s.values[0].valueUsdc);
  },
);

test(
  "a stable whose market cannot quote is reported, not silently par",
  { skip },
  async () => {
    const s = await snapshotWith(() => undefined);
    // The dollar is still counted -- dropping the balance would be worse -- but the assumption is on
    // the record, against the agent whose value depends on it.
    assert.ok(Math.abs(s.values[0].valueUsdc - 2_000) < 1e-6);
    const reported = s.unpriced.filter((h) => h.reason === "par-fallback");
    assert.equal(reported.length, 1);
    assert.equal(reported[0].agentId, AGENT.id);
    assert.equal(reported[0].source, "spot-DAI");
    assert.equal(reported[0].amountRaw, (1_000n * WAD).toString());
  },
);

// ---------------------------------------------------------------------------
// Reachability: swept, priced and tradable have to agree
// ---------------------------------------------------------------------------

test("a stable whose venue the run disabled is not visible at all", { skip }, () => {
  setEnabledProtocolIds(["uniswap"]);
  try {
    // Not priced, so a holding of it would be marked at par; the point is that it is not tradable
    // either, so nobody can acquire one. All three move together or dollars vanish from a score.
    assert.equal(marketPricedStables().length, 0);
  } finally {
    setEnabledProtocolIds(["uniswap", "curve"]);
  }
});

// ---------------------------------------------------------------------------
// Bundle accounting
// ---------------------------------------------------------------------------

const AGENT_OBS = {
  round: 1,
  limits: {
    maxPriorityFeePerGasWei: "1000000000",
    defaultPriorityFeePerGasWei: "100000000",
  },
  protocols: {},
  enabledProtocols: ["uniswap", "curve"],
} as never;

test("a bundle cannot spend the same dollars on two stableSwaps", { skip }, () => {
  const balances = {
    ethWei: 0n,
    wethWei: 0n,
    usdcUnits: 5_000n * USDC_UNIT,
    bases: { WETH: 0n },
    stables: {
      [TOKENS.USDC.address.toLowerCase()]: 5_000n * USDC_UNIT,
      [DAI!.token.toLowerCase()]: 0n,
    },
  };
  const leg = {
    type: "stableSwap",
    stable: "DAI",
    tokenIn: "USDC",
    amountIn: (5_000n * USDC_UNIT).toString(),
  };
  const single = validateAction(
    { type: "bundle", actions: [leg] } as never,
    AGENT_OBS,
    balances,
  );
  assert.equal(single.ok, true);
  // The second leg has to see the first one's spend. Before issue #27 wired stableSwap into
  // applyLeafSpend both legs validated against the same untouched 5,000 and the second reverted on
  // chain at the agent's expense.
  const doubled = validateAction(
    { type: "bundle", actions: [leg, leg] } as never,
    AGENT_OBS,
    balances,
  );
  assert.equal(doubled.ok, false);
});

test("the stable a bundle just bought is spendable by its next leg", { skip }, () => {
  const balances = {
    ethWei: 0n,
    wethWei: 0n,
    usdcUnits: 1_000n * USDC_UNIT,
    bases: { WETH: 0n },
    stables: {
      [TOKENS.USDC.address.toLowerCase()]: 1_000n * USDC_UNIT,
      [DAI!.token.toLowerCase()]: 0n,
    },
  };
  // Buy 1,000 USDC of DAI, then sell (almost) all of it back: the credit has to cross the decimal
  // difference, or the round trip reads as spending DAI the wallet does not have.
  const round = validateAction(
    {
      type: "bundle",
      actions: [
        {
          type: "stableSwap",
          stable: "DAI",
          tokenIn: "USDC",
          amountIn: (1_000n * USDC_UNIT).toString(),
        },
        {
          type: "stableSwap",
          stable: "DAI",
          tokenIn: "DAI",
          amountIn: (990n * WAD).toString(),
        },
      ],
    } as never,
    AGENT_OBS,
    balances,
  );
  assert.equal(round.ok, true);
});
