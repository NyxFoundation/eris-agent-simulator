// The leverage cap is checked by the keeper before GMX checks it (sdk protocols/gmxLeverage.ts).
//
// GMX applies MIN_COLLATERAL_FACTOR inside executeOrder, at the execution price, and cancels a market
// order that fails it with the collateral and the (zero) execution fee refunded in the same
// transaction. An order sized just over the cap was therefore a free stop order: a WETH-collateral
// long at ~1.03x the cap filled only after a ~3% rise and otherwise came back at no cost, to be sent
// again the next block. The keeper sets the execution prices, so it now computes the position each
// order would leave at them and does not execute one over 98% of the cap; the order then stays in
// the OrderVault until its account cancels it (300 s). The reference runtime holds its own increases
// under 90% at the observed price.
//
// No chain: the keeper is driven with stub clients, as in gmxKeeperCallbacks.test.ts.
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
const { gmxAdapter, GMX_ORDER_TYPE, resetKeeperOrderQueue, toGmxPrice } = gmx;
const {
  gmxCapRefusal,
  gmxCapUse,
  gmxOwnCapUse,
  GMX_KEEPER_CAP_USE,
  GMX_RUNTIME_CAP_USE,
} = await import("@eris/sdk/protocols/gmxLeverage.js");
const keys = await import("@eris/sdk/protocols/gmxKeys.js");
const {
  GMX_MAX_LEVERAGE,
  GMX_MIN_COLLATERAL_FACTOR,
  gmxMinCollateralFactorKey,
  gmxPositionFeeFactorKey,
  gmxPositionKey,
} = keys;
const { GMX, TOKENS, DEFAULT_ANVIL_PRIVATE_KEYS } =
  await import("@eris/sdk/constants.js");
const { gmxMarketAddresses } = await import("@eris/sdk/markets.js");
const { makeChain } = await import("@eris/sdk/chain.js");
type SimContext = import("@eris/sdk/protocols/types.js").SimContext;
type GmxCapPosition = import("@eris/sdk/protocols/gmxLeverage.js").GmxCapPosition;
type AgentObservation = import("@eris/sdk/types.js").AgentObservation;

const MARKETS = gmxMarketAddresses();
const WETH = TOKENS.WETH.address;
const USDC = TOKENS.USDC.address;
const ONE_WETH = 10n ** 18n;
// USD at GMX's 30 decimals.
const usd = (v: number): bigint => BigInt(Math.round(v * 1e6)) * 10n ** 24n;
const FEE = 6n * 10n ** 26n; // 0.06%, the deploy's larger position fee
const marketAt = (collateralPrice: bigint, extra: object = {}) => ({
  collateralPrice,
  minCollateralFactor: GMX_MIN_COLLATERAL_FACTOR,
  feeFactor: FEE,
  ...extra,
});
const wethAt = (price: number) => marketAt(toGmxPrice(price, 18));
const usdcCollateral = marketAt(toGmxPrice(1, 6));
const FACTOR = 0.198;
const FEE_NUM = 0.0006;
// The size at which a fresh position on `collateralUsd` uses `u` of the cap, fees on both ends:
// S x factor = u x (C - 2 x fee x S).
const sizeAt = (u: number, collateralUsd: number): bigint =>
  usd((u * collateralUsd) / (FACTOR + 2 * u * FEE_NUM));
const KEEPER = (use: ReturnType<typeof gmxCapUse>) =>
  gmxCapRefusal(use, {
    maxUse: GMX_KEEPER_CAP_USE,
    maxLeverage: GMX_MAX_LEVERAGE,
    where: "the execution price",
  });

// ---- the computation ----

