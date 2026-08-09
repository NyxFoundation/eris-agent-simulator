// LST venue adapter (issue #38).
//
// The venue is a wstETH-style vault plus an LST/WETH stableswap-ng secondary market. What makes it
// a distinct skill axis is that an LST has two prices at once:
//
//   redemption rate  what the vault owes per share. Reachable only through the withdrawal queue,
//                    which takes `withdrawalDelayBlocks`.
//   market price     what the pool pays right now, at whatever discount (or premium) it trades.
//
// So an exit is a real choice -- slow and at par, or fast and discounted -- and the other side of
// that choice is a carry: buy LST while the pool is cheap and redeem at par, if the discount beats
// the queue's time cost. Both prices are reported separately in the observation, and post-run
// scoring marks the position at what it could *realize*, not at face redemption value.
//
// Unlike every other venue this one has no Arbitrum counterpart: the vault is ours, so it exists
// only under local deploy and `requireLst()` fails fast on a fork.
import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { curveStableSwapNgAbi, erc20Abi, lstVaultAbi } from "../abis.js";
import { LST, requireLst, TOKENS, type LstDeployment } from "../constants.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  LeafAction,
  LstClaimWithdrawAction,
  LstDepositAction,
  LstObservation,
  LstRequestWithdrawAction,
  LstSwapAction,
} from "../types.js";
import type {
  AgentProtocolValue,
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  UnpricedHoldingDetail,
  ValidationResult,
  ValuationContext,
  ValuationRead,
  ValuationRun,
} from "./types.js";
import { approveTx } from "./uniswap.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;
// Probe size for the two-sided market quote. Small enough that impact is negligible, so the quote
// reports the pool's price rather than the probe's own footprint.
const PROBE_LST_WEI = WAD / 10n;
const DEFAULT_SLIPPAGE_BPS = 50;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type LstState = {
  deployment: LstDeployment;
  // WETH per 1e18 LST, as the vault reports it.
  redemptionRateWeth: number;
  redemptionRateRaw: bigint;
  // Executable prices at probe size (WETH per LST), fee and impact included.
  sellPriceWeth: number;
  buyPriceWeth: number;
  // sqrt(sell x buy): the mid the two sides imply once the symmetric fee cancels.
  midPriceWeth: number;
  // How far the market sits below redemption, in bps. Positive = the market is discounted.
  discountBps: number;
  apyBps: number;
  yieldPerBlockBps: number;
  withdrawalDelayBlocks: number;
  queueLength: number;
  rewardReserveWei: bigint;
  pooledWeth: bigint;
  shareSupply: bigint;
  reserves: { weth: bigint; lst: bigint };
  // Issue #38 phase 2: 0 means the queue is not rate-limited and every request waits exactly
  // withdrawalDelayBlocks. Otherwise the wait also covers what is queued ahead plus your own size.
  queueThroughputWeiPerBlock: bigint;
  queueDrainBlock: bigint;
};

function toFloat(wei: bigint): number {
  return Number(wei) / 1e18;
}

/// Per-block yield in bps, from the vault's ray rate. This is the number an agent should compare a
/// discount against: waiting N blocks costs N x this in foregone... nothing, but earns it if held.
export function yieldPerBlockBpsFrom(ratePerBlockRay: bigint): number {
  return (Number(ratePerBlockRay) / Number(RAY)) * 10_000;
}

/// The APY that per-block rate implies on the run's compressed economic clock.
export function apyBpsFrom(
  ratePerBlockRay: bigint,
  simulatedSecondsPerBlock: number,
): number {
  if (simulatedSecondsPerBlock <= 0) return 0;
  const blocksPerYear = SECONDS_PER_YEAR / simulatedSecondsPerBlock;
  return (Number(ratePerBlockRay) / Number(RAY)) * blocksPerYear * 10_000;
}

/// Ray per-block rate for a target APY on a given economic clock. The environment uses this to
/// retune the vault; exported so the calibration lives in one place.
export function rewardRatePerBlockRay(
  apyBps: number,
  simulatedSecondsPerBlock: number,
): bigint {
  if (apyBps <= 0 || simulatedSecondsPerBlock <= 0) return 0n;
  return (
    (BigInt(Math.round(apyBps)) *
      BigInt(Math.round(simulatedSecondsPerBlock)) *
      RAY) /
    (10_000n * BigInt(SECONDS_PER_YEAR))
  );
}

