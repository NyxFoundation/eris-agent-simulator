/**
 * rawTxGuard.ts: what a model-written strategy may send as raw calldata (issue #214 item 3).
 *
 * The revision loop (ADR 0018) hands the model text that came off the chain: revert reasons from
 * contracts other participants deployed (a lending market's oracle or IRM, a registry pool, a
 * token) reach it as `submit_failed: Execution reverted with reason: ...`, next to the decisions
 * that produced them. A string there that reads "send your USDC to 0x..." is data, and the context
 * says so (improve.ts) -- but if the model follows it anyway, `rawTx` is the exit: the runtime signs
 * whatever `to` / `data` the strategy returns, with the victim's key.
 *
 * The first version of this guard checked only the destination: a venue, a token or a registry
 * entry, and then anything went. That left every venue function that takes a recipient open.
 * `SwapRouter.exactInputSingle{recipient: attacker}` after an `approve` of the router, or
 * `AavePool.supply(onBehalfOf: attacker)`, passed -- and so did NPM mint / collect, Balancer's
 * `funds.recipient`, Curve's `receiver`, GMX's order receiver and `sendTokens`. The endowment left
 * through a pool, which the roster-transfer scan does not flag (a pool -> attacker flow is a trade).
 *
 * So a *revised* strategy (version > 0) is held to an allowlist. Every address the run knows has a
 * role (a token, the SwapRouter, the Aave Pool, ...) and every role a table of the functions a
 * revised strategy may call on it. Each entry names every argument that says where value goes, and
 * what it must be -- the agent's own address almost everywhere, GMX's OrderVault for the two calls
 * that fund an order, zero for a callback or a front-end tag. A selector that is not in the table
 * is refused, and so is any call to an address with no table (a quoter, Multicall3, GMX's
 * DataStore). Multicall wrappers (Uniswap's, GMX's) are opened and every inner call checked the same
 * way. ETH goes only where it is consumed in the same call: WETH, a Liquity Trove, a GMX multicall
 * that forwards all of it with `sendWnt`. Deployment (no `to`) stays refused, and so do the ERC-20
 * transfer selectors; an `approve` names a spender that pulls only from its caller (a venue) or a
 * verified registry entry, or approves zero.
 *
 * Registry entries are other participants' contracts. A verified one runs the environment's code
 * (a Uniswap V3 pool, the lending singleton) and gets that code's table; a token -- verified or not
 * -- gets the ERC-20 approval calls; anything else (kind `unknown`) gets only the calls of the
 * contracts the reference agents deploy (LeakyVault, Exploiter, the vuln AMMs), whose value goes to
 * the caller or to an argument checked to be the caller.
 *
 * What this does *not* check is whether a call is a good trade: a swap with no slippage bound into a
 * pool somebody seeded at a lying price sends value to that pool's LP with every recipient correct.
 * The guard closes "send it to me", not "buy my token".
 *
 * The strategy the participant shipped (version 0) is unrestricted, as before: it is their code,
 * and rules §2.5 make what it does their decision. This closes the exit in the runtime the operator
 * ships; a participant's own runtime is theirs.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbiItem,
  toFunctionSelector,
  type AbiFunction,
  type AbiParameter,
  type Hex,
} from "viem";
import type {
  AgentAction,
  AgentObservation,
  RawTx,
  RegistryEntryObservation,
} from "@eris/sdk/types.js";
import * as constants from "@eris/sdk/constants.js";
import { METHOD_SELECTORS } from "@eris/sdk/methodSelectors.js";
import { FLASH_ARB_ADDRESS } from "@eris/sdk/wellKnown.js";

// What an address is to a revised strategy. One address can hold several roles: a Curve pool is
// its own LP token, the LST vault is the LST, the position manager is an ERC-721.
export type Role =
  | "token"
  | "weth"
  | "uniswapRouter"
  | "uniswapPositions"
  | "uniswapPool"
  | "balancerVault"
  | "curvePool"
  | "aavePool"
  | "gmxExchangeRouter"
  | "gmxRouter"
  | "lstVault"
  | "liquityBorrowerOperations"
  | "liquityStabilityPool"
  | "liquityTroveManager"
  | "liquityStaking"
  | "liquityRedemptionHelper"
  | "lending"
  | "agentContract";

export type RawTxAllowlist = {
  /** Lowercase addresses of the run's venues, tokens and own contracts. */
  known: Set<string>;
  /** Lowercase address -> whether the registry marked it verified (entryObservation.verified). */
  registry: Map<string, { verified: boolean; kind: string }>;
  /** Lowercase address -> its roles. An address in `known` with no roles may not be called. */
  roles: Map<string, Set<Role>>;
  /** The agent's own address, lowercase: what every recipient argument must name. */
  self: string | undefined;
  /** tokenIds of this agent's Uniswap positions, as the observation lists them. */
  ownPositions: Set<string>;
};