test("a WETH-collateral long sized over the cap clears it only after a rise; the keeper's line is 98%", () => {
  // 1 WETH at $3,000, sized at 1.03x the cap: the free stop order.
  const order = { kind: "increase" as const, sizeDeltaUsd: sizeAt(1.03, 3000), collateralDeltaAmount: ONE_WETH };
  const flat = gmxCapUse(order, undefined, wethAt(3000))!;
  const up4 = gmxCapUse(order, undefined, wethAt(3120))!;
  const up10 = gmxCapUse(order, undefined, wethAt(3300))!;
  assert.ok(Math.abs(flat.capUse - 1.03) < 1e-3, String(flat.capUse));
  // The collateral is worth more after a rise, so the same order uses less of the cap.
  assert.ok(flat.capUse > up4.capUse && up4.capUse > up10.capUse);
  // +4%: under GMX's own line (GMX would fill it) but over the keeper's -- refused, not left to GMX.
  assert.ok(up4.capUse < 1 && up4.capUse > GMX_KEEPER_CAP_USE, String(up4.capUse));
  const sizeUsd = Number(order.sizeDeltaUsd) / 1e30;
  assert.ok(sizeUsd * FACTOR < 3120 - 2 * FEE_NUM * sizeUsd, "GMX's own check passes at +4%");
  assert.match(String(KEEPER(up4)), /^would leave the position at 5\.00x \(size \/ equity\) at the execution price, over 4\.95x \(98% of the 5\.05x cap\)$/);
  assert.notEqual(KEEPER(flat), null);
  // +10%: comfortably under; executes like any other order.
  assert.equal(KEEPER(up10), null);
  assert.ok(up10.capUse < 0.94);
});

test("USDC collateral at the same size does not move with the price", () => {
  const order = { kind: "increase" as const, sizeDeltaUsd: sizeAt(1.03, 3000), collateralDeltaAmount: 3000n * 10n ** 6n };
  const use = gmxCapUse(order, undefined, usdcCollateral)!;
  assert.ok(Math.abs(use.capUse - 1.03) < 1e-3);
  assert.notEqual(KEEPER(use), null);
  // Opening fee out of the collateral, closing fee out of the equity: equity binds a fresh position.
  assert.equal(use.binding, "equity");
  assert.ok(use.collateralAfterUsd! > use.equityAfterUsd);
});

test("an add-on to a standing short counts the short's PnL, so the price decides", () => {
  // A $10,000 short standing at the cap on 2,000 USDC; the add-on brings $5,000 more on 1,100 USDC,
  // enough for its own size (~4.5x), so the whole position is what decides (collateral test 0.96).
  const position = (pnl: number): GmxCapPosition => ({
    sizeInUsd: usd(10_000),
    collateralAmount: 2000n * 10n ** 6n,
    pnlUsd: usd(pnl),
    pendingFeeAmount: 0n,
  });
  const order = { kind: "increase" as const, sizeDeltaUsd: usd(5000), collateralDeltaAmount: 1100n * 10n ** 6n };
  const own = gmxOwnCapUse(order, usdcCollateral)!;
  assert.ok(own.capUse < GMX_KEEPER_CAP_USE, String(own.capUse));
  assert.ok(gmxCapUse({ ...order, sizeDeltaUsd: 1n, collateralDeltaAmount: 0n }, position(0), usdcCollateral)!.capUse > 0.99, "at the cap");
  // Back at the short's entry (it rose 5% and fell back): PnL 0, under the line.
  const atEntry = gmxCapUse(order, position(0), usdcCollateral)!;
  // +1% from entry: PnL -100. GMX's equity 3,097 - 100 - 9 = 2,988 covers 15,000 x 0.198 = 2,970, so
  // GMX would fill it; the keeper does not.
  const up1 = gmxCapUse(order, position(-100), usdcCollateral)!;
  // +5% from entry (where it was observed): PnL -500, over GMX's line too.
  const up5 = gmxCapUse(order, position(-500), usdcCollateral)!;
  assert.equal(KEEPER(atEntry), null);
  assert.ok(atEntry.capUse < GMX_KEEPER_CAP_USE);
  assert.ok(up1.capUse > GMX_KEEPER_CAP_USE && up1.capUse < 1, String(up1.capUse));
  assert.notEqual(KEEPER(up1), null);
  assert.ok(up5.capUse > 1);
  assert.equal(up5.binding, "equity");
  // What the position owes in borrowing and funding comes out of the collateral first.
  const owing = gmxCapUse(order, { ...position(0), pendingFeeAmount: 50n * 10n ** 6n }, usdcCollateral)!;
  assert.ok(owing.capUse > atEntry.capUse);
});

