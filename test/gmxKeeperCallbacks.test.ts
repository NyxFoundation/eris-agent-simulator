// The keeper runs no participant code: no order callbacks, and (patched deploy) no receiver gas.
//
// GMX calls an order's callbackContract inside executeOrder, and the keeper's transaction sits just
// under the oracle's and above every participant. An order with a callback was therefore the
// creator's own code at the top of the next block -- able to take the previous block's AMM
// dislocation first, under the keeper's fee and gas and attributed to the keeper, and (the minimum
// execution fee being 0 on this deploy) to create the next such order from inside the callback.
// Two layers: the keeper reads each order and refuses one with a callbackContract (here), and the
// deploy patch zeroes both callback gas limits (deployer/vendor/gmx-localhost.patch, reported by
// core/src/realtime/gmxCallbacks.ts).
//
// No chain: the keeper is driven with stub clients, as in gmxBtcMarket.test.ts.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const {
  gmxAdapter,
  gmxKeeperRefusal,
  GMX_ORDER_TYPE,
  MAX_ORDER_FILLS_PER_BLOCK,
  resetKeeperOrderQueue,
} = gmx;
const { GMX, DEFAULT_ANVIL_PRIVATE_KEYS } =
  await import("@eris/sdk/constants.js");
const { gmxMarketAddresses } = await import("@eris/sdk/markets.js");
const { makeChain } = await import("@eris/sdk/chain.js");
const { gmxCallbackCheck, gmxCallbackOpenMessage } =
  await import("../core/src/realtime/gmxCallbacks.js");
type SimContext = import("@eris/sdk/protocols/types.js").SimContext;

const ACCOUNT = getAddress(`0x${"a1".repeat(20)}`);
const CALLBACK = getAddress(`0x${"cb".repeat(20)}`);
const MARKETS = gmxMarketAddresses();

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

type StubOrder = {
  account: Address;
  callbackContract: Address;
  callbackGasLimit: bigint;
  // Omitted = MarketIncrease, the type every SDK action creates.
  orderType?: number;
};