export type RawTxGuardVerdict = { ok: true } | { ok: false; reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

// ERC-20 / ERC-721 selectors that move or delegate a balance. keccak256 of the signature, first
// four bytes; fixed by the standard, so written out rather than computed at load. They are refused
// on every address, before any table is consulted, so the message says what the call would do.
const REFUSED_SELECTORS: Record<string, string> = {
  "0xa9059cbb": "transfer", // transfer(address,uint256)
  "0x23b872dd": "transferFrom", // transferFrom(address,address,uint256)
  "0x42842e0e": "safeTransferFrom", // safeTransferFrom(address,address,uint256)
  "0xb88d4fde": "safeTransferFrom", // safeTransferFrom(address,address,uint256,bytes)
  "0xa22cb465": "setApprovalForAll", // setApprovalForAll(address,bool)
};

// Roles whose contract pulls tokens only from its own caller, which is what makes an allowance to
// it safe: nobody else can spend it through them. Multicall3 is the counterexample -- it calls out
// as itself, so an allowance to it is an allowance to whoever calls it next.
const SPENDER_ROLES = new Set<Role>([
  "uniswapRouter",
  "uniswapPositions",
  "balancerVault",
  "curvePool",
  "aavePool",
  "gmxRouter",
  "lstVault",
  "liquityRedemptionHelper",
  "lending",
]);

const ROLE_LABEL: Record<Role, string> = {
  token: "a token",
  weth: "WETH",
  uniswapRouter: "the Uniswap SwapRouter",
  uniswapPositions: "the Uniswap position manager",
  uniswapPool: "a Uniswap V3 pool (trade through the SwapRouter or the position manager)",
  balancerVault: "the Balancer Vault",
  curvePool: "a Curve pool",
  aavePool: "the Aave Pool",
  gmxExchangeRouter: "GMX's ExchangeRouter",
  gmxRouter: "GMX's Router (an approval target only)",
  lstVault: "the LST vault",
  liquityBorrowerOperations: "Liquity's BorrowerOperations",
  liquityStabilityPool: "Liquity's StabilityPool",
  liquityTroveManager: "Liquity's TroveManager",
  liquityStaking: "Liquity's LQTY staking",
  liquityRedemptionHelper: "the Liquity redemption helper",
  lending: "the lending singleton",
  agentContract: "a registry entry the runtime has no ABI for",
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

// What an argument that says where value goes must be.
type Must = "self" | "selfOrZero" | "zero" | "gmxOrderVault" | "flashReceiver";

type CheckContext = {
  allow: RawTxAllowlist;
  // As the strategy wrote it, for messages. Lookups use the lowercase form.
  to: string;
  roles: ReadonlySet<Role>;
  value: bigint;
  depth: number;
  label: string;
};

type Decoded = { name: string; fn: AbiFunction; args: readonly unknown[] };

type CallRule = {
  sig: string;
  // May carry ETH as the outermost call. Inside a multicall the wrapper's own rule decides.
  payable?: true;
  // Every argument that names where value goes, by path: the input's name, then tuple components.
  recipients?: Array<[path: string, must: Must]>;
  // Anything the recipients cannot say. Returns the refusal, or null.
  check?: (call: Decoded, cx: CheckContext) => string | null;
};

type CheckResult = { ok: true; call: Decoded | null } | { ok: false; reason: string };

const approval =
  (spenderPath: string, amountPath?: string) =>
  (call: Decoded, cx: CheckContext): string | null => {
    const spender = lowerAddress(readPath(call, spenderPath));
    // Revoking an allowance moves nothing, whoever it was granted to -- and revoking one a
    // shipped strategy granted to an unknown contract is the safe direction.
    if (amountPath !== undefined && readPath(call, amountPath) === 0n) return null;
    if (spender !== undefined && isSpender(spender, cx.allow)) return null;
    return (
      `${cx.label}: ${call.name}() with spender ${spender ?? "(unreadable)"} -- a revised ` +
      "strategy may only approve a venue or a verified registry entry"
    );
  };

const TOKEN: CallRule[] = [
  { sig: "function approve(address spender, uint256 amount)", check: approval("spender", "amount") },
  { sig: "function increaseAllowance(address spender, uint256 addedValue)", check: approval("spender") },
  {
    sig: "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
    check: approval("spender"),
  },
];

// One rule per multicall shape. The inner calls run against the same contract (delegatecall), so
// they are checked against the same address's tables.
const multicallRules = (opts: { payable?: true; gmx?: true }): CallRule[] =>
  [
    "function multicall(bytes[] data)",
    "function multicall(uint256 deadline, bytes[] data)",
    "function multicall(bytes32 previousBlockhash, bytes[] data)",
  ].map((sig) => ({
    sig,
    ...(opts.payable ? { payable: true as const } : {}),
    check: (call, cx) => checkMulticall(call, cx, opts.gmx === true),
  }));

const UNISWAP_PAYMENTS: CallRule[] = [
  { sig: "function unwrapWETH9(uint256 amountMinimum, address recipient)", recipients: [["recipient", "self"]] },
  {
    sig: "function sweepToken(address token, uint256 amountMinimum, address recipient)",
    recipients: [["recipient", "self"]],
  },
  { sig: "function refundETH()" },
];

const UNISWAP_ROUTER: CallRule[] = [
  {
    sig: "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
    recipients: [["params.recipient", "self"]],
  },
  {
    sig: "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params)",
    recipients: [["params.recipient", "self"]],
  },
  {
    sig: "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params)",
    recipients: [["params.recipient", "self"]],
  },
  {
    sig: "function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params)",
    recipients: [["params.recipient", "self"]],
  },
  ...UNISWAP_PAYMENTS,
  ...multicallRules({}),
];

const UNISWAP_POSITIONS: CallRule[] = [
  {
    sig: "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params)",
    recipients: [["params.recipient", "self"]],
  },
  {
    // The position manager does not check who owns the token being topped up: the caller pays and
    // the owner gets the liquidity. Adding to someone else's position is a gift.
    sig: "function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params)",
    check: (call, cx) => {
      const tokenId = readPath(call, "params.tokenId");
      if (typeof tokenId === "bigint" && cx.allow.ownPositions.has(tokenId.toString())) return null;
      return (
        `${cx.label}: increaseLiquidity() on position ${String(tokenId)}, which the observation does ` +
        "not list as this agent's -- adding liquidity to another owner's position gives it to them"
      );
    },
  },
  {
    sig: "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params)",
  },
  {
    sig: "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params)",
    recipients: [["params.recipient", "self"]],
  },
  { sig: "function burn(uint256 tokenId)" },
  { sig: "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)" },
  ...UNISWAP_PAYMENTS,
  ...multicallRules({}),
];

const FUNDS = "(address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds";
const BALANCER_VAULT: CallRule[] = [
  {
    sig: `function swap((bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap, ${FUNDS}, uint256 limit, uint256 deadline)`,
    recipients: [["funds.sender", "self"], ["funds.recipient", "self"]],
  },
  {
    sig: `function batchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, ${FUNDS}, int256[] limits, uint256 deadline)`,
    recipients: [["funds.sender", "self"], ["funds.recipient", "self"]],
  },
  {
    sig: "function joinPool(bytes32 poolId, address sender, address recipient, (address[] assets, uint256[] maxAmountsIn, bytes userData, bool fromInternalBalance) request)",
    recipients: [["sender", "self"], ["recipient", "self"]],
  },
  {
    sig: "function exitPool(bytes32 poolId, address sender, address recipient, (address[] assets, uint256[] minAmountsOut, bytes userData, bool toInternalBalance) request)",
    recipients: [["sender", "self"], ["recipient", "self"]],
  },
];

// Curve's pools default the receiver to the caller; the overloads that take one are the ones that
// need a rule. Both families are listed for every Curve address: a selector names its full
// signature, so a crypto-pool signature sent to a stableswap pool just reverts.
const withReceiver = (sigs: string[]): CallRule[] =>
  sigs.flatMap((sig) => [
    { sig: `function ${sig})` },
    { sig: `function ${sig}, address receiver)`, recipients: [["receiver", "self"]] as Array<[string, Must]> },
  ]);
const CURVE_POOL: CallRule[] = [
  // twocrypto-ng (and the fork's tricrypto): uint256 coin indices, fixed-size amounts.
  ...withReceiver([
    "exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy",
    "exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy",
    "add_liquidity(uint256[2] amounts, uint256 min_mint_amount",
    "remove_liquidity(uint256 amount, uint256[2] min_amounts",
    "remove_liquidity_one_coin(uint256 token_amount, uint256 i, uint256 min_amount",
  ]),
  { sig: "function add_liquidity(uint256[3] amounts, uint256 min_mint_amount)" },
  { sig: "function remove_liquidity(uint256 amount, uint256[3] min_amounts)" },
  // stableswap-ng: int128 coin indices, dynamic amounts.
  ...withReceiver([
    "exchange(int128 i, int128 j, uint256 dx, uint256 min_dy",
    "exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy",
    "add_liquidity(uint256[] amounts, uint256 min_mint_amount",
    "remove_liquidity(uint256 burn_amount, uint256[] min_amounts",
    "remove_liquidity_one_coin(uint256 burn_amount, int128 i, uint256 min_received",
    "remove_liquidity_imbalance(uint256[] amounts, uint256 max_burn_amount",
  ]),
  {
    sig: "function remove_liquidity(uint256 burn_amount, uint256[] min_amounts, address receiver, bool claim_admin_fees)",
    recipients: [["receiver", "self"]],
  },
];

// FlashArb.Params (contracts/FlashArb.sol): where the receiver sends the arb's profit.
const FLASH_ARB_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "mode", type: "uint8" },
      { name: "wethMinOut", type: "uint256" },
      { name: "usdcMinOut", type: "uint256" },
      { name: "profitTo", type: "address" },
    ],
  },
] as const;