test("an increase must bring collateral for its own size, whatever the position it joins", () => {
  // GMX accepts an increase with size and no collateral. Against a well-collateralized position the
  // whole stays under the line, but the order itself posts nothing: it is refused at every price, so
  // re-sending it every block buys no option, and a refused increase always locks its own margin.
  const roomy: GmxCapPosition = {
    sizeInUsd: usd(2000),
    collateralAmount: 5000n * 10n ** 6n,
    pnlUsd: usd(0),
    pendingFeeAmount: 0n,
  };
  const empty = { kind: "increase" as const, sizeDeltaUsd: usd(5000), collateralDeltaAmount: 0n };
  assert.ok(gmxCapUse(empty, roomy, usdcCollateral)!.capUse < 0.5);
  const own = gmxOwnCapUse(empty, usdcCollateral)!;
  assert.equal(own.capUse, Infinity);
  const ownRefusal = (use: ReturnType<typeof gmxOwnCapUse>) =>
    gmxCapRefusal(use, {
      maxUse: GMX_KEEPER_CAP_USE,
      maxLeverage: GMX_MAX_LEVERAGE,
      where: "the execution price",
      own: true,
    });
  assert.match(
    String(ownRefusal(own)),
    /^brings no collateral for its own size at the execution price, over 4\.95x \(98% of the 5\.05x cap\): an increase must bring the collateral for its own size$/,
  );
  // WETH collateral: the same add-on with 0.2 WETH ($600 at $3,000) is ~8.4x on its own, refused at
  // $3,000 and still at +20%; with ~1,040 USDC-worth it passes. Its own lockup is at least size / 4.95.
  const thin = { kind: "increase" as const, sizeDeltaUsd: usd(5000), collateralDeltaAmount: 2n * 10n ** 17n };
  assert.notEqual(ownRefusal(gmxOwnCapUse(thin, wethAt(3000))), null);
  assert.notEqual(ownRefusal(gmxOwnCapUse(thin, wethAt(3600))), null);
  assert.equal(
    ownRefusal(gmxOwnCapUse({ ...thin, collateralDeltaAmount: 35n * 10n ** 16n }, wethAt(3000))),
    null,
  );
  // Decreases have no own-collateral test.
  assert.equal(gmxOwnCapUse({ kind: "decrease", sizeDeltaUsd: usd(1), collateralDeltaAmount: 0n }, usdcCollateral), null);
});

test("a withdrawal is checked on collateral alone, a partial rest with its PnL", () => {
  // 1 WETH backing a $9,000 long (3x) that is $1,500 up.
  const position: GmxCapPosition = {
    sizeInUsd: usd(9000),
    collateralAmount: ONE_WETH,
    pnlUsd: usd(1500),
    pendingFeeAmount: 0n,
  };
  const withdraw = (weth: number) =>
    gmxCapUse(
      { kind: "decrease", sizeDeltaUsd: 0n, collateralDeltaAmount: BigInt(weth * 1e6) * 10n ** 12n },
      position,
      wethAt(3000),
    )!;
  // 0.6 WETH left = $1,800 against 9,000 x 0.198 = 1,782: GMX would zero (here: cancel, no size) it,
  // however much the position is up.
  const deep = withdraw(0.4);
  assert.equal(deep.binding, "collateral");
  assert.ok(Math.abs(deep.capUse - 0.99) < 1e-3, String(deep.capUse));
  assert.notEqual(KEEPER(deep), null);
  assert.equal(KEEPER(withdraw(0.3)), null);
  // More than the position holds is capped at what it holds -- and leaves nothing.
  assert.equal(withdraw(5).capUse, Infinity);
  assert.match(String(KEEPER(withdraw(5))), /with no collateral/);
});

