// What a model-written strategy may send as raw calldata (issue #214 item 3; runtime/rawTxGuard.ts).
//
// A revert reason another participant's contract wrote reaches the revision model as text. If the
// model follows it, `rawTx` is the exit. The reference runtime closes it for revised versions only:
// the strategy the participant shipped is theirs and stays unrestricted.
//
// The first guard checked only where a call went. These tests pin the allowlist that replaced it:
// every argument that says where value goes must name the agent (the audit's bypasses below), and
// the raw calls the reference agents build still pass, encoded with the sdk's own ABIs and the
// agents' own helpers so a drift in the table's signatures shows up here.
//
// Under the local-deploy overlay, the only address table with the LST and Liquity venues. The env is
// set before the dynamic imports below; Node's test runner gives each file its own process.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import type { AgentObservation } from "../sdk/src/types.js";

const {
  AAVE,
  BALANCER,
  CURVE,
  GMX,
  LIQUITY,
  LST,
  MARKET_LEGS,
  MULTICALL3,
  STABLE_MARKET_LEGS,
  TOKENS,
  UNISWAP,
} = await import("../sdk/src/constants.js");
const abis = await import("../sdk/src/abis.js");
const { aavePoolAbi } = await import("../sdk/src/protocols/aave.js");
const { simpleLendingAbi } = await import("../sdk/src/protocols/lending.js");
const { exchangeRouterAbi: gmxExchangeRouterAbi } = await import("../sdk/src/protocols/gmx.js");
const { FLASH_ARB_ADDRESS } = await import("../sdk/src/wellKnown.js");
const {
  bundledAddresses,
  bundledInertAddresses,
  bundledRoles,
  callTables,
  checkRevisedRawTx,
  rawTxAllowlist,
} = await import("../example/agents/runtime/rawTxGuard.js");
const { swapBundle } = await import("../example/agents/lib/launchSwap.js");
const { buildFlashLoanSimple } = await import("../example/agents/lib/flash.js");
const { buildLiquidationCall } = await import("../example/agents/lib/aave-liquidation.js");
const { drainAction } = await import("../example/agents/lib/exploit.js");

const SELF = "0x00000000000000000000000000000000000000aa" as Address;
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
const STRANGER = "0x1111111111111111111111111111111111111111" as Address;
const LAUNCH_TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const TRAP_MARKET = "0x3333333333333333333333333333333333333333" as Address;
const VERIFIED_POOL = "0x4444444444444444444444444444444444444444" as Address;
const PRICE_FEED = "0x5555555555555555555555555555555555555555" as Address;
const REGISTRY = "0x6666666666666666666666666666666666666666" as Address;
const LENDING = "0x7777777777777777777777777777777777777777" as Address;
const VAULT = "0x8888888888888888888888888888888888888888" as Address; // a LeakyVault, kind unknown
const EXPLOITER = "0x9999999999999999999999999999999999999999" as Address; // the agent's own
const OWN_POSITION = 77n;

const USDC = TOKENS.USDC.address;
const WETH = TOKENS.WETH.address;
const BIG = 10n ** 30n;

const entry = (market: string, kind: string, verified: boolean, extra: Record<string, unknown> = {}) => ({
  market,
  kind,
  creator: STRANGER,
  mine: false,
  codehashAtRegistration: "0x",
  verified,
  registeredAtBlock: "1",
  ...extra,
});
const observation = {
  agentAddress: SELF,
  protocols: { uniswap: { positions: [{ tokenId: OWN_POSITION.toString() }] } },
  registry: {
    address: REGISTRY,
    entries: [
      entry(LAUNCH_TOKEN, "erc20", true),
      entry(TRAP_MARKET, "lendingMarket", false),
      entry(VERIFIED_POOL, "uniswapV3Pool", true),
      entry(LENDING, "lendingMarket", true, { extra: "0x01" }),
      entry(VAULT, "unknown", false),
      entry(EXPLOITER, "unknown", false, { creator: SELF, mine: true }),
    ],
    allowances: [],
    strandedUnknown: [],
    dropped: 0,
  },
} as unknown as AgentObservation;
const allow = rawTxAllowlist({
  observation,
  runContracts: { priceFeed: PRICE_FEED, marketRegistry: REGISTRY, lending: LENDING },
  self: SELF,
});
const rawTx = (tx: { to?: string; data: string; value?: string }) =>
  checkRevisedRawTx({ type: "rawTx", tx }, allow);
const call = (abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[] = []): Hex =>
  encodeFunctionData({ abi: abi as Abi, functionName, args } as never);

function ok(verdict: { ok: boolean; reason?: string }, what: string): void {
  assert.deepEqual(verdict, { ok: true }, `${what} should pass: ${verdict.reason ?? ""}`);
}
function refused(verdict: { ok: boolean; reason?: string }, pattern: RegExp, what: string): void {
  assert.equal(verdict.ok, false, `${what} should be refused`);
  assert.match(verdict.reason ?? "", pattern, what);
}
const RECIPIENT = /may only name its own address/;