const AAVE_POOL: CallRule[] = [
  // Supplying or repaying on behalf of someone else is a gift to them; borrowing on someone's
  // behalf books their debt; withdrawing to someone pays them.
  {
    sig: "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
    recipients: [["onBehalfOf", "self"]],
  },
  {
    sig: "function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
    recipients: [["onBehalfOf", "self"]],
  },
  { sig: "function withdraw(address asset, uint256 amount, address to)", recipients: [["to", "self"]] },
  {
    sig: "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
    recipients: [["onBehalfOf", "self"]],
  },
  {
    sig: "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)",
    recipients: [["onBehalfOf", "self"]],
  },
  { sig: "function repayWithATokens(address asset, uint256 amount, uint256 interestRateMode)" },
  { sig: "function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)" },
  { sig: "function setUserEMode(uint8 categoryId)" },
  // The seized collateral goes to the caller; the user is the position being closed.
  {
    sig: "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)",
  },
  {
    // Only into the bundled FlashArb (flash-arb), which pays the profit to `profitTo` in its params.
    // An arbitrary receiver is a contract that gets the loan and decides what happens next.
    sig: "function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes params, uint16 referralCode)",
    recipients: [["receiverAddress", "flashReceiver"]],
    check: (call, cx) => {
      let profitTo: string | undefined;
      try {
        const [p] = decodeAbiParameters(FLASH_ARB_PARAMS, readPath(call, "params") as Hex);
        profitTo = p.profitTo.toLowerCase();
      } catch {
        profitTo = undefined;
      }
      if (profitTo !== undefined && profitTo === cx.allow.self) return null;
      return (
        `${cx.label}: flashLoanSimple() pays the FlashArb profit to ${profitTo ?? "(params do not decode)"} ` +
        `-- a revised strategy may only name its own address (${cx.allow.self ?? "unknown"}) there`
      );
    },
  },
];

const GMX_CREATE_ORDER =
  "function createOrder(((address receiver, address cancellationReceiver, address callbackContract, address uiFeeReceiver, address market, address initialCollateralToken, address[] swapPath) addresses, (uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice, uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit, uint256 minOutputAmount, uint256 validFromTime) numbers, uint8 orderType, uint8 decreasePositionSwapType, bool isLong, bool shouldUnwrapNativeToken, bool autoCancel, bytes32 referralCode, bytes32[] dataList) params)";

