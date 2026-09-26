// The BTC/USD perp market: the keeper's oracle tokens and the collateral each market takes.
//
// The BTC/USD market (index WBTC, long WBTC, short USDC) was deployed and `base: "WBTC"` was accepted,
// but the keeper priced WETH and USDC only. Executing a BTC order therefore reverted with
// EmptyPrimaryPrice(WBTC); GMX reverts the whole execute rather than cancelling, the keeper only
// scans new logs, and the collateral plus the 0.03 ETH execution fee stayed in the OrderVault. And
// every collateral symbol that was not "WETH" was silently mapped to USDC, so WBTC collateral was
// impossible and WETH collateral on the BTC market was an order GMX could not fill.
//
// Runs under the local-deploy overlay because the fork registry is WETH/USDC only and has no BTC
// market. No chain: the keeper is driven with stub clients. The env is set before the dynamic
// imports, and node's test runner gives each file its own process.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

const gmx = await import("@eris/sdk/protocols/gmx.js");
const { gmxAdapter, EXECUTION_FEE } = gmx;
const { TOKENS, GMX, DEFAULT_ANVIL_PRIVATE_KEYS } =
  await import("@eris/sdk/constants.js");
const { gmxMarketAddresses } = await import("@eris/sdk/markets.js");
const { makeChain } = await import("@eris/sdk/chain.js");
const { PAR_STABLE_PRICES } = await import("@eris/sdk/stables.js");
type LeafAction = import("@eris/sdk/types.js").LeafAction;
type BalanceSnapshot = import("@eris/sdk/types.js").BalanceSnapshot;
type SimContext = import("@eris/sdk/protocols/types.js").SimContext;

const WETH = TOKENS.WETH.address;
const USDC = TOKENS.USDC.address;
const WBTC = TOKENS.WBTC?.address as Address;
const MARKETS = gmxMarketAddresses();

// The deployment's two markets, in the shape Reader.getMarket returns them.
const LAYOUTS = [
  {
    base: "WETH",
    market: MARKETS.WETH,
    props: {
      marketToken: MARKETS.WETH,
      indexToken: WETH,
      longToken: WETH,
      shortToken: USDC,
    },
  },
  {
    base: "WBTC",
    market: MARKETS.WBTC,
    props: {
      marketToken: MARKETS.WBTC,
      indexToken: WBTC,
      longToken: WBTC,
      shortToken: USDC,
    },
  },
];

// Checksummed, because that is how the calldata decodes.
const MOCK_PROVIDER = getAddress("0x00000000000000000000000000000000000000c1");

test("the local deploy has a BTC/USD gmx market (precondition for the rest)", () => {
  assert.ok(WBTC, "TOKENS.WBTC");
  assert.ok(MARKETS.WBTC, "MARKET_LEGS.gmx.WBTC");
  assert.deepEqual(gmx.gmxMarketLayoutProblems(LAYOUTS), []);
});

test("the keeper's oracle tokens cover the index, long and short token of every market", () => {
  const tokens = gmx.gmxOracleTokens(LAYOUTS.map((l) => l.props));
  // WETH and USDC first, as before; WBTC is what was missing.
  assert.deepEqual(tokens, [WETH, USDC, WBTC]);
  for (const { props } of LAYOUTS)
    for (const token of [props.indexToken, props.longToken, props.shortToken])
      assert.ok(tokens.includes(token), `${token} is priced`);
});

test("oracle tokens are deduplicated case-insensitively and skip a swap-only market's zero index", () => {
  const tokens = gmx.gmxOracleTokens([
    { indexToken: WETH, longToken: WETH, shortToken: USDC },
    {
      indexToken: zeroAddress,
      longToken: WETH.toLowerCase() as Address,
      shortToken: USDC,
    },
  ]);
  assert.deepEqual(tokens, [WETH, USDC]);
});

test("a market that is not [base-base-USDC] is named, since the collateral rule assumes the shape", () => {
  const synthetic = {
    base: "WBTC",
    market: MARKETS.WBTC,
    // A synthetic-index market (upstream's SOL/USD is [SOL-WETH-USDC]).
    props: {
      marketToken: MARKETS.WBTC,
      indexToken: WBTC,
      longToken: WETH,
      shortToken: USDC,
    },
  };
  const missing = {
    base: "WETH",
    market: MARKETS.WETH,
    props: {
      marketToken: zeroAddress,
      indexToken: zeroAddress,
      longToken: zeroAddress,
      shortToken: zeroAddress,
    },
  };
  const problems = gmx.gmxMarketLayoutProblems([synthetic, missing]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /WBTC .*expected \[WBTC-WBTC-USDC\]/);
  assert.match(problems[1], /WETH .*not a market on this deployment/);
});