test("a partial decrease that leaves the rest over the cap is refused; enough of one, or a full close, is not", () => {
  // $5,500 long on 1,000 USDC, $200 down: ~6.9x, over the cap (still above liquidation).
  const position: GmxCapPosition = {
    sizeInUsd: usd(5500),
    collateralAmount: 1000n * 10n ** 6n,
    pnlUsd: usd(-200),
    pendingFeeAmount: 0n,
  };
  const decrease = (sizeUsd: number, withdraw = 0n) =>
    gmxCapUse({ kind: "decrease", sizeDeltaUsd: usd(sizeUsd), collateralDeltaAmount: withdraw }, position, usdcCollateral);
  const tenth = decrease(550)!;
  assert.ok(tenth.capUse > 1.2, String(tenth.capUse));
  assert.equal(tenth.collateralAfterUsd, undefined, "nothing withdrawn: only what remains is checked");
  assert.notEqual(KEEPER(tenth), null);
  const most = decrease(3300)!;
  assert.ok(most.capUse < 0.6, String(most.capUse));
  assert.equal(KEEPER(most), null);
  // Not subject to the cap at all.
  assert.equal(decrease(5500), null, "a full close always executes");
  assert.equal(decrease(9999), null, "over the size: GMX reverts at any price");
  assert.equal(decrease(0), null, "changes nothing");
  assert.equal(
    gmxCapUse({ kind: "decrease", sizeDeltaUsd: usd(100), collateralDeltaAmount: 0n }, undefined, usdcCollateral),
    null,
    "no position: GMX reverts at any price",
  );
  assert.equal(
    gmxCapUse({ kind: "increase", sizeDeltaUsd: 0n, collateralDeltaAmount: 10n ** 6n }, position, usdcCollateral),
    null,
    "a deposit is checked by GMX against the liquidation factor, not the cap",
  );
});

test("the open-interest factor raises the collateral test, the UI fee and impact cap the equity", () => {
  const order = { kind: "increase" as const, sizeDeltaUsd: usd(10_000), collateralDeltaAmount: 2500n * 10n ** 6n };
  const plain = gmxCapUse(order, undefined, usdcCollateral)!;
  // OI after the order x multiplier = 0.25 > 0.198: GMX uses the larger factor for the collateral test.
  const crowded = gmxCapUse(order, undefined, marketAt(toGmxPrice(1, 6), {
    openInterestUsd: usd(990_000),
    oiMultiplierFactor: 25n * 10n ** 22n, // 0.25 per $1M
  }))!;
  assert.equal(crowded.binding, "collateral");
  assert.ok(crowded.capUse > plain.capUse);
  const costly = gmxCapUse(order, undefined, marketAt(toGmxPrice(1, 6), {
    feeFactor: FEE + 5n * 10n ** 25n,
    maxImpactFactorForLiquidations: 5n * 10n ** 27n,
  }))!;
  assert.ok(costly.equityAfterUsd < plain.equityAfterUsd);
  assert.ok(costly.capUse > plain.capUse);
  // No factor configured: no cap to apply.
  assert.equal(gmxCapUse(order, undefined, marketAt(toGmxPrice(1, 6), { minCollateralFactor: 0n })), null);
});

// ---- the keeper ----

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

const ACCOUNT = getAddress(`0x${"a1".repeat(20)}`);
const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

type StubOrder = {
  account?: Address;
  orderType?: number;
  collateralToken?: Address;
  swapPath?: Address[];
  isLong?: boolean;
  sizeDeltaUsd: bigint;
  collateralDeltaAmount: bigint;
};

// A position as Reader.getPosition / getPositionInfo return it, at the stub's prices.
type StubPosition = {
  sizeInUsd: bigint;
  collateralAmount: bigint;
  basePnlUsd: bigint;
};