// What reaches OrderVault outside an order is credited to the next order anyone creates (the vault
// records balance deltas), so the two funding calls only make sense in front of a createOrder.
const onlyInMulticall = (call: Decoded, cx: CheckContext): string | null =>
  cx.depth > 0
    ? null
    : `${cx.label}: ${call.name}() outside a multicall -- what reaches GMX's OrderVault without an ` +
      "order in the same transaction is credited to the next order anyone creates";

const GMX_EXCHANGE_ROUTER: CallRule[] = [
  ...multicallRules({ payable: true, gmx: true }),
  {
    sig: "function sendWnt(address receiver, uint256 amount)",
    recipients: [["receiver", "gmxOrderVault"]],
    check: onlyInMulticall,
  },
  {
    sig: "function sendTokens(address token, address receiver, uint256 amount)",
    recipients: [["receiver", "gmxOrderVault"]],
    check: onlyInMulticall,
  },
  {
    sig: GMX_CREATE_ORDER,
    recipients: [
      ["params.addresses.receiver", "self"],
      ["params.addresses.cancellationReceiver", "selfOrZero"],
      ["params.addresses.uiFeeReceiver", "selfOrZero"],
      // The keeper refuses an order with a callback anyway (gmxKeeperRefusal); the collateral then
      // sits in OrderVault until cancelled. Refusing it here saves the round trip.
      ["params.addresses.callbackContract", "zero"],
    ],
  },
  { sig: "function cancelOrder(bytes32 key)" },
  {
    sig: "function claimFundingFees(address[] markets, address[] tokens, address receiver)",
    recipients: [["receiver", "self"]],
  },
  {
    sig: "function claimCollateral(address[] markets, address[] tokens, uint256[] timeKeys, address receiver)",
    recipients: [["receiver", "self"]],
  },
];

const LST_VAULT: CallRule[] = [
  { sig: "function deposit(uint256 assets, address receiver)", recipients: [["receiver", "self"]] },
  { sig: "function deposit(uint256 assets)" },
  { sig: "function requestWithdraw(uint256 shares)" },
  {
    sig: "function redeem(uint256 shares, address receiver, address owner)",
    recipients: [["receiver", "self"], ["owner", "self"]],
  },
  {
    sig: "function withdraw(uint256 assets, address receiver, address owner)",
    recipients: [["receiver", "self"], ["owner", "self"]],
  },
  { sig: "function claimWithdraw(uint256 requestId)" },
  { sig: "function claimAllWithdrawals()" },
  { sig: "function accrueRewards()" },
];

// Liquity V1 acts on the caller's own Trove / deposit / stake everywhere; the hint addresses are
// positions in the sorted list, not recipients. The one address that routes value is the Stability
// Pool's front-end tag, which takes a share of the depositor's LQTY: this deployment has no front
// ends, so it must be zero (as the adapter sends it).
const LIQUITY_BORROWER_OPERATIONS: CallRule[] = [
  {
    sig: "function openTrove(uint256 maxFeePercentage, uint256 LUSDAmount, address upperHint, address lowerHint)",
    payable: true,
  },
  { sig: "function addColl(address upperHint, address lowerHint)", payable: true },
  { sig: "function withdrawColl(uint256 amount, address upperHint, address lowerHint)" },
  { sig: "function withdrawLUSD(uint256 maxFeePercentage, uint256 amount, address upperHint, address lowerHint)" },
  { sig: "function repayLUSD(uint256 amount, address upperHint, address lowerHint)" },
  {
    sig: "function adjustTrove(uint256 maxFeePercentage, uint256 collWithdrawal, uint256 LUSDChange, bool isDebtIncrease, address upperHint, address lowerHint)",
    payable: true,
  },
  { sig: "function closeTrove()" },
  { sig: "function claimCollateral()" },
];
const LIQUITY_STABILITY_POOL: CallRule[] = [
  { sig: "function provideToSP(uint256 amount, address frontEndTag)", recipients: [["frontEndTag", "zero"]] },
  { sig: "function withdrawFromSP(uint256 amount)" },
  { sig: "function withdrawETHGainToTrove(address upperHint, address lowerHint)" },
];
const LIQUITY_TROVE_MANAGER: CallRule[] = [
  { sig: "function liquidate(address borrower)" },
  { sig: "function batchLiquidateTroves(address[] troveArray)" },
  { sig: "function liquidateTroves(uint256 n)" },
  {
    sig: "function redeemCollateral(uint256 LUSDAmount, address firstRedemptionHint, address upperPartialRedemptionHint, address lowerPartialRedemptionHint, uint256 partialRedemptionHintNICR, uint256 maxIterations, uint256 maxFeePercentage)",
  },
];
const LIQUITY_STAKING: CallRule[] = [
  { sig: "function stake(uint256 amount)" },
  { sig: "function unstake(uint256 amount)" },
];
const LIQUITY_REDEMPTION_HELPER: CallRule[] = [
  { sig: "function redeem(uint256 amount, uint256 maxFeePercentage, uint256 maxIterations)" },
];

// contracts/SimpleLending.sol: every function acts on msg.sender's position and pays msg.sender.
const MARKET = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) params";
const LENDING: CallRule[] = [
  { sig: `function createMarket(${MARKET})` },
  ...["supply", "withdraw", "supplyCollateral", "withdrawCollateral", "borrow", "repay"].map((name) => ({
    sig: `function ${name}(${MARKET}, uint256 assets)`,
  })),
  { sig: `function withdrawAll(${MARKET})` },
  { sig: `function repayAll(${MARKET})` },
  { sig: `function liquidate(${MARKET}, address borrower, uint256 seizedAssets)` },
];