// executeOrder(bytes32 key, (address[] tokens, address[] providers, bytes[] data) oracleParams)
const executeOrderAbi = [
  {
    type: "function",
    name: "executeOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      {
        name: "oracleParams",
        type: "tuple",
        components: [
          { name: "tokens", type: "address[]" },
          { name: "providers", type: "address[]" },
          { name: "data", type: "bytes[]" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

test("the keeper hands executeOrder a price for every oracle token, WBTC included", async () => {
  const orderKey = `0x${"ab".repeat(32)}` as Hex;
  const sent: Array<{ to: Address; data: Hex }> = [];
  const ctx = {
    publicClient: {
      getLogs: async () => [
        {
          topics: [
            `0x${"00".repeat(32)}`,
            keccak256(toBytes("OrderCreated")),
            orderKey,
          ],
        },
      ],
      getBlock: async () => ({ baseFeePerGas: 0n }),
    },
    walletClient: {
      sendTransaction: async (tx: { to: Address; data: Hex }) => {
        sent.push(tx);
        return `0x${"11".repeat(32)}` as Hex;
      },
    },
    chain: makeChain(31337),
    keeperPk: DEFAULT_ANVIL_PRIVATE_KEYS[2],
    gmx: {
      market: MARKETS.WETH,
      markets: MARKETS,
      mockProvider: MOCK_PROVIDER,
      oracleTokens: gmx.gmxOracleTokens(LAYOUTS.map((l) => l.props)),
    },
  } as unknown as SimContext;

  await gmxAdapter.afterMine!(ctx, {
    noMine: true,
    fromBlock: 10n,
    toBlock: 10n,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, GMX.OrderHandler);
  const { args } = decodeFunctionData({
    abi: executeOrderAbi,
    data: sent[0].data,
  });
  assert.equal(args[0], orderKey);
  const params = args[1];
  assert.deepEqual(params.tokens, [WETH, USDC, WBTC]);
  assert.deepEqual(params.providers, [
    MOCK_PROVIDER,
    MOCK_PROVIDER,
    MOCK_PROVIDER,
  ]);
  assert.deepEqual(params.data, ["0x", "0x", "0x"]);
});

// ---- collateral per market ----

const BALANCES: BalanceSnapshot = {
  ethWei: 10n * 10n ** 18n,
  wethWei: 0n,
  usdcUnits: 10_000n * 10n ** 6n,
  bases: { WETH: 0n, WBTC: 10n ** 7n }, // 0.1 WBTC
};
const SIZE = (1000n * 10n ** 30n).toString();

function increase(
  base: string | undefined,
  collateral: string,
  collateralAmount: string,
): LeafAction {
  const action = gmxAdapter.parse({
    type: "gmxIncrease",
    isLong: true,
    ...(base ? { base } : {}),
    collateral,
    collateralAmount,
    sizeDeltaUsd: SIZE,
  });
  assert.ok(action);
  return action;
}

const validate = (action: LeafAction) =>
  gmxAdapter.validate(action, {} as never, BALANCES);

test("each market takes its long token or USDC: ETH/USD takes WETH or USDC", () => {
  assert.deepEqual(gmx.gmxAllowedCollateral("WETH"), ["WETH", "USDC"]);
  assert.deepEqual(validate(increase(undefined, "WETH", "10")), { ok: true });
  assert.deepEqual(validate(increase(undefined, "USDC", "10")), { ok: true });
  const wbtc = validate(increase(undefined, "WBTC", "10"));
  assert.equal(wbtc.ok, false);
  assert.match(
    (wbtc as { reason: string }).reason,
    /collateral WBTC is not accepted on the gmx WETH\/USD market: it takes WETH or USDC/,
  );
});

test("each market takes its long token or USDC: BTC/USD takes WBTC or USDC, not WETH", () => {
  assert.deepEqual(gmx.gmxAllowedCollateral("WBTC"), ["WBTC", "USDC"]);
  assert.deepEqual(validate(increase("WBTC", "WBTC", "5000000")), { ok: true });
  assert.deepEqual(validate(increase("WBTC", "USDC", "10")), { ok: true });
  const weth = validate(increase("WBTC", "WETH", "10"));
  assert.equal(weth.ok, false);
  assert.match(
    (weth as { reason: string }).reason,
    /collateral WETH is not accepted on the gmx WBTC\/USD market: it takes WBTC or USDC/,
  );
});

test("WBTC collateral is checked against the wallet's WBTC balance", () => {
  const over = validate(increase("WBTC", "WBTC", (2n * 10n ** 7n).toString()));
  assert.deepEqual(over, {
    ok: false,
    reason: "collateralAmount exceeds WBTC balance",
  });
});

test("a decrease names its position by collateral, so the same market rule applies", () => {
  const action = gmxAdapter.parse({
    type: "gmxDecrease",
    isLong: true,
    base: "WBTC",
    collateral: "WETH",
    collateralDeltaAmount: "0",
    sizeDeltaUsd: SIZE,
  });
  assert.ok(action);
  const result = validate(action);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /takes WBTC or USDC/);
});

test("parse leaves the market rule to validate but still rejects a non-symbol collateral", () => {
  assert.throws(
    () =>
      gmxAdapter.parse({
        type: "gmxIncrease",
        isLong: true,
        collateral: 1,
        collateralAmount: "1",
        sizeDeltaUsd: SIZE,
      }),
    /collateral must be a token symbol/,
  );
});

// ExchangeRouter.multicall([...]) and the inner calls it batches.
const routerAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "sendWnt",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sendTokens",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const buildCtx = {
  gmx: { market: MARKETS.WETH, markets: MARKETS },
} as unknown as SimContext;

test("WBTC collateral is sent as an ERC-20 through the router to the BTC/USD market", async () => {
  const [tx] = await gmxAdapter.buildTxs(
    buildCtx,
    OWNER,
    increase("WBTC", "WBTC", "5000000"),
    undefined,
  );
  assert.equal(tx.to, GMX.ExchangeRouter);
  assert.equal(tx.value, EXECUTION_FEE);
  const outer = decodeFunctionData({ abi: routerAbi, data: tx.data as Hex });
  const inner = (outer.args![0] as Hex[])
    .slice(0, 2)
    .map((data) => decodeFunctionData({ abi: routerAbi, data }));
  assert.equal(inner[0].functionName, "sendWnt");
  assert.deepEqual(inner[1], {
    functionName: "sendTokens",
    args: [WBTC, GMX.OrderVault, 5_000_000n],
  });
  // The order itself targets the BTC/USD market with WBTC as its collateral token.
  const created = (outer.args![0] as Hex[])[2].toLowerCase();
  assert.ok(created.includes(MARKETS.WBTC.slice(2).toLowerCase()));
});

test("a collateral the market does not take never becomes an order", async () => {
  await assert.rejects(
    gmxAdapter.buildTxs(
      buildCtx,
      OWNER,
      increase("WBTC", "WETH", "10"),
      undefined,
    ),
    /collateral WETH is not accepted on the gmx WBTC\/USD market/,
  );
});

test("the router is approved for WBTC as well as USDC", async () => {
  const txs = await gmxAdapter.setupWallet!(buildCtx, OWNER);
  assert.deepEqual(
    txs.map((t) => t.to),
    [USDC, WBTC],
  );
});

// ---- valuation of BTC positions ----

test("a WBTC-collateral BTC position is valued at the WBTC fair price, not as 1e-6 dollars", async () => {
  const agent = { id: "a", address: OWNER };
  const position = (collateralToken: Address, collateralAmount: bigint) => ({
    addresses: { account: OWNER, market: MARKETS.WBTC, collateralToken },
    numbers: {
      sizeInUsd: 6000n * 10n ** 30n,
      sizeInTokens: 10n ** 7n, // 0.1 WBTC at $60,000 entry
      collateralAmount,
      fundingFeeAmountPerSize: 0n,
    },
    flags: { isLong: true },
  });
  const run = gmxAdapter.valueAtBlock!({
    publicClient: undefined as never,
    blockNumber: 1,
    horizonBlock: 1,
    agents: [agent],
    activeStables: [USDC],
    fairByBase: () => ({ WETH: 3000, WBTC: 61_000 }),
    stablePrices: () => PAR_STABLE_PRICES,
  });
  const first = await run.next(undefined as never);
  assert.equal(first.done, false);
  // stage 1 = [positions per agent, getMarket per market, GM balance per agent per market]
  const stage1 = [
    [
      position(WBTC, 5_000_000n), // 0.05 WBTC
      position(USDC, 2000n * 10n ** 6n),
    ],
    ...LAYOUTS.map((l) => l.props),
    ...LAYOUTS.map(() => 0n), // no GM balances
  ];
  const done = await run.next(stage1 as never);
  assert.equal(done.done, true);
  const value = (
    done.value as Record<string, { valueUsdc: number; unpriced: unknown[] }>
  ).a;
  // PnL of each: 0.1 WBTC x (61,000 - 60,000) = 100.
  const expected = 0.05 * 61_000 + 100 + 2000 + 100;
  assert.ok(
    Math.abs(value.valueUsdc - expected) < 1e-6,
    `${value.valueUsdc} vs ${expected}`,
  );
  assert.deepEqual(value.unpriced, []);
});