function stubCtx(orders: Map<Hex, StubOrder | Error>): {
  ctx: SimContext;
  executed: Hex[];
} {
  const executed: Hex[] = [];
  const ctx = {
    publicClient: {
      getLogs: async () =>
        [...orders.keys()].map((key) => ({
          topics: [
            `0x${"00".repeat(32)}`,
            keccak256(toBytes("OrderCreated")),
            key,
          ],
        })),
      getBlock: async () => ({ baseFeePerGas: 0n }),
      readContract: async (call: {
        address: Address;
        functionName: string;
        args: [Address, Hex];
      }) => {
        assert.equal(call.address, GMX.Reader);
        assert.equal(call.functionName, "getOrder");
        const order = orders.get(call.args[1]);
        if (order === undefined)
          return {
            addresses: { account: zeroAddress, callbackContract: zeroAddress },
            numbers: { callbackGasLimit: 0n, orderType: 0 },
          };
        if (order instanceof Error) throw order;
        return {
          addresses: {
            account: order.account,
            callbackContract: order.callbackContract,
          },
          numbers: {
            callbackGasLimit: order.callbackGasLimit,
            orderType: order.orderType ?? GMX_ORDER_TYPE.MarketIncrease,
          },
        };
      },
    },
    walletClient: {
      sendTransaction: async (tx: { data: Hex }) => {
        const { args } = decodeFunctionData({
          abi: executeOrderAbi,
          data: tx.data,
        });
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
      oracleTokens: [],
    },
  } as unknown as SimContext;
  return { ctx, executed };
}

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

test("an order with a callbackContract is refused; one without is executed", () => {
  assert.equal(
    gmxKeeperRefusal({
      account: ACCOUNT,
      callbackContract: zeroAddress,
      callbackGasLimit: 0n,
      orderType: GMX_ORDER_TYPE.MarketIncrease,
    }),
    null,
  );
  // Refused on the address alone: with gas limit 0 the refundExecutionFee callback still gets its
  // own DataStore limit, and GMX checks for code at execution time, not at creation.
  for (const callbackGasLimit of [0n, 2_000_000n]) {
    const reason = gmxKeeperRefusal({
      account: ACCOUNT,
      callbackContract: CALLBACK,
      callbackGasLimit,
      orderType: GMX_ORDER_TYPE.MarketIncrease,
    });
    assert.ok(reason?.includes(CALLBACK), String(reason));
  }
});

test("the keeper executes only the orders without a callback, and reports the rest", async () => {
  const orders = new Map<Hex, StubOrder | Error>([
    [
      key(1),
      { account: ACCOUNT, callbackContract: zeroAddress, callbackGasLimit: 0n },
    ],
    [
      key(2),
      {
        account: ACCOUNT,
        callbackContract: CALLBACK,
        callbackGasLimit: 2_000_000n,
      },
    ],
    [key(3), new Error("rpc timeout\nmore")],
    [
      key(5),
      { account: ACCOUNT, callbackContract: zeroAddress, callbackGasLimit: 0n },
    ],
  ]);
  // key(4): created and already gone (executed or cancelled) -- Reader returns an empty order.
  const withGone = new Map(orders);
  withGone.set(key(4), undefined as never);
  const { ctx, executed } = stubCtx(withGone);
  const refused: Array<{
    key: string;
    reason: string;
    callbackContract: string;
  }> = [];
  await gmxAdapter.afterMine!(ctx, {
    noMine: true,
    fromBlock: 10n,
    toBlock: 10n,
    onOrderRefused: (r) => refused.push(r),
  });
  assert.deepEqual(executed, [key(1), key(5)]);
  assert.deepEqual(
    refused.map((r) => r.key),
    [key(2), key(3)],
  );
  assert.equal(refused[0].callbackContract, CALLBACK);
  // An order that could not be read is not executed (fail closed), and the reason is one line.
  assert.match(refused[1].reason, /could not be read: rpc timeout$/);
});

// ---- market orders only ----
//
// The keeper tries each new order once, in the next block, at that block's oracle price (written
// before the block is mined). A stop re-armed every block was therefore a zero-lag conditional
// order: it filled at the first block of a crash/spike gap and rode the rest of the ramp, where
// everyone else fills a block after observing. Conditional orders are refused, not executed.

test("market swaps, increases and decreases pass; limit, stop and liquidation orders are refused", () => {
  const order = (orderType: number) => ({
    account: ACCOUNT,
    callbackContract: zeroAddress,
    callbackGasLimit: 0n,
    orderType,
  });
  for (const t of [
    GMX_ORDER_TYPE.MarketSwap,
    GMX_ORDER_TYPE.MarketIncrease,
    GMX_ORDER_TYPE.MarketDecrease,
  ])
    assert.equal(gmxKeeperRefusal(order(t)), null, `type ${t}`);
  for (const t of [
    GMX_ORDER_TYPE.LimitSwap,
    GMX_ORDER_TYPE.LimitIncrease,
    GMX_ORDER_TYPE.LimitDecrease,
    GMX_ORDER_TYPE.StopLossDecrease,
    GMX_ORDER_TYPE.Liquidation,
    GMX_ORDER_TYPE.StopIncrease,
    // A value past the enum (a future GMX type) is not a market order either.
    9,
  ]) {
    const reason = gmxKeeperRefusal(order(t));
    assert.match(
      String(reason),
      new RegExp(`^non-market order type ${t}: the keeper executes market orders only`),
    );
  }
  // The callback refusal still applies to a market order.
  assert.ok(
    gmxKeeperRefusal({ ...order(GMX_ORDER_TYPE.MarketIncrease), callbackContract: CALLBACK })?.includes(
      CALLBACK,
    ),
  );
});

test("the keeper sends no executeOrder for a stop or limit order and reports it", async () => {
  resetKeeperOrderQueue();
  const plain = { account: ACCOUNT, callbackContract: zeroAddress, callbackGasLimit: 0n };
  const orders = new Map<Hex, StubOrder | Error>([
    [key(1), { ...plain, orderType: GMX_ORDER_TYPE.StopIncrease }],
    [key(2), { ...plain, orderType: GMX_ORDER_TYPE.MarketIncrease }],
    [key(3), { ...plain, orderType: GMX_ORDER_TYPE.LimitIncrease }],
    [key(4), { ...plain, orderType: GMX_ORDER_TYPE.MarketDecrease }],
    [key(5), { ...plain, orderType: GMX_ORDER_TYPE.StopLossDecrease }],
    [key(6), { ...plain, orderType: GMX_ORDER_TYPE.MarketSwap }],
  ]);
  const { ctx, executed } = stubCtx(orders);
  const refused: Array<{ key: string; reason: string; orderType: number }> = [];
  await gmxAdapter.afterMine!(ctx, {
    noMine: true,
    fromBlock: 10n,
    toBlock: 10n,
    onOrderRefused: (r) => refused.push(r),
  });
  assert.deepEqual(executed, [key(2), key(4), key(6)]);
  assert.deepEqual(
    refused.map((r) => [r.key, r.orderType]),
    [
      [key(1), GMX_ORDER_TYPE.StopIncrease],
      [key(3), GMX_ORDER_TYPE.LimitIncrease],
      [key(5), GMX_ORDER_TYPE.StopLossDecrease],
    ],
  );
  // A refused order is not queued for a later pass either: it is not retried when its trigger is met.
  (ctx.publicClient as unknown as { getLogs: () => Promise<unknown[]> }).getLogs = async () => [];
  await gmxAdapter.afterMine!(ctx, { noMine: true, fromBlock: 11n, toBlock: 11n });
  assert.equal(executed.length, 3);
  resetKeeperOrderQueue();
});

test("the startup check calls a deploy closed only when all three limits read 0", () => {
  const closed = {
    maxCallbackGasLimit: 0n,
    refundExecutionFeeGasLimit: 0n,
    nativeTokenTransferGasLimit: 0n,
  };
  assert.equal(gmxCallbackCheck(closed).closedAtDeploy, true);
  // Upstream's hardhat profile: every hook open.
  const upstream = gmxCallbackCheck({
    maxCallbackGasLimit: 2_000_000n,
    refundExecutionFeeGasLimit: 200_000n,
    nativeTokenTransferGasLimit: 50_000n,
  });
  assert.equal(upstream.closedAtDeploy, false);
  assert.match(gmxCallbackOpenMessage(upstream), /2000000.*200000.*50000/);
  // Each limit is its own hook: zeroing maxCallbackGasLimit leaves refundExecutionFee its 200k, and
  // both leave a contract receiver its receive() with 50k.
  assert.equal(
    gmxCallbackCheck({ ...closed, refundExecutionFeeGasLimit: 200_000n })
      .closedAtDeploy,
    false,
  );
  assert.equal(
    gmxCallbackCheck({ ...closed, nativeTokenTransferGasLimit: 50_000n })
      .closedAtDeploy,
    false,
  );
  // A limit that was not read is not a 0.
  assert.equal(
    gmxCallbackCheck({ ...closed, nativeTokenTransferGasLimit: undefined })
      .closedAtDeploy,
    false,
  );
  const unread = gmxCallbackCheck({ error: "boom" });
  assert.equal(unread.closedAtDeploy, false);
  assert.match(gmxCallbackOpenMessage(unread), /could not be read \(boom\)/);
});

test("the deploy patch zeroes all three gas limits in the localhost profile", () => {
  const patch = readFileSync(
    new URL("../deployer/vendor/gmx-localhost.patch", import.meta.url),
    "utf8",
  );
  assert.match(patch, /^\+\s+refundExecutionFeeGasLimit: 0,/m);
  assert.match(patch, /^\+\s+maxCallbackGasLimit: 0,/m);
  assert.match(patch, /^\+\s+nativeTokenTransferGasLimit: 0,/m);
});

// ---- fills per block (issue #225) ----

test("the keeper fills at most MAX_ORDER_FILLS_PER_BLOCK orders a pass and carries the rest to the next", async () => {
  resetKeeperOrderQueue();
  const orders = new Map<Hex, StubOrder | Error>();
  for (let n = 1; n <= MAX_ORDER_FILLS_PER_BLOCK + 2; n++)
    orders.set(key(n), { account: ACCOUNT, callbackContract: zeroAddress, callbackGasLimit: 0n });
  const { ctx, executed } = stubCtx(orders);
  const deferred: Array<{ sent: number; deferred: number }> = [];
  await gmxAdapter.afterMine!(ctx, {
    noMine: true,
    fromBlock: 10n,
    toBlock: 10n,
    onOrdersDeferred: (r) => deferred.push(r),
  });
  assert.deepEqual(executed, [1, 2, 3, 4, 5].map(key), "the first five, in arrival order");
  assert.deepEqual(deferred, [{ sent: MAX_ORDER_FILLS_PER_BLOCK, deferred: 2 }]);

  // The next pass scans a range with no new orders: the two that waited go now, nothing is reported.
  (ctx.publicClient as unknown as { getLogs: () => Promise<unknown[]> }).getLogs = async () => [];
  await gmxAdapter.afterMine!(ctx, {
    noMine: true,
    fromBlock: 11n,
    toBlock: 11n,
    onOrdersDeferred: (r) => deferred.push(r),
  });
  assert.deepEqual(executed.slice(MAX_ORDER_FILLS_PER_BLOCK), [6, 7].map(key));
  assert.equal(deferred.length, 1);
  resetKeeperOrderQueue();
});

test("an order deferred and cancelled before its turn is dropped, not filled late", async () => {
  resetKeeperOrderQueue();
  const orders = new Map<Hex, StubOrder | Error>();
  for (let n = 1; n <= MAX_ORDER_FILLS_PER_BLOCK + 1; n++)
    orders.set(key(n), { account: ACCOUNT, callbackContract: zeroAddress, callbackGasLimit: 0n });
  const { ctx, executed } = stubCtx(orders);
  await gmxAdapter.afterMine!(ctx, { noMine: true, fromBlock: 10n, toBlock: 10n });
  assert.equal(executed.length, MAX_ORDER_FILLS_PER_BLOCK);
  // The sixth is gone from the Reader by the next pass (cancelled by its owner).
  orders.set(key(MAX_ORDER_FILLS_PER_BLOCK + 1), undefined as never);
  (ctx.publicClient as unknown as { getLogs: () => Promise<unknown[]> }).getLogs = async () => [];
  await gmxAdapter.afterMine!(ctx, { noMine: true, fromBlock: 11n, toBlock: 11n });
  assert.equal(executed.length, MAX_ORDER_FILLS_PER_BLOCK, "nothing filled late");
  resetKeeperOrderQueue();
});