// The contracts the reference agents deploy (contracts/LeakyVault.sol, Exploiter.sol, SimpleAMM.sol,
// RiggedAMM.sol). A registry entry of kind unknown is code the runtime cannot read, so these are the
// only calls it lets a revised strategy make there: each pays the caller, or names a recipient
// checked to be the caller. A contract that only shares the selector does what it does with the
// caller's allowances to it, which a revised strategy cannot grant (approve names a venue or a
// verified entry).
const AGENT_CONTRACT: CallRule[] = [
  { sig: "function deposit(uint256 assets)" },
  { sig: "function withdraw(uint256 sharesToBurn)" },
  { sig: "function withdrawAll()" },
  { sig: "function rescue()" },
  { sig: "function drain(address target, bytes[] calls, address[] tokens)" },
  {
    sig: "function swap(uint256 amountIn, uint256 minOut, address tokenIn, address to)",
    recipients: [["to", "self"]],
  },
];

const TABLES: Record<Role, CallRule[]> = {
  token: TOKEN,
  weth: [{ sig: "function deposit()", payable: true }, { sig: "function withdraw(uint256 wad)" }],
  uniswapRouter: UNISWAP_ROUTER,
  uniswapPositions: UNISWAP_POSITIONS,
  uniswapPool: [],
  balancerVault: BALANCER_VAULT,
  curvePool: CURVE_POOL,
  aavePool: AAVE_POOL,
  gmxExchangeRouter: GMX_EXCHANGE_ROUTER,
  gmxRouter: [],
  lstVault: LST_VAULT,
  liquityBorrowerOperations: LIQUITY_BORROWER_OPERATIONS,
  liquityStabilityPool: LIQUITY_STABILITY_POOL,
  liquityTroveManager: LIQUITY_TROVE_MANAGER,
  liquityStaking: LIQUITY_STAKING,
  liquityRedemptionHelper: LIQUITY_REDEMPTION_HELPER,
  lending: LENDING,
  agentContract: AGENT_CONTRACT,
};

type CompiledRule = CallRule & { fn: AbiFunction; selector: string };

let compiled: Map<Role, Map<string, CompiledRule>> | undefined;

// A recipient path that names no address argument would make the rule throw at send time, on the
// first strategy to use it. Checked when the table is compiled instead.
function assertAddressPath(fn: AbiFunction, path: string, sig: string): void {
  const [head, ...rest] = path.split(".");
  let param: AbiParameter | undefined = fn.inputs.find((input) => input.name === head);
  for (const key of rest)
    param = (param as { components?: readonly AbiParameter[] } | undefined)?.components?.find(
      (c) => c.name === key,
    );
  if (param?.type !== "address")
    throw new Error(`rawTxGuard: ${sig} has no address argument ${path}`);
}

/** Role -> selector -> rule, parsed once. A duplicate selector within one role is a table bug. */
export function callTables(): ReadonlyMap<Role, ReadonlyMap<string, CompiledRule>> {
  if (compiled) return compiled;
  const out = new Map<Role, Map<string, CompiledRule>>();
  for (const [role, rules] of Object.entries(TABLES) as Array<[Role, CallRule[]]>) {
    const bySelector = new Map<string, CompiledRule>();
    for (const rule of rules) {
      const fn = parseAbiItem(rule.sig) as AbiFunction;
      const selector = toFunctionSelector(fn).toLowerCase();
      for (const [path] of rule.recipients ?? []) assertAddressPath(fn, path, rule.sig);
      if (bySelector.has(selector))
        throw new Error(`rawTxGuard: ${role} lists selector ${selector} twice (${rule.sig})`);
      bySelector.set(selector, { ...rule, fn, selector });
    }
    out.set(role, bySelector);
  }
  compiled = out;
  return out;
}

// ---------------------------------------------------------------------------
// Who is what
// ---------------------------------------------------------------------------

// Every address in a value: the bundled address table is a handful of nested objects of addresses
// and numbers. Walking it generically is what makes `bundledAddresses` complete without a
// hand-maintained twin; the roles below are the hand-maintained part, and
// test/rawTxGuard.test.ts checks every walked address is either given a role or listed as inert.
function collectAddresses(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (ADDRESS.test(value)) into.add(value.toLowerCase());
    return;
  }
  if (typeof value !== "object") return;
  for (const v of Object.values(value as Record<string, unknown>))
    collectAddresses(v, into, depth + 1);
}

let bundled: Set<string> | undefined;

/** The addresses of the bundled address table (sdk/src/constants.ts), computed once. */
export function bundledAddresses(): ReadonlySet<string> {
  if (bundled) return bundled;
  const set = new Set<string>();
  const {
    TOKENS,
    USDC_VARIANTS,
    UNISWAP,
    BALANCER,
    CURVE,
    GMX,
    GMX_MARKETS,
    AAVE,
    LST,
    LIQUITY,
    MARKET_LEGS,
    STABLE_MARKET_LEGS,
    MULTICALL3,
  } = constants;
  for (const table of [
    TOKENS,
    USDC_VARIANTS,
    UNISWAP,
    BALANCER,
    CURVE,
    GMX,
    GMX_MARKETS,
    AAVE,
    LST,
    LIQUITY,
    MARKET_LEGS,
    STABLE_MARKET_LEGS,
    MULTICALL3,
    FLASH_ARB_ADDRESS,
  ])
    collectAddresses(table, set);
  bundled = set;
  return set;
}

let bundledRoleMap: Map<string, Set<Role>> | undefined;