const erc20 = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
]);
const approve = (spender: string, amount = 10n) =>
  call(erc20, "approve", [spender, amount]);

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

test("the bundled address table and the run's contracts are the base of the allowlist", () => {
  const known = bundledAddresses();
  assert.ok(known.has(WETH.toLowerCase()));
  assert.ok(known.has(UNISWAP.swapRouter.toLowerCase()));
  assert.ok(allow.known.has(PRICE_FEED));
  assert.ok(allow.known.has(REGISTRY));
  assert.equal(allow.registry.get(LAUNCH_TOKEN)?.verified, true);
  assert.equal(allow.self, SELF);
  assert.ok(allow.roles.get(LENDING)?.has("lending"));
});

test("every address of the bundled table is given a role or listed as callable by nobody", () => {
  // A new venue address in constants.ts has to land on one side. Left unclassified it would be a
  // known destination with no table, refused with a message that does not say why.
  const roles = bundledRoles();
  const inert = bundledInertAddresses();
  const unclassified = [...bundledAddresses()].filter((a) => !roles.has(a) && !inert.has(a));
  assert.deepEqual(unclassified, []);
  for (const a of inert) assert.ok(!roles.has(a), `${a} is both inert and given a role`);
});

test("the table's signatures match the ABIs the sdk adapters encode with", () => {
  // The guard writes its signatures out (so the table can be read on its own); a selector that
  // drifted from the adapters' would refuse a call the registered action makes.
  const tables = callTables();
  const has = (role: string, abi: Abi | readonly unknown[], names: string[]) => {
    for (const name of names) {
      const item = (abi as Abi).find((i) => i.type === "function" && i.name === name);
      assert.ok(item, `${name} is in the sdk ABI`);
      const selector = toFunctionSelector(item as never).toLowerCase();
      assert.ok(
        tables.get(role as never)?.has(selector),
        `${role} permits ${name} (${selector})`,
      );
    }
  };
  has("weth", abis.wethAbi, ["deposit", "withdraw"]);
  has("token", abis.erc20Abi, ["approve"]);
  has("uniswapRouter", abis.swapRouterAbi, ["exactInputSingle"]);
  has("uniswapPositions", abis.nonfungiblePositionManagerAbi, [
    "mint",
    "increaseLiquidity",
    "decreaseLiquidity",
    "collect",
    "multicall",
    "createAndInitializePoolIfNecessary",
  ]);
  has("balancerVault", abis.balancerVaultAbi, ["swap", "joinPool", "exitPool"]);
  has("curvePool", abis.curveTricryptoAbi, ["exchange"]);
  has("curvePool", abis.curveStableSwapNgAbi, ["exchange"]);
  has("curvePool", abis.curveTwocryptoLiquidityAbi, ["add_liquidity", "remove_liquidity"]);
  has("aavePool", aavePoolAbi, ["supply", "withdraw", "borrow", "repay"]);
  has("gmxExchangeRouter", gmxExchangeRouterAbi, ["multicall", "sendWnt", "sendTokens", "createOrder"]);
  has("lstVault", abis.lstVaultAbi, ["deposit", "requestWithdraw", "claimWithdraw", "claimAllWithdrawals"]);
  has("liquityBorrowerOperations", abis.borrowerOperationsAbi, [
    "openTrove",
    "addColl",
    "withdrawColl",
    "withdrawLUSD",
    "repayLUSD",
    "adjustTrove",
    "closeTrove",
    "claimCollateral",
  ]);
  has("liquityStabilityPool", abis.stabilityPoolAbi, ["provideToSP", "withdrawFromSP"]);
  has("liquityTroveManager", abis.troveManagerAbi, [
    "redeemCollateral",
    "liquidate",
    "batchLiquidateTroves",
    "liquidateTroves",
  ]);
  has("liquityStaking", abis.lqtyStakingAbi, ["stake", "unstake"]);
  has("liquityRedemptionHelper", abis.liquityRedemptionHelperAbi, ["redeem"]);
  has("lending", simpleLendingAbi, [
    "createMarket",
    "supply",
    "withdraw",
    "supplyCollateral",
    "withdrawCollateral",
    "borrow",
    "repay",
    "repayAll",
    "withdrawAll",
  ]);
});

// ---------------------------------------------------------------------------
// The audit's bypasses (#4b): every one passed the destination-only guard
// ---------------------------------------------------------------------------

const swapParams = (recipient: Address) => ({
  tokenIn: USDC,
  tokenOut: WETH,
  fee: 3000,
  recipient,
  deadline: 2n ** 40n,
  amountIn: 25_000n * 10n ** 6n,
  amountOutMinimum: 0n,
  sqrtPriceLimitX96: 0n,
});
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params)",
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params)",
  "function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient)",
  "function sweepToken(address token, uint256 amountMinimum, address recipient)",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
]);