/// Discount of the market against redemption, in bps. Positive means LST is trading cheap: buying
/// and queueing a redemption earns this, if the wait is worth it.
export function discountBpsFrom(
  redemptionRateWeth: number,
  marketPriceWeth: number,
): number {
  if (!(redemptionRateWeth > 0)) return 0;
  return ((redemptionRateWeth - marketPriceWeth) / redemptionRateWeth) * 10_000;
}

async function poolQuote(
  publicClient: PublicClient,
  deployment: LstDeployment,
  amountLstWei: bigint,
): Promise<bigint | undefined> {
  try {
    return (await publicClient.readContract({
      address: deployment.pool,
      abi: curveStableSwapNgAbi,
      functionName: "get_dy",
      args: [
        BigInt(deployment.poolLstIndex),
        BigInt(deployment.poolWethIndex),
        amountLstWei,
      ],
    })) as bigint;
  } catch {
    // A quote the pool refuses (no liquidity at that size) is "no instant exit", not zero value.
    return undefined;
  }
}

async function poolBuyQuote(
  publicClient: PublicClient,
  deployment: LstDeployment,
  amountWethWei: bigint,
): Promise<bigint | undefined> {
  try {
    return (await publicClient.readContract({
      address: deployment.pool,
      abi: curveStableSwapNgAbi,
      functionName: "get_dy",
      args: [
        BigInt(deployment.poolWethIndex),
        BigInt(deployment.poolLstIndex),
        amountWethWei,
      ],
    })) as bigint;
  } catch {
    return undefined;
  }
}

export async function getLstState(ctx: SimContext): Promise<LstState> {
  const deployment = requireLst();
  const { publicClient } = ctx;
  const [summary, wethReserve, lstReserve] = await Promise.all([
    publicClient.readContract({
      address: deployment.vault,
      abi: lstVaultAbi,
      functionName: "vaultSummary",
    }) as Promise<readonly bigint[]>,
    publicClient.readContract({
      address: deployment.pool,
      abi: curveStableSwapNgAbi,
      functionName: "balances",
      args: [BigInt(deployment.poolWethIndex)],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: deployment.pool,
      abi: curveStableSwapNgAbi,
      functionName: "balances",
      args: [BigInt(deployment.poolLstIndex)],
    }) as Promise<bigint>,
  ]);
  const [
    pooledWeth,
    shareSupply,
    redemptionRateRaw,
    rewardReserveWei,
    ,
    queueLength,
    delayBlocks,
    ratePerBlockRay,
    throughputWeiPerBlock,
    drainBlock,
  ] = summary;

  // Two-sided probe, the same discipline as the balancer/curve adapters: a one-sided quote
  // under-reports the executable mid when the pool is imbalanced, and an agent that trades against
  // that phantom spread bleeds fees (the WBTC all-agent bleed).
  const sellOut = await poolQuote(publicClient, deployment, PROBE_LST_WEI);
  const sellPriceWeth = sellOut ? toFloat(sellOut) / toFloat(PROBE_LST_WEI) : 0;
  let buyPriceWeth = 0;
  if (sellOut && sellOut > 0n) {
    const buyOut = await poolBuyQuote(publicClient, deployment, sellOut);
    if (buyOut && buyOut > 0n)
      buyPriceWeth = toFloat(sellOut) / toFloat(buyOut);
  }
  const midPriceWeth =
    sellPriceWeth > 0 && buyPriceWeth > 0
      ? Math.sqrt(sellPriceWeth * buyPriceWeth)
      : sellPriceWeth;

  const redemptionRateWeth = toFloat(redemptionRateRaw);
  return {
    deployment,
    redemptionRateWeth,
    redemptionRateRaw,
    sellPriceWeth,
    buyPriceWeth,
    midPriceWeth,
    discountBps: discountBpsFrom(redemptionRateWeth, midPriceWeth),
    apyBps: apyBpsFrom(ratePerBlockRay, ctx.config.lstSimulatedSecondsPerBlock),
    yieldPerBlockBps: yieldPerBlockBpsFrom(ratePerBlockRay),
    withdrawalDelayBlocks: Number(delayBlocks),
    queueLength: Number(queueLength),
    rewardReserveWei,
    pooledWeth,
    shareSupply,
    reserves: { weth: wethReserve, lst: lstReserve },
    queueThroughputWeiPerBlock: throughputWeiPerBlock,
    queueDrainBlock: drainBlock,
  };
}