function keeperCtx(
  orders: Map<Hex, StubOrder>,
  opts: {
    wethPrice: number;
    positions?: Map<Hex, StubPosition>;
    failPositionReads?: boolean;
  },
): { ctx: SimContext; executed: Hex[]; multicalls: number } {
  const executed: Hex[] = [];
  const state = { multicalls: 0 };
  const uints = new Map<string, bigint>([
    [gmxMinCollateralFactorKey(MARKETS.WETH).toLowerCase(), GMX_MIN_COLLATERAL_FACTOR],
    [gmxPositionFeeFactorKey(MARKETS.WETH, true).toLowerCase(), 4n * 10n ** 26n],
    [gmxPositionFeeFactorKey(MARKETS.WETH, false).toLowerCase(), FEE],
  ]);
  const ctx = {
    fairPrices: { WETH: opts.wethPrice },
    publicClient: {
      getLogs: async () =>
        [...orders.keys()].map((k) => ({
          topics: [`0x${"00".repeat(32)}`, keccak256(toBytes("OrderCreated")), k],
        })),
      getBlock: async () => ({ baseFeePerGas: 0n }),
      readContract: async (call: { functionName: string; args: [Address, Hex] }) => {
        // The liquidation scan after the fills: nothing open.
        if (call.functionName === "getBytes32Count") return 0n;
        assert.equal(call.functionName, "getOrder");
        const order = orders.get(call.args[1]);
        if (!order)
          return {
            addresses: { account: zeroAddress, callbackContract: zeroAddress, market: zeroAddress, initialCollateralToken: zeroAddress, swapPath: [] },
            numbers: { orderType: 0, sizeDeltaUsd: 0n, initialCollateralDeltaAmount: 0n, callbackGasLimit: 0n },
            flags: { isLong: false },
          };
        return {
          addresses: {
            account: order.account ?? ACCOUNT,
            callbackContract: zeroAddress,
            market: MARKETS.WETH,
            initialCollateralToken: order.collateralToken ?? WETH,
            swapPath: order.swapPath ?? [],
          },
          numbers: {
            orderType: order.orderType ?? GMX_ORDER_TYPE.MarketIncrease,
            sizeDeltaUsd: order.sizeDeltaUsd,
            initialCollateralDeltaAmount: order.collateralDeltaAmount,
            callbackGasLimit: 0n,
          },
          flags: { isLong: order.isLong ?? true },
        };
      },
      multicall: async (req: {
        contracts: Array<{ functionName: string; args: unknown[] }>;
      }) => {
        state.multicalls += 1;
        return req.contracts.map((c) => {
          switch (c.functionName) {
            case "getMarket":
              return {
                status: "success",
                result: { marketToken: MARKETS.WETH, indexToken: WETH, longToken: WETH, shortToken: USDC },
              };
            case "getUint":
              return { status: "success", result: uints.get((c.args[0] as Hex).toLowerCase()) ?? 0n };
            case "getPosition": {
              if (opts.failPositionReads) return { status: "failure", error: new Error("rpc") };
              const p = opts.positions?.get(c.args[1] as Hex);
              return {
                status: "success",
                result: {
                  addresses: { account: zeroAddress, market: zeroAddress, collateralToken: zeroAddress },
                  numbers: { sizeInUsd: p?.sizeInUsd ?? 0n, sizeInTokens: 0n, collateralAmount: p?.collateralAmount ?? 0n },
                  flags: { isLong: true },
                },
              };
            }
            case "getPositionInfo": {
              const p = opts.positions?.get(c.args[2] as Hex);
              if (!p) return { status: "failure", error: new Error("EmptyPosition") };
              // The prices the keeper hands the Reader are the ones it will execute at.
              const prices = c.args[3] as { indexTokenPrice: { min: bigint } };
              assert.equal(prices.indexTokenPrice.min, toGmxPrice(opts.wethPrice, 18));
              return {
                status: "success",
                result: {
                  fees: { funding: { fundingFeeAmount: 0n }, borrowing: { borrowingFeeAmount: 0n } },
                  executionPriceResult: { totalImpactUsd: 0n },
                  basePnlUsd: p.basePnlUsd,
                },
              };
            }
            default:
              throw new Error(`unexpected ${c.functionName}`);
          }
        });
      },
    },
    walletClient: {
      sendTransaction: async (tx: { data: Hex }) => {
        const { args } = decodeFunctionData({ abi: executeOrderAbi, data: tx.data });
        executed.push(args[0]);
        return `0x${"11".repeat(32)}` as Hex;
      },
    },
    chain: makeChain(31337),
    keeperPk: DEFAULT_ANVIL_PRIVATE_KEYS[2],
    gmx: {
      market: MARKETS.WETH,
      markets: MARKETS,
      mockProvider: getAddress(`0x${"0f".repeat(20)}`),
      oracleTokens: [WETH, USDC],
    },
  } as unknown as SimContext;
  return {
    ctx,
    executed,
    get multicalls() {
      return state.multicalls;
    },
  };
}