/** Bundled address -> roles. Addresses of the table that are absent here are inert (see below). */
export function bundledRoles(): ReadonlyMap<string, ReadonlySet<Role>> {
  if (bundledRoleMap) return bundledRoleMap;
  const map = new Map<string, Set<Role>>();
  const add = (address: string | undefined, ...roles: Role[]) => {
    if (address === undefined || !ADDRESS.test(address)) return;
    const key = address.toLowerCase();
    const set = map.get(key) ?? new Set<Role>();
    for (const r of roles) set.add(r);
    map.set(key, set);
  };
  const { TOKENS, USDC_VARIANTS, UNISWAP, BALANCER, CURVE, GMX, GMX_MARKETS, AAVE, LST, LIQUITY } =
    constants;
  const { MARKET_LEGS, STABLE_MARKET_LEGS } = constants;
  for (const t of Object.values(TOKENS)) add(t.address, "token");
  add(TOKENS.WETH.address, "weth");
  for (const a of Object.values(USDC_VARIANTS)) add(a, "token");
  add(UNISWAP.swapRouter, "uniswapRouter");
  // An ERC-721: `approve(operator, tokenId)` shares the ERC-20 selector and its spender rule.
  add(UNISWAP.nonfungiblePositionManager, "uniswapPositions", "token");
  add(UNISWAP.poolWethUsdc500, "uniswapPool");
  for (const leg of Object.values(MARKET_LEGS.uniswap)) add(leg.pool, "uniswapPool");
  add(BALANCER.vault, "balancerVault");
  add(BALANCER.pool, "token"); // the BPT
  for (const t of BALANCER.tokens) add(t, "token");
  add(BALANCER.usdcToken, "token");
  for (const leg of Object.values(MARKET_LEGS.balancer)) {
    for (const t of leg.tokens) add(t, "token");
    add(leg.stable, "token");
  }
  // A Curve pool is its own LP token (twocrypto-ng / stableswap-ng).
  add(CURVE.pool, "curvePool", "token");
  add(CURVE.usdcToken, "token");
  for (const leg of Object.values(MARKET_LEGS.curve)) {
    add(leg.pool, "curvePool", "token");
    add(leg.stable, "token");
  }
  for (const leg of Object.values(STABLE_MARKET_LEGS)) add(leg.pool, "curvePool", "token");
  add(GMX.ExchangeRouter, "gmxExchangeRouter");
  add(GMX.Router, "gmxRouter");
  for (const m of Object.values(GMX_MARKETS)) add(m, "token"); // GM tokens
  for (const leg of Object.values(MARKET_LEGS.gmx)) add(leg.market, "token");
  add(AAVE.Pool, "aavePool");
  if (LST) {
    add(LST.vault, "lstVault", "token");
    add(LST.lstToken, "lstVault", "token");
    add(LST.asset, "token");
    add(LST.pool, "curvePool", "token");
    add(LST.aaveAToken, "token");
  }
  if (LIQUITY) {
    add(LIQUITY.borrowerOperations, "liquityBorrowerOperations");
    add(LIQUITY.stabilityPool, "liquityStabilityPool");
    add(LIQUITY.troveManager, "liquityTroveManager");
    add(LIQUITY.lqtyStaking, "liquityStaking");
    add(LIQUITY.redemptionHelper, "liquityRedemptionHelper");
    add(LIQUITY.eusd, "token");
    add(LIQUITY.lqtyToken, "token");
    add(LIQUITY.eusdUsdcPool, "curvePool", "token");
    add(LIQUITY.stable, "token");
  }
  bundledRoleMap = map;
  return map;
}

/**
 * Bundled addresses a revised strategy may not call at all: read-only helpers, the venues'
 * internals and admin surfaces, Multicall3 (it calls out as itself) and the FlashArb receiver (Aave
 * calls it). Listed so that a new address in the constants has to be put on one side or the other.
 */
export function bundledInertAddresses(): ReadonlySet<string> {
  const { UNISWAP, BALANCER, GMX, AAVE, LST, LIQUITY, MULTICALL3 } = constants;
  const out = new Set<string>();
  const add = (a: string | undefined) => {
    if (a !== undefined && ADDRESS.test(a)) out.add(a.toLowerCase());
  };
  add(UNISWAP.quoterV2);
  add(BALANCER.queries);
  for (const [name, a] of Object.entries(GMX))
    if (name !== "ExchangeRouter" && name !== "Router") add(a);
  for (const [name, a] of Object.entries(AAVE)) if (name !== "Pool") add(a);
  if (LST) {
    add(LST.aaveAggregator);
    add(LST.aaveVariableDebtToken); // approveDelegation would let the delegatee borrow as you
  }
  if (LIQUITY) {
    for (const a of [
      LIQUITY.sortedTroves,
      LIQUITY.activePool,
      LIQUITY.defaultPool,
      LIQUITY.collSurplusPool,
      LIQUITY.gasPool,
      LIQUITY.hintHelpers,
      LIQUITY.priceFeed,
      LIQUITY.communityIssuance,
    ])
      add(a);
  }
  add(MULTICALL3);
  add(FLASH_ARB_ADDRESS);
  return out;
}

// A registry entry's roles. `verified` means the environment's factory made it, so its code is
// the environment's; only then does the kind say which table applies.
function registryRoles(entry: Pick<RegistryEntryObservation, "kind" | "verified">): Role[] {
  if (entry.kind === "erc20") return ["token"];
  if (!entry.verified) return ["agentContract"];
  switch (entry.kind) {
    case "uniswapV3Pool":
      return ["uniswapPool"];
    case "lendingMarket":
      return ["lending"];
    case "curvePlainPool":
    case "curveTwocryptoPool":
      return ["curvePool", "token"];
    case "balancerWeightedPool":
      return ["token"];
    default:
      return ["agentContract"];
  }
}

/**
 * The allowlist for one decision: the bundled table, the run's own contracts the runtime was given
 * (PriceFeed, market registry, lending singleton), what the registry currently lists, and whose
 * address every recipient must be.
 */