test("a router swap, a router approve and a WETH wrap pass when the agent is the recipient", () => {
  ok(rawTx({ to: USDC, data: approve(UNISWAP.swapRouter, BIG) }), "approve(router)");
  ok(rawTx({ to: UNISWAP.swapRouter, data: call(routerAbi, "exactInputSingle", [swapParams(SELF)]) }), "swap to self");
  ok(rawTx({ to: WETH, data: "0xd0e30db0", value: "1" }), "WETH.deposit() (redemption-arb / sp-underwriter)");
  ok(rawTx({ to: WETH, data: "0x", value: "1" }), "plain ETH to WETH");
});

test("a swap that pays someone else is refused, in every router shape", () => {
  const path = `0x${USDC.slice(2)}000bb8${WETH.slice(2)}` as Hex;
  for (const [fn, args] of [
    ["exactInputSingle", [swapParams(ATTACKER)]],
    ["exactInput", [{ path, recipient: ATTACKER, deadline: 1n, amountIn: 1n, amountOutMinimum: 0n }]],
    [
      "exactOutputSingle",
      [{ tokenIn: USDC, tokenOut: WETH, fee: 3000, recipient: ATTACKER, deadline: 1n, amountOut: 1n, amountInMaximum: BIG, sqrtPriceLimitX96: 0n }],
    ],
    ["exactOutput", [{ path, recipient: ATTACKER, deadline: 1n, amountOut: 1n, amountInMaximum: BIG }]],
    ["unwrapWETH9", [0n, ATTACKER]],
    ["sweepToken", [USDC, 0n, ATTACKER]],
  ] as const)
    refused(rawTx({ to: UNISWAP.swapRouter, data: call(routerAbi, fn, args) }), RECIPIENT, fn);
});

test("Aave calls that credit, pay or book debt to someone else are refused", () => {
  const pool = AAVE.Pool;
  refused(rawTx({ to: pool, data: call(aavePoolAbi, "supply", [USDC, 1n, ATTACKER, 0]) }), RECIPIENT, "supply onBehalfOf");
  refused(rawTx({ to: pool, data: call(aavePoolAbi, "repay", [USDC, 1n, 2n, ATTACKER]) }), RECIPIENT, "repay onBehalfOf");
  refused(rawTx({ to: pool, data: call(aavePoolAbi, "withdraw", [USDC, 1n, ATTACKER]) }), RECIPIENT, "withdraw to");
  refused(rawTx({ to: pool, data: call(aavePoolAbi, "borrow", [USDC, 1n, 2n, 0, ATTACKER]) }), RECIPIENT, "borrow onBehalfOf");
  ok(rawTx({ to: pool, data: call(aavePoolAbi, "supply", [USDC, 1n, SELF, 0]) }), "supply for self");
  ok(rawTx({ to: pool, data: call(aavePoolAbi, "withdraw", [USDC, 1n, SELF]) }), "withdraw to self");
  // A flash loan into anything but the bundled FlashArb is a contract that receives the loan.
  const params = (profitTo: Address) =>
    encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }] }],
      [[0, 0n, 0n, profitTo]],
    );
  ok(rawTx(buildFlashLoanSimple(FLASH_ARB_ADDRESS, USDC, 1n, params(SELF))), "flash-arb");
  refused(rawTx(buildFlashLoanSimple(FLASH_ARB_ADDRESS, USDC, 1n, params(ATTACKER))), RECIPIENT, "flash profitTo");
  refused(rawTx(buildFlashLoanSimple(ATTACKER, USDC, 1n, params(SELF))), /FlashArb receiver/, "flash receiver");
  ok(rawTx(buildLiquidationCall(WETH, USDC, STRANGER, BIG)), "liquidator");
});