type Refusal = { key: string; reason: string; capUse?: number; leverage?: number };
async function pass(ctx: SimContext, block: bigint) {
  const refused: Refusal[] = [];
  const deferred: Array<{ sent: number; deferred: number; samePosition?: number }> = [];
  const retried: Array<{ key: string; attempt: number; maxAttempts: number; reason: string }> = [];
  await gmxAdapter.afterMine!(ctx, {
    noMine: true,
    fromBlock: block,
    toBlock: block,
    onOrderRefused: (r) => refused.push(r),
    onOrdersDeferred: (r) => deferred.push(r),
    onOrderReadRetry: (r) => retried.push(r),
  });
  return { refused, deferred, retried };
}

test("the keeper refuses an over-cap long at a price where GMX would fill it, and fills it under its line", async () => {
  const order = { sizeDeltaUsd: sizeAt(1.03, 3000), collateralDeltaAmount: ONE_WETH };
  for (const [price, fills] of [
    [3000, false], // over GMX's line: GMX would have cancelled and refunded it for free
    [3120, false], // under GMX's line, over the keeper's: GMX would have filled it
    [3300, true],
  ] as const) {
    resetKeeperOrderQueue();
    const { ctx, executed } = keeperCtx(new Map([[key(1), order]]), { wethPrice: price });
    const { refused } = await pass(ctx, 10n);
    if (fills) {
      assert.deepEqual(executed, [key(1)], `$${price}`);
      assert.deepEqual(refused, []);
      continue;
    }
    assert.deepEqual(executed, [], `$${price}: no executeOrder sent`);
    assert.equal(refused.length, 1);
    assert.ok(refused[0].capUse! > GMX_KEEPER_CAP_USE, String(refused[0].capUse));
    assert.ok(refused[0].leverage! > 4.95);
    assert.match(refused[0].reason, /over 4\.95x \(98% of the 5\.05x cap\)/);
    assert.match(refused[0].reason, /stay in the OrderVault until the account cancels the order/);
  }
  // A refused order is not queued: the next pass, at any price, does not execute it.
  resetKeeperOrderQueue();
  const { ctx, executed } = keeperCtx(new Map([[key(1), order]]), { wethPrice: 3120 });
  await pass(ctx, 10n);
  (ctx.publicClient as unknown as { getLogs: () => Promise<unknown[]> }).getLogs = async () => [];
  (ctx as { fairPrices: Record<string, number> }).fairPrices = { WETH: 4000 };
  await pass(ctx, 11n);
  assert.deepEqual(executed, []);
  resetKeeperOrderQueue();
});

test("an add-on is judged with the position it joins, priced at the execution price", async () => {
  resetKeeperOrderQueue();
  // A $10,000 short standing at the cap on 2,000 USDC, $100 down at the execution price; the add-on
  // carries its own size (~4.5x on 1,100 USDC) but takes the whole over 98%.
  const positionKey = gmxPositionKey(ACCOUNT, MARKETS.WETH, USDC, false);
  const addOn = (collateral: bigint) =>
    new Map([
      [key(1), { collateralToken: USDC, isLong: false, sizeDeltaUsd: usd(5000), collateralDeltaAmount: collateral }],
    ]);
  const short = (pnl: number) =>
    new Map([[positionKey, { sizeInUsd: usd(10_000), collateralAmount: 2000n * 10n ** 6n, basePnlUsd: usd(pnl) }]]);
  const down = keeperCtx(addOn(1100n * 10n ** 6n), { wethPrice: 3030, positions: short(-100) });
  const refusedDown = (await pass(down.ctx, 10n)).refused;
  assert.equal(refusedDown.length, 1);
  assert.match(refusedDown[0].reason, /^would leave the position at/);
  assert.deepEqual(down.executed, []);
  resetKeeperOrderQueue();
  const flat = keeperCtx(addOn(1100n * 10n ** 6n), { wethPrice: 3000, positions: short(0) });
  assert.deepEqual((await pass(flat.ctx, 10n)).refused, []);
  assert.deepEqual(flat.executed, [key(1)]);
  resetKeeperOrderQueue();
  // The same add-on posting nothing is refused at every price -- here, after a drop that puts the
  // short $1,000 up, where the whole position would be well under the line.
  const empty = keeperCtx(addOn(0n), { wethPrice: 2700, positions: short(1000) });
  const refusedEmpty = (await pass(empty.ctx, 10n)).refused;
  assert.deepEqual(empty.executed, []);
  assert.match(refusedEmpty[0].reason, /^brings no collateral for its own size at the execution price/);
  resetKeeperOrderQueue();
});