export function rawTxAllowlist(opts: {
  observation: AgentObservation | null;
  runContracts?: {
    priceFeed?: string | null;
    marketRegistry?: string | null;
    lending?: string | null;
  };
  // The agent's address. Defaults to the observation's; without either, every recipient is refused.
  self?: string;
}): RawTxAllowlist {
  const known = new Set<string>(bundledAddresses());
  const roles = new Map<string, Set<Role>>();
  for (const [a, r] of bundledRoles()) roles.set(a, new Set(r));
  const addRoles = (address: string, more: Role[]) => {
    const key = address.toLowerCase();
    const set = roles.get(key) ?? new Set<Role>();
    for (const r of more) set.add(r);
    roles.set(key, set);
  };
  const run = opts.runContracts ?? {};
  for (const a of [run.priceFeed, run.marketRegistry, run.lending])
    if (typeof a === "string" && ADDRESS.test(a)) known.add(a.toLowerCase());
  if (typeof run.lending === "string" && ADDRESS.test(run.lending)) addRoles(run.lending, ["lending"]);
  const registry = new Map<string, { verified: boolean; kind: string }>();
  const reg = opts.observation?.registry;
  if (reg) {
    if (ADDRESS.test(reg.address)) known.add(reg.address.toLowerCase());
    for (const e of reg.entries) {
      if (!ADDRESS.test(e.market)) continue;
      const key = e.market.toLowerCase();
      // One address can carry several entries (every lending market sits on the singleton). A
      // verified one wins: the address runs the environment's code whatever else was said of it.
      const prior = registry.get(key);
      if (prior === undefined || (!prior.verified && e.verified))
        registry.set(key, { verified: e.verified, kind: e.kind });
      // A run address keeps its own roles: an unverified entry on a known address does not turn a
      // venue into an unknown contract.
      if (!known.has(key) || e.verified) addRoles(key, registryRoles(e));
    }
  }
  const selfRaw = opts.self ?? opts.observation?.agentAddress;
  const self = selfRaw !== undefined && ADDRESS.test(selfRaw) ? selfRaw.toLowerCase() : undefined;
  const ownPositions = new Set<string>(
    (opts.observation?.protocols?.uniswap?.positions ?? []).map((p) => p.tokenId),
  );
  return { known, registry, roles, self, ownPositions };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function isSpender(address: string, allow: RawTxAllowlist): boolean {
  for (const r of allow.roles.get(address) ?? []) if (SPENDER_ROLES.has(r)) return true;
  return allow.registry.get(address)?.verified === true;
}

function lowerAddress(value: unknown): string | undefined {
  return typeof value === "string" && ADDRESS.test(value) ? value.toLowerCase() : undefined;
}

// "params.addresses.receiver": the input named `params`, then its tuple components by name.
function readPath(call: Decoded, path: string): unknown {
  const [head, ...rest] = path.split(".");
  const index = call.fn.inputs.findIndex((input) => input.name === head);
  if (index < 0) throw new Error(`rawTxGuard: ${call.name} has no input ${head}`);
  let value: unknown = call.args[index];
  for (const key of rest) value = (value as Record<string, unknown> | undefined)?.[key];
  return value;
}

function mustHold(must: Must, value: string | undefined, allow: RawTxAllowlist): boolean {
  if (value === undefined) return false;
  switch (must) {
    case "self":
      return value === allow.self;
    case "selfOrZero":
      return value === allow.self || value === ZERO;
    case "zero":
      return value === ZERO;
    case "gmxOrderVault":
      return value === constants.GMX.OrderVault.toLowerCase();
    case "flashReceiver":
      return value === FLASH_ARB_ADDRESS.toLowerCase();
  }
}

function describeMust(must: Must, allow: RawTxAllowlist): string {
  switch (must) {
    case "self":
      return `may only name its own address (${allow.self ?? "unknown"}) there`;
    case "selfOrZero":
      return `may only name its own address (${allow.self ?? "unknown"}) or zero there`;
    case "zero":
      return "must leave it zero";
    case "gmxOrderVault":
      return `may only name GMX's OrderVault (${constants.GMX.OrderVault}) there`;
    case "flashReceiver":
      return `may only name the bundled FlashArb receiver (${FLASH_ARB_ADDRESS}) there`;
  }
}

function selectorName(selector: string): string {
  const name = METHOD_SELECTORS[selector];
  return name !== undefined ? `${name}() (${selector})` : `selector ${selector}`;
}

function rolesText(roles: ReadonlySet<Role>): string {
  if (roles.size === 0) return "a contract of this run with nothing a revised strategy may call";
  return [...roles].map((r) => ROLE_LABEL[r]).join(" / ");
}

function checkCall(data: string, cx: CheckContext): CheckResult {
  const selector = data.slice(0, 10).toLowerCase();
  const refused = REFUSED_SELECTORS[selector];
  if (refused !== undefined)
    return {
      ok: false,
      reason:
        `${cx.label}: ${refused}() to ${cx.to} -- a revised strategy may not move a balance ` +
        "directly; venues pull what they need through the registered actions",
    };
  if (data.length < 10) {
    // No selector: a plain ETH transfer (WETH's fallback deposits it) or an empty call.
    if (cx.depth === 0 && cx.roles.has("weth") && cx.value > 0n) return { ok: true, call: null };
    return {
      ok: false,
      reason:
        `${cx.label}: a call with no function selector to ${cx.to} -- a revised strategy may send ` +
        "plain ETH only to WETH",
    };
  }
  let rule: CompiledRule | undefined;
  const tables = callTables();
  for (const role of cx.roles) {
    rule = tables.get(role)?.get(selector);
    if (rule) break;
  }
  if (rule === undefined)
    return {
      ok: false,
      reason:
        `${cx.label}: ${selectorName(selector)} on ${cx.to} (${rolesText(cx.roles)}) is not a call ` +
        "a revised strategy may make -- the runtime lets a model-written strategy call only " +
        "functions whose every recipient it can check",
    };
  const name = rule.fn.name;
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: [rule.fn], data: data as Hex }).args ?? [];
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return {
      ok: false,
      reason: `${cx.label}: ${name}() on ${cx.to} does not decode as ${rule.sig.slice(9)} (${why})`,
    };
  }
  const call: Decoded = { name, fn: rule.fn, args };
  if (cx.depth === 0 && cx.value > 0n && !rule.payable)
    return {
      ok: false,
      reason:
        `${cx.label}: ${name}() on ${cx.to} carries ${cx.value} wei -- a revised strategy may send ` +
        "ETH only to WETH, as Liquity Trove collateral, or in a GMX multicall that forwards all of " +
        "it with sendWnt",
    };
  for (const [path, must] of rule.recipients ?? []) {
    const raw = readPath(call, path);
    const value = lowerAddress(raw);
    if (!mustHold(must, value, cx.allow))
      return {
        ok: false,
        reason:
          `${cx.label}: ${name}() on ${cx.to} names ${path} = ${value ?? String(raw)} -- a revised ` +
          `strategy ${describeMust(must, cx.allow)}`,
      };
  }
  const extra = rule.check?.(call, cx) ?? null;
  if (extra !== null) return { ok: false, reason: extra };
  return { ok: true, call };
}