// ---------------------------------------------------------------------------
// parse / validate
// ---------------------------------------------------------------------------

function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

function withPriorityFee<T extends { maxPriorityFeePerGasWei?: string }>(
  action: T,
  obj: Record<string, unknown>,
): T {
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    requireDecimalString(
      obj.maxPriorityFeePerGasWei,
      "maxPriorityFeePerGasWei",
    );
    action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
  }
  return action;
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  switch (obj.type) {
    case "lstDeposit": {
      requireDecimalString(obj.amountWethWei, "amountWethWei");
      return withPriorityFee<LstDepositAction>(
        { type: "lstDeposit", amountWethWei: obj.amountWethWei },
        obj,
      );
    }
    case "lstSwap": {
      if (obj.tokenIn !== "WETH" && obj.tokenIn !== "LST")
        throw new Error('lstSwap tokenIn must be "WETH" or "LST"');
      requireDecimalString(obj.amountIn, "amountIn");
      const action: LstSwapAction = {
        type: "lstSwap",
        tokenIn: obj.tokenIn,
        amountIn: obj.amountIn,
      };
      if (obj.slippageBps !== undefined) {
        if (
          typeof obj.slippageBps !== "number" ||
          !Number.isInteger(obj.slippageBps) ||
          obj.slippageBps < 0 ||
          obj.slippageBps > 1000
        )
          throw new Error("slippageBps must be an integer between 0 and 1000");
        action.slippageBps = obj.slippageBps;
      }
      return withPriorityFee(action, obj);
    }
    case "lstRequestWithdraw": {
      requireDecimalString(obj.amountLstWei, "amountLstWei");
      return withPriorityFee<LstRequestWithdrawAction>(
        { type: "lstRequestWithdraw", amountLstWei: obj.amountLstWei },
        obj,
      );
    }
    case "lstClaimWithdraw": {
      const action: LstClaimWithdrawAction = { type: "lstClaimWithdraw" };
      if (obj.requestId !== undefined && obj.requestId !== "all") {
        requireDecimalString(obj.requestId, "requestId");
        action.requestId = obj.requestId;
      }
      return withPriorityFee(action, obj);
    }
    default:
      return null;
  }
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  const lst = obs.protocols.lst;
  switch (action.type) {
    case "lstDeposit": {
      const amount = BigInt(action.amountWethWei);
      if (amount <= 0n)
        return { ok: false, reason: "amountWethWei must be positive" };
      const wethBalance = balances.bases?.WETH ?? balances.wethWei;
      if (amount > wethBalance)
        return { ok: false, reason: "amountWethWei exceeds WETH balance" };
      const cap = BigInt(obs.limits.maxLstDepositWethWei ?? "0");
      if (cap > 0n && amount > cap)
        return {
          ok: false,
          reason: "amountWethWei exceeds configured per-action limit",
        };
      return { ok: true };
    }
    case "lstSwap": {
      const amount = BigInt(action.amountIn);
      if (amount <= 0n)
        return { ok: false, reason: "amountIn must be positive" };
      if (action.tokenIn === "WETH") {
        const wethBalance = balances.bases?.WETH ?? balances.wethWei;
        if (amount > wethBalance)
          return { ok: false, reason: "amountIn exceeds WETH balance" };
        const maxWethIn = BigInt(obs.limits.maxWethInWei);
        if (maxWethIn > 0n && amount > maxWethIn)
          return {
            ok: false,
            reason: "amountIn exceeds configured per-round limit",
          };
        return { ok: true };
      }
      // The LST balance is not part of BalanceSnapshot (the token is not in the base registry --
      // it is valued by this adapter, not summed as spot), so it comes from the observation.
      if (!lst) return { ok: false, reason: "no lst observation available" };
      if (amount > BigInt(lst.lstBalanceWei))
        return { ok: false, reason: "amountIn exceeds LST balance" };
      return { ok: true };
    }
    case "lstRequestWithdraw": {
      const amount = BigInt(action.amountLstWei);
      if (amount <= 0n)
        return { ok: false, reason: "amountLstWei must be positive" };
      if (!lst) return { ok: false, reason: "no lst observation available" };
      if (amount > BigInt(lst.lstBalanceWei))
        return { ok: false, reason: "amountLstWei exceeds LST balance" };
      return { ok: true };
    }
    case "lstClaimWithdraw":
      if (!lst) return { ok: false, reason: "no lst observation available" };
      if (
        action.requestId === undefined &&
        BigInt(lst.claimableWithdrawalWethWei) <= 0n
      )
        return { ok: false, reason: "no finalized withdrawal to claim" };
      return { ok: true };
    default:
      return { ok: false, reason: "not an lst action" };
  }
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