test("a second order on the same position waits a block; other positions and swaps do not", async () => {
  resetKeeperOrderQueue();
  const small = { sizeDeltaUsd: usd(1000), collateralDeltaAmount: ONE_WETH };
  const orders = new Map<Hex, StubOrder>([
    [key(1), small],
    [key(2), small], // same account, market, collateral, side
    [key(3), { ...small, isLong: false }], // the account's short: another position
    [key(4), { orderType: GMX_ORDER_TYPE.MarketSwap, sizeDeltaUsd: 0n, collateralDeltaAmount: 10n ** 6n }],
    [key(5), { ...small, account: getAddress(`0x${"b2".repeat(20)}`) }],
  ]);
  const { ctx, executed } = keeperCtx(orders, { wethPrice: 3000 });
  const { deferred } = await pass(ctx, 10n);
  assert.deepEqual(executed, [key(1), key(3), key(4), key(5)]);
  assert.deepEqual(deferred, [{ sent: 4, deferred: 1, samePosition: 1 }]);
  // Next block it is checked against the position the first one left, and goes.
  (ctx.publicClient as unknown as { getLogs: () => Promise<unknown[]> }).getLogs = async () => [];
  await pass(ctx, 11n);
  assert.deepEqual(executed.slice(4), [key(2)]);
  resetKeeperOrderQueue();
});

test("an increase that swaps its collateral is refused; one whose position cannot be read waits, then is refused", async () => {
  resetKeeperOrderQueue();
  const swapped = keeperCtx(
    new Map([[key(1), { swapPath: [MARKETS.WETH], collateralToken: USDC, sizeDeltaUsd: usd(1000), collateralDeltaAmount: 10n ** 9n }]]),
    { wethPrice: 3000 },
  );
  const a = await pass(swapped.ctx, 10n);
  assert.deepEqual(swapped.executed, []);
  assert.match(a.refused[0].reason, /swaps its collateral through 1 market/);
  resetKeeperOrderQueue();
  const unread = keeperCtx(
    new Map([[key(1), { sizeDeltaUsd: usd(1000), collateralDeltaAmount: ONE_WETH }]]),
    { wethPrice: 3000, failPositionReads: true },
  );
  // A failed read is the environment's fault: the order is not executed and waits for the next pass.
  const first = await pass(unread.ctx, 10n);
  assert.deepEqual(unread.executed, []);
  assert.deepEqual(first.refused, []);
  assert.deepEqual(first.retried, [
    {
      key: key(1),
      attempt: 1,
      maxAttempts: 3,
      reason: "the order's leverage inputs could not be read: the position could not be read",
    },
  ]);
  // Unreadable for GMX_KEEPER_READ_ATTEMPTS passes in a row: refused, never executed unchecked.
  (unread.ctx.publicClient as unknown as { getLogs: () => Promise<unknown[]> }).getLogs = async () => [];
  assert.equal((await pass(unread.ctx, 11n)).retried.length, 1);
  const third = await pass(unread.ctx, 12n);
  assert.deepEqual(unread.executed, []);
  assert.match(
    third.refused[0].reason,
    /^the order's leverage inputs could not be read in 3 passes in a row, so the order is not executed: the position could not be read$/,
  );
  resetKeeperOrderQueue();
});

test("a deposit and a swap need no cap reads at all", async () => {
  resetKeeperOrderQueue();
  const orders = new Map<Hex, StubOrder>([
    [key(1), { sizeDeltaUsd: 0n, collateralDeltaAmount: ONE_WETH }],
    [key(2), { orderType: GMX_ORDER_TYPE.MarketSwap, sizeDeltaUsd: 0n, collateralDeltaAmount: 10n ** 6n }],
  ]);
  const stub = keeperCtx(orders, { wethPrice: 3000 });
  await pass(stub.ctx, 10n);
  assert.deepEqual(stub.executed, [key(1), key(2)]);
  assert.equal(stub.multicalls, 0);
  resetKeeperOrderQueue();
});

// ---- the reference runtime ----