test("position-manager calls that mint, collect or top up for someone else are refused", () => {
  const npm = UNISWAP.nonfungiblePositionManager;
  const abi = abis.nonfungiblePositionManagerAbi;
  const mint = (recipient: Address) =>
    call(abi, "mint", [
      { token0: WETH, token1: USDC, fee: 3000, tickLower: -60, tickUpper: 60, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, recipient, deadline: 1n },
    ]);
  const collect = (recipient: Address) =>
    call(abi, "collect", [{ tokenId: OWN_POSITION, recipient, amount0Max: 2n ** 127n, amount1Max: 2n ** 127n }]);
  const increase = (tokenId: bigint) =>
    call(abi, "increaseLiquidity", [
      { tokenId, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 1n },
    ]);
  ok(rawTx({ to: npm, data: mint(SELF) }), "market-launcher's mint");
  refused(rawTx({ to: npm, data: mint(ATTACKER) }), RECIPIENT, "mint to attacker");
  refused(rawTx({ to: npm, data: collect(ATTACKER) }), RECIPIENT, "collect to attacker");
  ok(rawTx({ to: npm, data: increase(OWN_POSITION) }), "top up own position");
  refused(rawTx({ to: npm, data: increase(78n) }), /not list as this agent's/, "top up another position");
});

test("Balancer and Curve calls that pay someone else are refused", () => {
  const funds = (sender: Address, recipient: Address) => ({
    sender,
    fromInternalBalance: false,
    recipient,
    toInternalBalance: false,
  });
  const single = { poolId: BALANCER.poolId, kind: 0, assetIn: USDC, assetOut: WETH, amount: 1n, userData: "0x" as Hex };
  const vault = BALANCER.vault;
  ok(rawTx({ to: vault, data: call(abis.balancerVaultAbi, "swap", [single, funds(SELF, SELF), 0n, 1n]) }), "swap to self");
  refused(rawTx({ to: vault, data: call(abis.balancerVaultAbi, "swap", [single, funds(SELF, ATTACKER), 0n, 1n]) }), RECIPIENT, "funds.recipient");
  refused(rawTx({ to: vault, data: call(abis.balancerVaultAbi, "swap", [single, funds(ATTACKER, SELF), 0n, 1n]) }), RECIPIENT, "funds.sender");
  const batchAbi = parseAbi([
    "function batchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds, int256[] limits, uint256 deadline)",
    "function setRelayerApproval(address sender, address relayer, bool approved)",
  ]);
  refused(
    rawTx({ to: vault, data: call(batchAbi, "batchSwap", [0, [], [USDC, WETH], funds(SELF, ATTACKER), [0n, 0n], 1n]) }),
    RECIPIENT,
    "batchSwap recipient",
  );
  const join = { assets: [USDC, WETH], maxAmountsIn: [1n, 1n], userData: "0x" as Hex, fromInternalBalance: false };
  refused(rawTx({ to: vault, data: call(abis.balancerVaultAbi, "joinPool", [BALANCER.poolId, SELF, ATTACKER, join]) }), RECIPIENT, "joinPool recipient");
  const exit = { assets: [USDC, WETH], minAmountsOut: [0n, 0n], userData: "0x" as Hex, toInternalBalance: false };
  refused(rawTx({ to: vault, data: call(abis.balancerVaultAbi, "exitPool", [BALANCER.poolId, SELF, ATTACKER, exit]) }), RECIPIENT, "exitPool recipient");
  // A relayer acts as you on the Vault; nothing a revised strategy needs.
  refused(rawTx({ to: vault, data: call(batchAbi, "setRelayerApproval", [SELF, ATTACKER, true]) }), /not a call a revised strategy may make/, "setRelayerApproval");

  const curveAbi = parseAbi([
    "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver)",
    "function remove_liquidity_one_coin(uint256 token_amount, uint256 i, uint256 min_amount, address receiver)",
    "function add_liquidity(uint256[2] amounts, uint256 min_mint_amount, address receiver)",
    "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
    "function remove_liquidity(uint256 burn_amount, uint256[] min_amounts, address receiver)",
    "function remove_liquidity(uint256 burn_amount, uint256[] min_amounts, address receiver, bool claim_admin_fees)",
  ]);
  const crypto = CURVE.pool;
  ok(rawTx({ to: crypto, data: call(abis.curveTricryptoAbi, "exchange", [0n, 1n, 1n, 0n]) }), "the adapter's exchange");
  ok(rawTx({ to: crypto, data: call(curveAbi, "exchange", [0n, 1n, 1n, 0n, SELF]) }), "exchange to self");
  refused(rawTx({ to: crypto, data: encodeFunctionData({ abi: [curveAbi[0]], args: [0n, 1n, 1n, 0n, ATTACKER] }) }), RECIPIENT, "exchange receiver");
  refused(rawTx({ to: crypto, data: call(curveAbi, "remove_liquidity_one_coin", [1n, 0n, 0n, ATTACKER]) }), RECIPIENT, "one_coin receiver");
  refused(rawTx({ to: crypto, data: call(curveAbi, "add_liquidity", [[1n, 1n], 0n, ATTACKER]) }), RECIPIENT, "add_liquidity receiver");
  const ng = Object.values(STABLE_MARKET_LEGS)[0].pool;
  ok(rawTx({ to: ng, data: call(abis.curveStableSwapNgAbi, "exchange", [0n, 1n, 1n, 0n]) }), "stableSwap");
  refused(rawTx({ to: ng, data: encodeFunctionData({ abi: [curveAbi[3]], args: [0n, 1n, 1n, 0n, ATTACKER] }) }), RECIPIENT, "ng exchange receiver");
  refused(rawTx({ to: ng, data: encodeFunctionData({ abi: [curveAbi[4]], args: [1n, [0n, 0n], ATTACKER] }) }), RECIPIENT, "ng remove receiver");
  refused(rawTx({ to: ng, data: encodeFunctionData({ abi: [curveAbi[5]], args: [1n, [0n, 0n], ATTACKER, true] }) }), RECIPIENT, "ng remove receiver + claim");
  // The pool is its own LP token, so its approve works and its transfer does not.
  ok(rawTx({ to: ng, data: approve(UNISWAP.swapRouter) }), "approve an LP token to a venue");
  refused(rawTx({ to: ng, data: call(erc20, "transfer", [ATTACKER, 1n]) }), /transfer\(\) to/, "LP transfer");
});

// The adapter's shape (sdk/src/protocols/gmx.ts buildOrderTx): fund the vault, then the order.
const orderParams = (over: { receiver?: Address; callbackContract?: Address; uiFeeReceiver?: Address; collateral?: Address } = {}) => ({
  addresses: {
    receiver: over.receiver ?? SELF,
    cancellationReceiver: "0x0000000000000000000000000000000000000000" as Address,
    callbackContract: over.callbackContract ?? ("0x0000000000000000000000000000000000000000" as Address),
    uiFeeReceiver: over.uiFeeReceiver ?? ("0x0000000000000000000000000000000000000000" as Address),
    market: MARKET_LEGS.gmx.WETH.market,
    initialCollateralToken: over.collateral ?? USDC,
    swapPath: [] as Address[],
  },
  numbers: {
    sizeDeltaUsd: 1n,
    initialCollateralDeltaAmount: 1n,
    triggerPrice: 0n,
    acceptablePrice: BIG,
    executionFee: 3n,
    callbackGasLimit: 0n,
    minOutputAmount: 0n,
    validFromTime: 0n,
  },
  orderType: 2,
  decreasePositionSwapType: 0,
  isLong: true,
  shouldUnwrapNativeToken: false,
  autoCancel: false,
  referralCode: `0x${"00".repeat(32)}` as Hex,
  dataList: [] as Hex[],
});
const gmx = (fn: string, args: readonly unknown[]) => call(gmxExchangeRouterAbi, fn, args);
const gmxMulticall = (calls: Hex[], value: bigint) =>
  rawTx({ to: GMX.ExchangeRouter, data: gmx("multicall", [calls]), value: value.toString() });

test("a GMX order passes in the adapter's shape and is refused when anything else gets the value", () => {
  const vault = GMX.OrderVault;
  ok(
    gmxMulticall([gmx("sendWnt", [vault, 3n]), gmx("sendTokens", [USDC, vault, 1n]), gmx("createOrder", [orderParams()])], 3n),
    "increase with USDC collateral",
  );
  ok(gmxMulticall([gmx("sendWnt", [vault, 4n]), gmx("createOrder", [orderParams({ collateral: WETH })])], 4n), "WETH collateral");
  refused(
    gmxMulticall([gmx("sendWnt", [vault, 3n]), gmx("createOrder", [orderParams({ receiver: ATTACKER })])], 3n),
    RECIPIENT,
    "order receiver",
  );
  refused(
    gmxMulticall([gmx("sendWnt", [vault, 3n]), gmx("createOrder", [orderParams({ uiFeeReceiver: ATTACKER })])], 3n),
    /or zero there/,
    "uiFeeReceiver",
  );
  refused(
    gmxMulticall([gmx("sendWnt", [vault, 3n]), gmx("createOrder", [orderParams({ callbackContract: ATTACKER })])], 3n),
    /must leave it zero/,
    "callbackContract",
  );
  refused(gmxMulticall([gmx("sendTokens", [USDC, ATTACKER, 1n])], 0n), /OrderVault/, "sendTokens to attacker");
  refused(gmxMulticall([gmx("sendWnt", [ATTACKER, 3n])], 3n), /OrderVault/, "sendWnt to attacker");
  // Funding the vault with no order to take it: the next order anyone creates is credited with it.
  refused(rawTx({ to: GMX.ExchangeRouter, data: gmx("sendTokens", [USDC, vault, 1n]) }), /outside a multicall/, "bare sendTokens");
  refused(gmxMulticall([gmx("sendTokens", [USDC, vault, 1n])], 0n), /not followed by a createOrder/, "sendTokens alone");
  refused(
    gmxMulticall([gmx("sendWnt", [vault, 3n]), gmx("sendTokens", [WETH, vault, 1n]), gmx("createOrder", [orderParams()])], 3n),
    /not followed by a createOrder that takes it/,
    "sendTokens of a token the order does not take",
  );
  // ETH the multicall does not forward stays in the router for anyone's sendWnt.
  refused(
    gmxMulticall([gmx("sendWnt", [vault, 3n]), gmx("createOrder", [orderParams()])], 10n),
    /forwards 3 with sendWnt/,
    "value left in the router",
  );
  const cancel = parseAbi(["function cancelOrder(bytes32 key)"]);
  ok(rawTx({ to: GMX.ExchangeRouter, data: call(cancel, "cancelOrder", [`0x${"11".repeat(32)}`]) }), "cancelOrder");
});

test("Liquity and LST calls pass for the agent and are refused when they route value elsewhere", () => {
  assert.ok(LIQUITY && LST, "the local overlay has both venues");
  const bo = LIQUITY.borrowerOperations;
  ok(
    rawTx({ to: bo, data: call(abis.borrowerOperationsAbi, "openTrove", [BIG, 2_000n, SELF, SELF]), value: "5" }),
    "openTrove with ETH collateral",
  );
  ok(rawTx({ to: bo, data: call(abis.borrowerOperationsAbi, "claimCollateral") }), "claimCollateral (rawTx in the docs)");
  ok(rawTx({ to: LIQUITY.lqtyStaking, data: call(abis.lqtyStakingAbi, "unstake", [0n]) }), "unstake(0) claims gains");
  ok(rawTx({ to: LIQUITY.stabilityPool, data: call(abis.stabilityPoolAbi, "provideToSP", [1n, "0x0000000000000000000000000000000000000000"]) }), "provideToSP");
  refused(
    rawTx({ to: LIQUITY.stabilityPool, data: call(abis.stabilityPoolAbi, "provideToSP", [1n, ATTACKER]) }),
    /must leave it zero/,
    "front-end tag",
  );
  ok(rawTx({ to: LIQUITY.redemptionHelper!, data: call(abis.liquityRedemptionHelperAbi, "redeem", [1n, BIG, 0n]) }), "redeem");
  // ETH only where it is consumed: a Trove takes it, closeTrove does not.
  refused(
    rawTx({ to: bo, data: call(abis.borrowerOperationsAbi, "closeTrove"), value: "1" }),
    /carries 1 wei/,
    "ETH on closeTrove",
  );

  const lst = LST.vault;
  ok(rawTx({ to: lst, data: call(abis.lstVaultAbi, "deposit", [1n, SELF]) }), "stake for self");
  refused(rawTx({ to: lst, data: call(abis.lstVaultAbi, "deposit", [1n, ATTACKER]) }), RECIPIENT, "stake for attacker");
  const erc4626 = parseAbi(["function redeem(uint256 shares, address receiver, address owner)"]);
  refused(rawTx({ to: lst, data: call(erc4626, "redeem", [1n, ATTACKER, SELF]) }), RECIPIENT, "redeem receiver");
  refused(rawTx({ to: lst, data: call(abis.lstVaultAbi, "fundRewards", [1n]) }), /not a call a revised strategy may make/, "donate to the reserve");
  // The LST's variable debt token: approveDelegation lets the delegatee borrow against your collateral.
  const delegation = parseAbi(["function approveDelegation(address delegatee, uint256 amount)"]);
  refused(
    rawTx({ to: LST.aaveVariableDebtToken!, data: call(delegation, "approveDelegation", [ATTACKER, BIG]) }),
    /nothing a revised strategy may call/,
    "approveDelegation",
  );
});

// ---------------------------------------------------------------------------
// Multicall wrappers are opened
// ---------------------------------------------------------------------------

test("a multicall is checked call by call, and a multicall inside one is refused", () => {
  const router = UNISWAP.swapRouter;
  const toSelf = call(routerAbi, "exactInputSingle", [swapParams(SELF)]);
  const toAttacker = call(routerAbi, "exactInputSingle", [swapParams(ATTACKER)]);
  ok(rawTx({ to: router, data: call(routerAbi, "multicall", [[toSelf]]) }), "multicall to self");
  refused(rawTx({ to: router, data: call(routerAbi, "multicall", [[toSelf, toAttacker]]) }), /multicall\[1\].*may only name its own address/, "multicall leg 1");
  const deadlineMulticall = encodeFunctionData({ abi: [routerAbi[7]], args: [1n, [toAttacker]] });
  refused(rawTx({ to: router, data: deadlineMulticall }), RECIPIENT, "multicall(deadline, bytes[])");
  refused(rawTx({ to: router, data: call(routerAbi, "multicall", [[call(routerAbi, "multicall", [[toSelf]])]]) }), /inside a multicall/, "nested");
  refused(rawTx({ to: router, data: call(routerAbi, "multicall", [[toSelf]]), value: "1" }), /carries 1 wei/, "ETH to the router");
  refused(
    rawTx({ to: router, data: call(routerAbi, "multicall", [[call(erc20, "transfer", [ATTACKER, 1n])]]) }),
    /transfer\(\) to/,
    "a transfer selector inside a multicall",
  );

  // The liquidityPull shape: decrease and collect in one transaction.
  const npm = UNISWAP.nonfungiblePositionManager;
  const abi = abis.nonfungiblePositionManagerAbi;
  const decrease = call(abi, "decreaseLiquidity", [{ tokenId: OWN_POSITION, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 1n }]);
  const collect = (recipient: Address) =>
    call(abi, "collect", [{ tokenId: OWN_POSITION, recipient, amount0Max: 1n, amount1Max: 1n }]);
  ok(rawTx({ to: npm, data: call(abi, "multicall", [[decrease, collect(SELF)]]) }), "decrease + collect to self");
  refused(rawTx({ to: npm, data: call(abi, "multicall", [[decrease, collect(ATTACKER)]]) }), RECIPIENT, "decrease + collect to attacker");
});

// ---------------------------------------------------------------------------
// Destinations, approvals, transfers
// ---------------------------------------------------------------------------

test("an address the run does not know is refused, and so is a deployment", () => {
  const stranger = rawTx({ to: STRANGER, data: "0x" });
  assert.ok(!stranger.ok && /not a venue, a token of this run or a registry entry/.test(stranger.reason));
  const deploy = rawTx({ data: "0x6080" });
  assert.ok(!deploy.ok && /may not deploy/.test(deploy.reason));
});

test("a known address with no table, or a selector off the table, is refused and named", () => {
  const multicall3 = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls)"]);
  refused(rawTx({ to: MULTICALL3, data: call(multicall3, "aggregate3", [[]]) }), /nothing a revised strategy may call/, "Multicall3");
  refused(rawTx({ to: PRICE_FEED, data: "0x12345678" }), /nothing a revised strategy may call/, "PriceFeed");
  refused(rawTx({ to: UNISWAP.swapRouter, data: "0x12345678" }), /selector 0x12345678 .*Uniswap SwapRouter/, "unknown selector");
  refused(rawTx({ to: UNISWAP.swapRouter, data: "0x" }), /no function selector/, "empty call");
  refused(rawTx({ to: UNISWAP.swapRouter, data: "0x414bf389" }), /does not decode/, "truncated calldata");
  // A Uniswap pool's own swap needs a callback an EOA cannot answer; trades go through the router.
  refused(rawTx({ to: MARKET_LEGS.uniswap.WETH.pool, data: "0x128acb08" }), /trade through the SwapRouter/, "pool.swap");
});