// The inner calls of a multicall, each against the same address. GMX's also has to account for
// what the batch leaves behind: OrderVault credits balance deltas to the next order created, and
// ExchangeRouter's `sendWnt` wraps from the router's own balance, so ETH it was sent and did not
// forward is anyone's to forward.
function checkMulticall(call: Decoded, cx: CheckContext, gmx: boolean): string | null {
  if (cx.depth > 0)
    return `${cx.label}: a multicall inside a multicall is not checked -- flatten it`;
  const inner = readPath(call, "data") as readonly Hex[];
  const decoded: Decoded[] = [];
  for (let i = 0; i < inner.length; i++) {
    const result = checkCall(inner[i], {
      ...cx,
      depth: cx.depth + 1,
      label: `${cx.label} ${call.name}[${i}]`,
    });
    if (!result.ok) return result.reason;
    if (result.call) decoded.push(result.call);
  }
  if (!gmx) return null;
  let forwarded = 0n;
  let wntAwaitingOrder = false;
  const tokensAwaitingOrder: string[] = [];
  for (const c of decoded) {
    if (c.name === "sendWnt") {
      forwarded += readPath(c, "amount") as bigint;
      wntAwaitingOrder = true;
    } else if (c.name === "sendTokens") {
      tokensAwaitingOrder.push(lowerAddress(readPath(c, "token")) ?? "?");
    } else if (c.name === "createOrder") {
      const collateral = lowerAddress(readPath(c, "params.addresses.initialCollateralToken"));
      for (let k = tokensAwaitingOrder.length - 1; k >= 0; k--)
        if (tokensAwaitingOrder[k] === collateral) tokensAwaitingOrder.splice(k, 1);
      wntAwaitingOrder = false;
    }
  }
  if (tokensAwaitingOrder.length > 0)
    return (
      `${cx.label}: sendTokens(${tokensAwaitingOrder[0]}) is not followed by a createOrder that ` +
      "takes it as collateral -- what reaches GMX's OrderVault outside an order is credited to the " +
      "next order anyone creates"
    );
  if (wntAwaitingOrder)
    return (
      `${cx.label}: sendWnt() is not followed by a createOrder -- what reaches GMX's OrderVault ` +
      "outside an order is credited to the next order anyone creates"
    );
  if (forwarded !== cx.value)
    return (
      `${cx.label}: the multicall carries ${cx.value} wei and forwards ${forwarded} with sendWnt ` +
      "-- ETH left in GMX's ExchangeRouter can be forwarded by anyone's next sendWnt"
    );
  return null;
}

function checkOne(tx: RawTx, allow: RawTxAllowlist, label: string): RawTxGuardVerdict {
  if (tx.to === undefined)
    return {
      ok: false,
      reason: `${label}: a revised strategy may not deploy contracts (rawTx without \`to\`)`,
    };
  const to = tx.to.toLowerCase();
  const isKnown = allow.known.has(to);
  if (!isKnown && !allow.registry.has(to))
    return {
      ok: false,
      reason:
        `${label}: destination ${tx.to} is not a venue, a token of this run or a registry entry; ` +
        "a revised strategy may only send raw calldata to addresses the run knows",
    };
  let value: bigint;
  try {
    value = tx.value === undefined ? 0n : BigInt(tx.value);
  } catch {
    return { ok: false, reason: `${label}: value ${String(tx.value)} is not an integer` };
  }
  if (value > 0n && !isKnown)
    return {
      ok: false,
      reason: `${label}: a revised strategy may not send ETH to a registry entry (${tx.to})`,
    };
  const result = checkCall(tx.data, {
    allow,
    to: tx.to,
    roles: allow.roles.get(to) ?? new Set<Role>(),
    value,
    depth: 0,
    label,
  });
  return result.ok ? { ok: true } : result;
}

/**
 * Whether a revised strategy's raw action may be sent. Anything that is not `rawTx` / `rawBundle`
 * passes: the registered actions are built by the adapters, which name the agent as every recipient.
 */
export function checkRevisedRawTx(
  action: AgentAction,
  allow: RawTxAllowlist,
): RawTxGuardVerdict {
  try {
    if (action.type === "rawTx") return checkOne(action.tx, allow, "rawTx");
    if (action.type === "rawBundle") {
      for (let i = 0; i < action.txs.length; i++) {
        const verdict = checkOne(action.txs[i], allow, `rawBundle[${i}]`);
        if (!verdict.ok) return verdict;
      }
    }
    return { ok: true };
  } catch (error) {
    // Calldata shaped to trip the checker is refused, not waved through and not thrown into the
    // sender's loop.
    const why = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return { ok: false, reason: `${action.type}: the raw-calldata check failed (${why}); refused` };
  }
}