const BALANCES = {
  ethWei: 10n * ONE_WETH,
  wethWei: 0n,
  usdcUnits: 100_000n * 10n ** 6n,
  bases: { WETH: 0n },
};

function observation(position?: object): AgentObservation {
  return {
    protocols: {
      gmx: {
        marketPriceUsd: 3000,
        maxLeverage: 5.05,
        ...(position ? { position } : {}),
      },
    },
  } as unknown as AgentObservation;
}

function action(fields: Record<string, unknown>) {
  const parsed = gmxAdapter.parse({ isLong: true, collateral: "WETH", ...fields });
  assert.ok(parsed);
  return parsed;
}

test("the reference runtime does not send an increase over 90% of the cap at the observed price", () => {
  const increase = (u: number) =>
    action({
      type: "gmxIncrease",
      collateralAmount: ONE_WETH.toString(),
      sizeDeltaUsd: sizeAt(u, 3000).toString(),
    });
  assert.deepEqual(gmxAdapter.validate(increase(0.85), observation(), BALANCES), { ok: true });
  const over = gmxAdapter.validate(increase(0.93), observation(), BALANCES);
  assert.equal(over.ok, false);
  assert.match(
    (over as { reason: string }).reason,
    // A fresh position: its own margin and the position it opens are the same numbers, and the
    // order's own margin is named first.
    /^gmx increase would carry its own size at 4\.\d\dx on its own collateral \(size \/ equity\) at the observed price, over 4\.5\dx \(90% of the 5\.05x cap\): an increase must bring the collateral for its own size\. The keeper does not execute an order over 98% of the cap/,
  );
  assert.equal(GMX_RUNTIME_CAP_USE, 0.9);
  // No observation of the market: nothing to judge by, the keeper decides.
  assert.deepEqual(gmxAdapter.validate(increase(0.93), {} as never, BALANCES), { ok: true });
});

test("the runtime counts the position held on the same side and collateral", () => {
  // Already a $10,000 long on 1 WETH; adding $2,000 on 0.2 WETH lands at ~4.0x -- unless the long is
  // $1,000 down, which its equity carries into the add-on (~4.6x, over 90%).
  const held = (pnlUsd: number) => ({
    isLong: true,
    sizeUsd: usd(10_000).toString(),
    sizeInTokens: "0",
    collateral: "WETH",
    collateralAmount: ONE_WETH.toString(),
    entryPriceUsd: 3000,
    pnlUsd,
  });
  const addOn = action({
    type: "gmxIncrease",
    collateralAmount: (2n * 10n ** 17n).toString(),
    sizeDeltaUsd: usd(2000).toString(),
  });
  assert.deepEqual(gmxAdapter.validate(addOn, observation(held(0)), BALANCES), { ok: true });
  const down = gmxAdapter.validate(addOn, observation(held(-1000)), BALANCES);
  assert.equal(down.ok, false);
  assert.match((down as { reason: string }).reason, /size \/ equity/);
  // A short is another position: the long's loss is not counted against it.
  assert.deepEqual(
    gmxAdapter.validate(
      action({ type: "gmxIncrease", isLong: false, collateralAmount: ONE_WETH.toString(), sizeDeltaUsd: usd(3000).toString() }),
      observation(held(-2000)),
      BALANCES,
    ),
    { ok: true },
  );
  // A withdrawal that would take the long over 90% is not sent: GMX tests it on collateral alone
  // (1,500 against 9,000 x 0.198), so being $1,000 up does not help. A plain partial decrease is the
  // keeper's to judge.
  const withdraw = action({
    type: "gmxDecrease",
    collateralDeltaAmount: (5n * 10n ** 17n).toString(),
    sizeDeltaUsd: usd(1000).toString(),
  });
  const w = gmxAdapter.validate(withdraw, observation(held(1000)), BALANCES);
  assert.equal(w.ok, false);
  assert.match((w as { reason: string }).reason, /^gmx collateral withdrawal would leave the position at \d\.\d\dx \(size \/ collateral\)/);
  const reduce = action({
    type: "gmxDecrease",
    collateralDeltaAmount: "0",
    sizeDeltaUsd: usd(1000).toString(),
  });
  assert.deepEqual(gmxAdapter.validate(reduce, observation(held(-1500)), BALANCES), { ok: true });
});