test("transfer and transferFrom are refused wherever they point", () => {
  const transfer = call(erc20, "transfer", [STRANGER, 1n]);
  const usdc = rawTx({ to: USDC, data: transfer });
  assert.ok(!usdc.ok && /transfer\(\) to/.test(usdc.reason));
  assert.ok(!rawTx({ to: LAUNCH_TOKEN, data: call(erc20, "transferFrom", [STRANGER, STRANGER, 1n]) }).ok);
});

test("approve names a venue that pulls from its caller, a verified entry, or zero", () => {
  // The launch-sniper shape: approve the launch token to the environment's router.
  ok(rawTx({ to: LAUNCH_TOKEN, data: approve(UNISWAP.swapRouter) }), "launch token to router");
  ok(rawTx({ to: USDC, data: approve(VERIFIED_POOL) }), "verified pool");
  ok(rawTx({ to: USDC, data: approve(GMX.Router) }), "GMX Router (sendTokens pulls through it)");
  ok(rawTx({ to: USDC, data: approve(LENDING) }), "lending singleton");
  const trap = rawTx({ to: USDC, data: approve(TRAP_MARKET) });
  assert.ok(!trap.ok && /approve\(\) with spender/.test(trap.reason));
  refused(rawTx({ to: USDC, data: approve(STRANGER) }), /approve\(\) with spender/, "stranger");
  // Multicall3 calls out as itself: an allowance to it is an allowance to whoever calls it next.
  refused(rawTx({ to: USDC, data: approve(MULTICALL3) }), /approve\(\) with spender/, "Multicall3");
  refused(rawTx({ to: USDC, data: approve(WETH) }), /approve\(\) with spender/, "a token as spender");
  // Revoking moves nothing, whoever holds the allowance.
  ok(rawTx({ to: USDC, data: approve(STRANGER, 0n) }), "revoke");
  const more = parseAbi([
    "function increaseAllowance(address spender, uint256 addedValue)",
    "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  ]);
  ok(rawTx({ to: USDC, data: call(more, "increaseAllowance", [UNISWAP.swapRouter, 1n]) }), "increaseAllowance(router)");
  refused(rawTx({ to: USDC, data: call(more, "increaseAllowance", [ATTACKER, 1n]) }), /increaseAllowance\(\) with spender/, "increaseAllowance(attacker)");
  const sig = `0x${"11".repeat(32)}` as Hex;
  refused(
    rawTx({ to: USDC, data: call(more, "permit", [SELF, ATTACKER, BIG, 1n, 27, sig, sig]) }),
    /permit\(\) with spender/,
    "permit(attacker)",
  );
});

test("a call the checker cannot evaluate is refused, not thrown", () => {
  const verdict = checkRevisedRawTx(
    { type: "rawTx", tx: { to: UNISWAP.swapRouter, data: "0x414bf389", value: "not a number" } },
    allow,
  );
  assert.ok(!verdict.ok && /not an integer/.test(verdict.reason));
  const broken = checkRevisedRawTx({ type: "rawTx", tx: null } as never, allow);
  assert.ok(!broken.ok && /raw-calldata check failed/.test(broken.reason));
});

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

test("an entry the runtime has no ABI for takes only the reference agents' contract calls", () => {
  const vault = parseAbi([
    "function deposit(uint256 assets)",
    "function withdrawAll()",
    "function rescue()",
    "function swap(uint256 amountIn, uint256 minOut, address tokenIn, address to)",
    "function sweep(address to)",
  ]);
  // vault-keeper's own LeakyVault, and exploit-hunter's direct form of the bug.
  ok(rawTx({ to: VAULT, data: call(vault, "deposit", [1n]) }), "deposit");
  ok(rawTx({ to: VAULT, data: call(vault, "withdrawAll") }), "withdrawAll");
  ok(rawTx({ to: VAULT, data: call(vault, "rescue") }), "rescue pays the caller");
  // exploit-hunter's Exploiter: drained value comes back to the caller.
  ok(rawTx(drainAction({ exploiter: EXPLOITER, target: VAULT, calls: [call(vault, "rescue")], tokens: [USDC] }).tx as never), "drain");
  // discovery-arb's vuln-pool swap.
  ok(rawTx({ to: VAULT, data: call(vault, "swap", [1n, 0n, USDC, SELF]) }), "vuln swap to self");
  refused(rawTx({ to: VAULT, data: call(vault, "swap", [1n, 0n, USDC, ATTACKER]) }), RECIPIENT, "vuln swap to attacker");
  refused(rawTx({ to: VAULT, data: call(vault, "sweep", [ATTACKER]) }), /registry entry the runtime has no ABI for/, "anything else");
  refused(rawTx({ to: TRAP_MARKET, data: "0x12345678" }), /not a call a revised strategy may make/, "unverified market");
  // ETH to a registry entry is still refused before anything else.
  refused(rawTx({ to: TRAP_MARKET, data: "0x", value: "5" }), /may not send ETH to a registry entry/, "ETH");
});

test("the lending singleton takes its own calls, all of which act for the caller", () => {
  const params = { loanToken: USDC, collateralToken: WETH, oracle: STRANGER, irm: STRANGER, lltv: 9n * 10n ** 17n };
  for (const [fn, args] of [
    ["createMarket", [params]],
    ["supply", [params, 1n]],
    ["withdrawAll", [params]],
    ["borrow", [params, 1n]],
    ["repayAll", [params]],
  ] as const)
    ok(rawTx({ to: LENDING, data: call(simpleLendingAbi, fn, args) }), fn);
});

test("a bundle is checked leg by leg and names the leg", () => {
  // The launch-sniper shape, built by its own helper.
  const launchSwap = (recipient: Address) =>
    swapBundle({
      tokenIn: USDC,
      tokenOut: LAUNCH_TOKEN,
      fee: 10_000,
      recipient,
      amountIn: 1n,
      minOut: 0n,
      reason: "test",
      maxPriorityFeePerGasWei: "1",
    });
  ok(checkRevisedRawTx(launchSwap(SELF) as never, allow), "launch swap bundle");
  const verdict = checkRevisedRawTx(launchSwap(ATTACKER) as never, allow);
  assert.ok(!verdict.ok && /^rawBundle\[1\]: exactInputSingle\(\)/.test(verdict.reason), JSON.stringify(verdict));
  const bad = checkRevisedRawTx(
    { type: "rawBundle", txs: [{ to: LAUNCH_TOKEN, data: approve(UNISWAP.swapRouter) }, { to: STRANGER, data: "0x" }] },
    allow,
  );
  assert.ok(!bad.ok && /^rawBundle\[1\]/.test(bad.reason));
});

test("without the agent's address every recipient is refused", () => {
  const blind = rawTxAllowlist({ observation: null });
  const verdict = checkRevisedRawTx(
    { type: "rawTx", tx: { to: UNISWAP.swapRouter, data: call(routerAbi, "exactInputSingle", [swapParams(SELF)]) } },
    blind,
  );
  assert.ok(!verdict.ok && /its own address \(unknown\)/.test(verdict.reason));
});

test("registered actions are not the guard's business", () => {
  assert.deepEqual(
    checkRevisedRawTx({ type: "swap", tokenIn: "USDC", amountIn: "1" } as never, allow),
    { ok: true },
  );
});