async function observe(
  ctx: SimContext,
  state: LstState,
  agent: Address,
): Promise<LstObservation> {
  const { publicClient } = ctx;
  const deployment = state.deployment;
  const [summary, openRequests] = await Promise.all([
    publicClient.readContract({
      address: deployment.vault,
      abi: lstVaultAbi,
      functionName: "accountSummary",
      args: [agent],
    }) as Promise<readonly bigint[]>,
    publicClient.readContract({
      address: deployment.vault,
      abi: lstVaultAbi,
      functionName: "openRequestsOf",
      args: [agent],
    }) as Promise<readonly (readonly bigint[])[]>,
  ]);
  const [shares, shareAssets, pendingAssets, claimableAssets] = summary;

  // Quote the instant exit at the agent's *own* size, not at probe size: the whole point of a thin
  // secondary market is that a big exit is worth less per unit than a small one.
  const instantExit =
    shares > 0n
      ? ((await poolQuote(publicClient, deployment, shares)) ?? 0n)
      : 0n;

  const [ids, assets, claimableAt] = openRequests;
  const blockNumber = await publicClient.getBlockNumber();
  const pendingWithdrawals = ids.map((id, i) => ({
    requestId: id.toString(),
    assetsWethWei: assets[i].toString(),
    claimableAtBlock: claimableAt[i].toString(),
    claimable: blockNumber >= claimableAt[i],
  }));

  // What queueing would actually cost right now. With a rate-limited queue this exceeds the floor
  // by whatever is booked ahead plus this size's own drain time (issue #38 phase 2), and it is the
  // number an agent must compare against the blocks left in the run.
  const estimateDelay = async (assets: bigint): Promise<number> => {
    if (state.queueThroughputWeiPerBlock === 0n)
      return state.withdrawalDelayBlocks;
    try {
      return Number(
        (await publicClient.readContract({
          address: deployment.vault,
          abi: lstVaultAbi,
          functionName: "estimateDelayBlocks",
          args: [assets],
        })) as bigint,
      );
    } catch {
      return state.withdrawalDelayBlocks;
    }
  };
  const [estimatedQueueDelayBlocks, queueDelayPerWethBlocks] =
    await Promise.all([
      estimateDelay(shareAssets > 0n ? shareAssets : WAD),
      estimateDelay(WAD),
    ]);

  return {
    redemptionRateWeth: state.redemptionRateWeth,
    marketPriceWeth: state.midPriceWeth,
    ...(state.sellPriceWeth > 0
      ? { marketSellPriceWeth: state.sellPriceWeth }
      : {}),
    ...(state.buyPriceWeth > 0
      ? { marketBuyPriceWeth: state.buyPriceWeth }
      : {}),
    discountBps: state.discountBps,
    apyBps: state.apyBps,
    yieldPerBlockBps: state.yieldPerBlockBps,
    withdrawalDelayBlocks: state.withdrawalDelayBlocks,
    estimatedQueueDelayBlocks,
    queueDelayPerWethBlocks,
    queueThroughputWeiPerBlock: state.queueThroughputWeiPerBlock.toString(),
    queueLength: state.queueLength,
    rewardReserveWei: state.rewardReserveWei.toString(),
    lstBalanceWei: shares.toString(),
    lstRedemptionValueWethWei: shareAssets.toString(),
    instantExitWethWei: instantExit.toString(),
    pendingWithdrawals,
    pendingWithdrawalWethWei: pendingAssets.toString(),
    claimableWithdrawalWethWei: claimableAssets.toString(),
    poolReserves: {
      weth: state.reserves.weth.toString(),
      lst: state.reserves.lst.toString(),
    },
    // Phase 3: only true when the deploy listed it, so an agent can tell "leverage is off" from
    // "my supply failed".
    aaveCollateral: Boolean(deployment.aaveAToken),
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

async function buildTxs(
  ctx: SimContext,
  owner: Address,
  action: LeafAction,
): Promise<BuiltTx[]> {
  const deployment = requireLst();
  switch (action.type) {
    case "lstDeposit":
      return [
        {
          to: deployment.vault,
          data: encodeFunctionData({
            abi: lstVaultAbi,
            functionName: "deposit",
            args: [BigInt(action.amountWethWei), owner],
          }),
        },
      ];
    case "lstSwap": {
      const amountIn = BigInt(action.amountIn);
      const [i, j] =
        action.tokenIn === "LST"
          ? [deployment.poolLstIndex, deployment.poolWethIndex]
          : [deployment.poolWethIndex, deployment.poolLstIndex];
      const quoted = (await ctx.publicClient.readContract({
        address: deployment.pool,
        abi: curveStableSwapNgAbi,
        functionName: "get_dy",
        args: [BigInt(i), BigInt(j), amountIn],
      })) as bigint;
      const minDy = applySlippage(
        quoted,
        action.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      );
      return [
        {
          to: deployment.pool,
          data: encodeFunctionData({
            abi: curveStableSwapNgAbi,
            functionName: "exchange",
            args: [BigInt(i), BigInt(j), amountIn, minDy],
          }),
        },
      ];
    }
    case "lstRequestWithdraw":
      return [
        {
          to: deployment.vault,
          data: encodeFunctionData({
            abi: lstVaultAbi,
            functionName: "requestWithdraw",
            args: [BigInt(action.amountLstWei)],
          }),
        },
      ];
    case "lstClaimWithdraw":
      return [
        {
          to: deployment.vault,
          data:
            action.requestId === undefined
              ? encodeFunctionData({
                  abi: lstVaultAbi,
                  functionName: "claimAllWithdrawals",
                })
              : encodeFunctionData({
                  abi: lstVaultAbi,
                  functionName: "claimWithdraw",
                  args: [BigInt(action.requestId)],
                }),
        },
      ];
    default:
      throw new Error("lst buildTxs: unexpected action");
  }
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

/// What an LST position is actually worth in WETH, given how much of the run is left.
///
/// Shares can leave two ways and the better one wins: sell into the pool now (whatever the discount
/// costs at that size) or queue a redemption at par -- but the queue only counts if it finalizes
/// before the run ends. Queued WETH is par once it finalizes in time; anything finalizing after the
/// horizon is not realizable inside the run and is reported rather than counted.
export function realizableWethWei(input: {
  shares: bigint;
  shareAssets: bigint;
  instantExitWei: bigint | undefined;
  claimableAssets: bigint;
  reachableAssets: bigint;
  unreachableAssets: bigint;
  blockNumber: number;
  horizonBlock: number;
  // The wait this *particular* redemption would face, not the vault's floor: with a rate-limited
  // queue it also covers what is booked ahead and this size's own drain time (issue #38 phase 2).
  queueDelayBlocks: number;
}): { wei: bigint; queueUsed: boolean } {
  const queueFitsInRun =
    input.blockNumber + input.queueDelayBlocks <= input.horizonBlock;
  const viaQueue = queueFitsInRun ? input.shareAssets : 0n;
  const viaMarket = input.instantExitWei ?? 0n;
  const shareValue = viaQueue > viaMarket ? viaQueue : viaMarket;
  return {
    wei: shareValue + input.claimableAssets + input.reachableAssets,
    queueUsed: input.shares > 0n && viaQueue >= viaMarket && queueFitsInRun,
  };
}

/// Historical valuation (issue #41's staged reads, issue #38's realizable marking).
///
/// Two stages, because both the instant-exit quote and the queue's wait depend on a balance the
/// first stage returns:
///   0. every agent's account summary, split at the run's horizon, plus the queue floor
///   1. for exactly the agents that hold shares: the pool quote at that size, and — when the queue
///      is rate-limited — the wait that size would actually face
///
/// Takes the deployment explicitly rather than reading the module-level LST constant, so the
/// marking rules can be exercised without a deployed vault.
export async function* lstValuationRun(
  deployment: LstDeployment,
  ctx: ValuationContext,
): ValuationRun {
  const summaries = yield [
    {
      address: deployment.vault,
      abi: lstVaultAbi,
      functionName: "withdrawalDelayBlocks",
    },
    {
      address: deployment.vault,
      abi: lstVaultAbi,
      functionName: "queueThroughputWeiPerBlock",
    },
    ...ctx.agents.map((a) => ({
      address: deployment.vault,
      abi: lstVaultAbi,
      functionName: "accountSummaryAt",
      args: [a.address, BigInt(ctx.horizonBlock)],
    })),
  ];

  const floorDelayBlocks =
    typeof summaries[0] === "bigint" ? Number(summaries[0]) : 0;
  const rateLimited =
    typeof summaries[1] === "bigint" && (summaries[1] as bigint) > 0n;
  const perAgent = ctx.agents.map((_agent, i) => {
    const row = summaries[2 + i] as readonly bigint[] | undefined;
    if (!row) return undefined;
    return {
      shares: row[0],
      shareAssets: row[1],
      claimableAssets: row[2],
      reachableAssets: row[3],
      unreachableAssets: row[4],
    };
  });

  // Only agents holding shares need a pool quote (and, if the queue is rate-limited, a wait quote).
  const quoteTargets = perAgent
    .map((row, i) => ({ row, i }))
    .filter((x): x is { row: NonNullable<typeof x.row>; i: number } =>
      Boolean(x.row && x.row.shares > 0n),
    );
  let quotes: unknown[] = [];
  if (quoteTargets.length > 0) {
    quotes = yield [
      ...quoteTargets.map(({ row }): ValuationRead => ({
        address: deployment.pool,
        abi: curveStableSwapNgAbi,
        functionName: "get_dy",
        args: [
          BigInt(deployment.poolLstIndex),
          BigInt(deployment.poolWethIndex),
          row.shares,
        ],
      })),
      ...(rateLimited
        ? quoteTargets.map(({ row }): ValuationRead => ({
            address: deployment.vault,
            abi: lstVaultAbi,
            functionName: "estimateDelayBlocks",
            args: [row.shareAssets],
          }))
        : []),
    ];
  }
  const quoteByIndex = new Map<number, bigint | undefined>();
  const delayByIndex = new Map<number, number>();
  quoteTargets.forEach(({ i }, k) => {
    const q = quotes[k];
    quoteByIndex.set(i, typeof q === "bigint" ? q : undefined);
    const d = rateLimited ? quotes[quoteTargets.length + k] : undefined;
    // A wait we could not read falls back to the floor, which understates it — but the alternative
    // is refusing to mark a position we can otherwise price.
    delayByIndex.set(i, typeof d === "bigint" ? Number(d) : floorDelayBlocks);
  });

  const fairWeth = ctx.fairByBase().WETH ?? 0;
  const out: Record<string, AgentProtocolValue> = {};
  ctx.agents.forEach((agent, i) => {
    const row = perAgent[i];
    if (!row) {
      // The read that would have revealed the position failed. Saying "zero" here is
      // indistinguishable from having exited, so report it instead (issue #44).
      out[agent.id] = {
        valueUsdc: 0,
        liquidatableValueUsdc: 0,
        unpriced: [
          {
            source: "lst-position",
            amountRaw: "",
            reason: "read-failed",
            read: "MockLSTVault.accountSummaryAt",
          },
        ],
      };
      return;
    }
    const unpriced: UnpricedHoldingDetail[] = [];
    const instantExit = quoteByIndex.get(i);
    if (row.shares > 0n && instantExit === undefined) {
      // No instant exit available at this size. The queue may still reach par, so this is not
      // automatically a loss -- but say that the market leg is missing from the comparison.
      unpriced.push({
        token: deployment.lstToken,
        amountRaw: row.shares.toString(),
        source: "lst-market-quote",
        reason: "unpriced",
        read: "CurveStableSwapNG.get_dy",
      });
    }
    const { wei } = realizableWethWei({
      shares: row.shares,
      shareAssets: row.shareAssets,
      instantExitWei: instantExit,
      claimableAssets: row.claimableAssets,
      reachableAssets: row.reachableAssets,
      unreachableAssets: row.unreachableAssets,
      blockNumber: ctx.blockNumber,
      horizonBlock: ctx.horizonBlock,
      queueDelayBlocks: delayByIndex.get(i) ?? floorDelayBlocks,
    });
    if (row.unreachableAssets > 0n) {
      // Queued at par, but the queue finalizes after the run ends: real value, not realizable
      // inside the run. Excluded from the mark and reported, never silently zeroed.
      unpriced.push({
        token: deployment.asset,
        amountRaw: row.unreachableAssets.toString(),
        source: "lst-withdrawal-queue",
        reason: "unrealizable",
        read: "MockLSTVault.accountSummaryAt",
      });
    }
    const valueUsdc = toFloat(wei) * fairWeth;
    out[agent.id] = {
      valueUsdc,
      // The venue is marked at realizable value throughout, so the two agree here. They are kept
      // separate because #39/#40 will have positions whose face value diverges from their exit.
      liquidatableValueUsdc: valueUsdc,
      unpriced,
    };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const lstAdapter: ProtocolAdapter = {
  id: "lst",
  parse,
  // The vault and the pool are ordinary calls, so an LST leg can ride in a bundle with the AMM
  // legs (e.g. buy LST cheap and queue the redemption in one shot).
  bundleable: () => true,
  validate,

  async readState(ctx): Promise<LstState> {
    return getLstState(ctx);
  },

  async observe(ctx, state, agent): Promise<LstObservation> {
    return observe(ctx, state as LstState, agent);
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    return buildTxs(ctx, owner, action);
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    if (!LST) return 0;
    const deployment = LST;
    // Live marking (the coordinator's end-of-run PnL). The horizon has passed by the time this
    // runs, so only what is claimable *now* counts from the queue -- the same rule the historical
    // path applies, evaluated at the last block.
    const blockNumber = Number(await ctx.publicClient.getBlockNumber());
    const [summary, delayBlocks] = await Promise.all([
      ctx.publicClient.readContract({
        address: deployment.vault,
        abi: lstVaultAbi,
        functionName: "accountSummaryAt",
        args: [agent, BigInt(blockNumber)],
      }) as Promise<readonly bigint[]>,
      ctx.publicClient.readContract({
        address: deployment.vault,
        abi: lstVaultAbi,
        functionName: "withdrawalDelayBlocks",
      }) as Promise<bigint>,
    ]);
    const [shares, shareAssets, claimableAssets, reachableAssets] = summary;
    const instantExit =
      shares > 0n
        ? await poolQuote(ctx.publicClient, deployment, shares)
        : undefined;
    const { wei } = realizableWethWei({
      shares,
      shareAssets,
      instantExitWei: instantExit,
      claimableAssets,
      reachableAssets,
      unreachableAssets: 0n,
      blockNumber,
      horizonBlock: blockNumber,
      queueDelayBlocks: Number(delayBlocks),
    });
    return toFloat(wei) * fairPrice;
  },

  valueAtBlock(ctx) {
    if (!LST) {
      const empty: Record<string, AgentProtocolValue> = {};
      for (const a of ctx.agents)
        empty[a.id] = { valueUsdc: 0, liquidatableValueUsdc: 0, unpriced: [] };
      return (async function* () {
        return empty;
      })();
    }
    return lstValuationRun(LST, ctx);
  },

  async accountedTokens(): Promise<Address[]> {
    // The share token is valued above. The pool's LP token deliberately is not listed: nothing
    // values it yet, so leaving it out keeps an LP holding visible as an unaccounted one (#41)
    // instead of quietly excusing it.
    return LST ? [LST.lstToken] : [];
  },

  async setupWallet(_ctx, _owner): Promise<BuiltTx[]> {
    if (!LST) return [];
    return [
      approveTx(TOKENS.WETH.address, LST.vault),
      approveTx(TOKENS.WETH.address, LST.pool),
      approveTx(LST.lstToken, LST.pool),
    ];
  },
};

export const LST_PROBE_LST_WEI = PROBE_LST_WEI;
