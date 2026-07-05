// Pure logic for orderflow generation.
//
// This used to be spread across each ProtocolAdapter.buildFlow, but to carve orderflow out into an
// independent process (examples/flow/market-maker.ts) it was consolidated into pure functions that
// never touch the RPC. The coordinator still owns flow wallets and tx submission; the bot only decides
// "which orders to place".
//
// Determinism: the bot has its own Rng(flowSeed) and calls the functions here in the protocols order
// the coordinator passes (= enabledAdapters order; the default is config.ALL_PROTOCOLS's
// uniswap, balancer, curve, gmx, aave, with gmx before aave).
// To keep the RNG consumption order identical to the original buildFlowIntents, the logic is ported
// verbatim from the old adapters.
import { Rng } from "@eris/sdk/rng.js";
import type { LeafAction, ProtocolId, TokenSymbol } from "@eris/sdk/types.js";
import type { FlowKind, FlowOrder } from "@eris/sdk/protocols/types.js";
import { tokenInfo } from "@eris/sdk/markets.js";

// Decimals of the accounting quote (USDC-equivalent). Used for the digit gap in base->quote conversion.
const QUOTE_DECIMALS = tokenInfo("USDC").decimals;

const FLOW_SLIPPAGE_BPS = 100;

// Flow-related caps passed by the coordinator as strings (form after bigint restoration).
export type FlowLimits = {
  uninformedFlowMaxWethWei: bigint;
  // Number of uninformed flow orders per block per venue (default 1). >1 sends multiple independent
  // random pushes to each venue, making cross-venue divergence "emerge naturally" (hybrid α).
  uninformedFlowCountPerBlock: number;
  // Persistence in blocks of the uninformed direction (default 1). >1 makes per-venue trends produce cross-venue divergence naturally.
  uninformedFlowPersistBlocks: number;
  informedFlowMaxWethWei: bigint;
  balancerFlowMaxWethWei: bigint;
  curveFlowMaxWethWei: bigint;
  gmxFlowMaxSizeUsd: bigint;
  // Per-block probability of emitting gmx flow (0..1, default 0.5). Decided by rng each block and sent sporadically.
  gmxFlowActivityProb: number;
  // Max number of gmx orders emitted in a firing block (>=1, default 1). >1 bursts 1..N randomly.
  gmxFlowMaxBurst: number;
  aaveFlowMaxWethWei: bigint;
  maxAaveBorrowUsdcUnits: bigint;
  // Per-block probability of emitting aave flow (0..1, default 0.5). In the actor pool, each actor's per-block action probability.
  aaveFlowActivityProb: number;
  // ADR 0015 Notes / amm-challenge: informed flow's fee boundary (bps). 0=off (linear gap).
  informedArbFeeBps: number;
  // ADR 0015 Notes / amm-challenge retail: uninformed arrivals Poisson(λ) / size lognormal σ.
  // λ=0=off (fixed count + uniform).
  uninformedArrivalRate: number;
  uninformedSizeSigma: number;
  // ADR 0015 Notes: extend the above to GMX/Aave. gmxArrivalRate=0 / aaveActorSizeSigma=0 is the legacy behavior.
  gmxArrivalRate: number;
  gmxSizeSigma: number;
  aaveActorSizeSigma: number;
  defaultPriorityFeeWei: bigint;
};

// Wire form of FlowContext (JSON. bigints are strings).
export type FlowContextWire = {
  round: number;
  fairPriceUsdcPerWeth: number;
  protocols: ProtocolId[];
  poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>>;
  aaveReserves?: { wethSupplied: string; usdcBorrowed: string };
  // Multi-actor aave borrower pool (the realtime main path). The coordinator reads each actor wallet's
  // reserve and balance and passes them in. When set, use buildAaveActorsFlow; when unset, fall back to the single buildAaveFlow.
  aaveActors?: Array<{
    key: string;
    wethSupplied: string;
    usdcBorrowed: string;
    wethWei: string;
    usdcUnits: string;
  }>;
  flowBalances?: Record<string, { wethWei: string; usdcUnits: string }>;
  usdcOnlyFlow?: boolean;
  // ADR 0013 Phase 8: AMM flow per non-WETH base. Unset in a WETH-only run (off by default), in which
  // case buildFlowOrders doesn't enter the extra-base loop and consumes no RNG at all (byte-compatible).
  // Filled only when the coordinator enables WBTC, etc. If a base's max is "0", early-continue.
  extraBases?: Array<{
    base: TokenSymbol;
    // protocol -> that venue's base/USD pool price for the base. Venues that aren't available are omitted.
    poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>>;
    fairPriceUsd: number;
    // AMM flow cap in base 1e(decimals) units. "0"/unset turns off flow for that base (no RNG consumed).
    uninformedFlowMaxBaseWei?: string;
    informedFlowMaxBaseWei?: string;
    balancerFlowMaxBaseWei?: string;
    curveFlowMaxBaseWei?: string;
  }>;
  limits: {
    uninformedFlowMaxWethWei: string;
    uninformedFlowCountPerBlock?: string;
    uninformedFlowPersistBlocks?: string;
    informedFlowMaxWethWei: string;
    balancerFlowMaxWethWei: string;
    curveFlowMaxWethWei: string;
    gmxFlowMaxSizeUsd: string;
    gmxFlowActivityProb?: string;
    gmxFlowMaxBurst?: string;
    aaveFlowMaxWethWei: string;
    maxAaveBorrowUsdcUnits: string;
    aaveFlowActivityProb?: string;
    // ADR 0015 Notes / amm-challenge: informed flow's fee boundary (bps). unset/"0"=off (byte-compatible).
    informedArbFeeBps?: string;
    // ADR 0015 Notes / amm-challenge retail: uninformed arrivals Poisson(λ) / lognormal σ. unset/"0"=off.
    uninformedArrivalRate?: string;
    uninformedSizeSigma?: string;
    // ADR 0015 Notes: GMX/Aave extension. unset/"0"=off (legacy behavior).
    gmxArrivalRate?: string;
    gmxSizeSigma?: string;
    aaveActorSizeSigma?: string;
    defaultPriorityFeeWei: string;
  };
};

// A single order the bot returns (protocol-tagged. Used by the coordinator to pick a flow wallet).
export type FlowOrderOut = {
  protocol: ProtocolId;
  walletProtocol?: ProtocolId;
  // Explicit flow wallet key (e.g. "aave:actor0"). When set, pick the wallet by this key rather than
  // protocol/kind (for the multi-actor aave borrower pool. Resolved by flowOrdersToIntents).
  walletKey?: string;
  kind: FlowKind;
  action: LeafAction;
  priorityFeeWei: bigint;
};

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

type FlowBalance = { wethWei: bigint; usdcUnits: bigint };

// Clamp a probability string to [0,1] (unset/non-numeric fall back). Used for the activity gate.
function clampProb(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function randomBigInt(
  rng: Rng,
  minInclusive: bigint,
  maxInclusive: bigint,
): bigint {
  const span = maxInclusive - minInclusive + 1n;
  return (
    minInclusive +
    (BigInt(Math.floor(rng.next() * 1_000_000)) * span) / 1_000_000n
  );
}

// Scale a bigint cap by a float fraction (ppm precision). Used to reduce a lognormal size to wei
// (since uninformedMax can exceed the Number safe integer, float×bigint is computed via a fraction).
function scaleFraction(cap: bigint, fraction: number): bigint {
  const ppm = BigInt(Math.max(0, Math.round(fraction * 1_000_000)));
  return (cap * ppm) / 1_000_000n;
}

// Build a stable Rng from an actor key (same key -> same random sequence. Used for per-actor size
// draws that are invariant across blocks. It doesn't consume the shared flow rng, so it doesn't affect
// other flows' deterministic sequences).
function actorRng(key: string): Rng {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return new Rng(h >>> 0);
}

// Convert a base amount (base decimals) into quote units (USDC decimals) at price (USDC/base).
// This applies flow's base cap to the quote-side order size too, controlling both sides with the same
// intensity knob. The WETH path is (wethWei * round(price*100)) / (100 * 10^(18-6)), byte-identical to the old formula.
function baseToQuoteUnits(
  baseAmount: bigint,
  base: TokenSymbol,
  price: number,
): bigint {
  const scale = 10n ** BigInt(tokenInfo(base).decimals - QUOTE_DECIMALS);
  return (baseAmount * BigInt(Math.round(price * 100))) / (100n * scale);
}

// Backward-compatible wrapper (WETH base only). Doesn't change the values at existing call sites.
function wethToUsdcUnits(wethWei: bigint, fairPrice: number): bigint {
  return baseToQuoteUnits(wethWei, "WETH", fairPrice);
}

function flowBalance(
  ctx: FlowContextWire,
  protocol: ProtocolId,
  kind: FlowKind,
): FlowBalance | null {
  const raw = ctx.flowBalances?.[`${protocol}:${kind}`];
  if (!raw) return null;
  return {
    wethWei: BigInt(raw.wethWei),
    usdcUnits: BigInt(raw.usdcUnits),
  };
}

function capUsdc(amount: bigint, balance: FlowBalance | null): bigint {
  if (!balance) return amount;
  return amount > balance.usdcUnits ? balance.usdcUnits : amount;
}

// AMM (uniswap/balancer/curve) flow. uninformed noise + informed (pull price toward fair).
// base defaults to WETH. When base!=="WETH", use that base symbol for tokenIn and attach action.base
// so the adapter can resolve the WBTC/USDC market. The WETH path is byte-identical to before (no base
// attached, tokenIn="WETH", same wethToUsdcUnits value, unchanged RNG consumption sequence).
export function buildAmmFlow(
  rng: Rng,
  protocol: "uniswap" | "balancer" | "curve",
  poolPrice: number,
  fairPrice: number,
  uninformedMaxWethWei: bigint,
  informedMaxWethWei: bigint,
  defaultPriorityFeeWei: bigint,
  balances?: {
    uninformed?: FlowBalance | null;
    informed?: FlowBalance | null;
  },
  usdcOnlyFlow = false,
  base: TokenSymbol = "WETH",
  uninformedCount = 1,
  round = 0,
  persistBlocks = 1,
  // ADR 0015 Notes / amm-challenge: have informed (arbitrage) flow fill "only the gap beyond the fee band".
  // 0 (default) = the old linear gap (disabled. byte-compatible). >0 is fee-aware:
  //   - |gap| <= feeBps is a no-arb band and is skipped (arb isn't profitable, so don't over-tighten the market)
  //   - beyond that, close only the excess past the fee band (residual = fee. same as real arbitrage)
  // Our venues are Uniswap v3 / weighted / crypto, not pure CPMM, so we port only the "fee-boundary
  // economics" rather than closed-form coefficients (depth uses the existing informedMax as a proxy).
  informedArbFeeBps = 0,
  // ADR 0015 Notes / amm-challenge retail: make uninformed arrivals Poisson(λ) and sizes lognormal.
  // arrivalRate=0 (default) = the old fixed count (uninformedCount) + uniform size (byte-compatible).
  // >0 makes the per-block count Poisson(λ) and each size lognormal (mean = uninformedMax×0.5, σ=sizeSigma).
  uninformedArrivalRate = 0,
  uninformedSizeSigma = 1,
): FlowOrder[] {
  const orders: FlowOrder[] = [];
  const swapType =
    protocol === "uniswap"
      ? "swap"
      : protocol === "balancer"
        ? "balancerSwap"
        : "curveSwap";
  // The WETH path doesn't attach action.base (same shape as the old output). Only WBTC, etc. attach base.
  const baseField = base === "WETH" ? {} : { base };

  // uninformed: push the pool away from fair to create a gap (bait for arbitrage). Use a random amount
  // equivalent to the same base for both base/USDC, so uninformedMaxWethWei controls both sides uniformly.
  // When uninformedCount>1, send multiple independent pushes (differing direction/size), so how hard each
  // venue is pushed varies -> cross-venue divergence "emerges naturally" (hybrid α).
  // At count=1, RNG consumption and output are byte-identical to before (backward-compatible).
  // persistBlocks>1: persist each venue's uninformed direction for persistBlocks blocks
  // (a deterministic trend windowed by round/persistBlocks). This mimics a run of same-direction bias =
  // order-flow imbalance, and with a different trend per venue divergence "emerges naturally" (realistic α
  // without artificial spread injection).
  // persistBlocks<=1 is the old behavior that consumes rng.bool() = byte-compatible.
  let trendTokenIn: TokenSymbol | null = null;
  if (persistBlocks > 1) {
    const window = Math.floor(round / persistBlocks);
    let h = ((window + 1) * 0x9e3779b1) >>> 0;
    for (let c = 0; c < protocol.length; c++)
      h = ((h ^ protocol.charCodeAt(c)) * 0x01000193) >>> 0;
    // USDC in=buy (price up) / base in=sell (price down). venue×window splits up/down and creates a spread.
    trendTokenIn = h % 2 === 0 ? "USDC" : base;
  }
  // Poisson mode (arrivalRate>0): draw the per-block arrival count as Poisson(λ) (0-count blocks arise naturally).
  // Legacy mode (arrivalRate=0): fixed count max(1, uninformedCount). RNG consumption is as before (byte-compatible).
  const arrivals =
    uninformedArrivalRate > 0
      ? rng.poisson(uninformedArrivalRate)
      : Math.max(1, uninformedCount);
  for (let u = 0; u < arrivals; u++) {
    let uninformedTokenIn: TokenSymbol =
      trendTokenIn ?? (rng.bool() ? base : "USDC");
    // Poisson mode makes size lognormal (heavy-tailed = occasionally large). Mean = uninformedMax×0.5,
    // about the same level as the old uniform (mean ~52.5%). Outliers are clamped to [2%, 300%] so the pool isn't broken.
    const uninformedWethEquiv =
      uninformedArrivalRate > 0
        ? scaleFraction(
            uninformedMaxWethWei,
            Math.min(
              3,
              Math.max(0.02, rng.lognormal(0.5, uninformedSizeSigma)),
            ),
          )
        : randomBigInt(rng, uninformedMaxWethWei / 20n, uninformedMaxWethWei);
    if (
      uninformedTokenIn === base &&
      (usdcOnlyFlow ||
        (balances?.uninformed &&
          balances.uninformed.wethWei < uninformedWethEquiv))
    ) {
      uninformedTokenIn = "USDC";
    }
    const uninformedAmount =
      uninformedTokenIn === base
        ? uninformedWethEquiv
        : capUsdc(
            baseToQuoteUnits(uninformedWethEquiv, base, fairPrice),
            balances?.uninformed ?? null,
          );
    const uninformedFee =
      defaultPriorityFeeWei + BigInt(rng.int(1, 50)) * 1_000_000n;
    if (uninformedAmount > 0n) {
      orders.push({
        kind: "uninformed",
        action: {
          type: swapType,
          tokenIn: uninformedTokenIn,
          amountIn: uninformedAmount.toString(),
          slippageBps: FLOW_SLIPPAGE_BPS,
          ...baseField,
        } as LeafAction,
        priorityFeeWei: uninformedFee,
      });
    }
  }

  // informed: pull the pool price toward fairPrice (the gap-closing side = competes with arb agents).
  // Align both sides at informedMaxWethWei × gap, and control the USDC side by the base cap too.
  // Lowering informedMaxWethWei makes the flow bot close the gap less, increasing the arb's take.
  // fee-aware (informedArbFeeBps>0): if |gap| is within the fee band, arbitrage is unprofitable so don't
  // emit informed; beyond it, close only the excess past the fee band (residual = fee. same economics as amm-challenge arb).
  const rawDeviation = Math.abs(fairPrice / poolPrice - 1);
  if (informedArbFeeBps > 0 && rawDeviation * 10_000 <= informedArbFeeBps) {
    return orders; // no-arb band: don't over-tighten the market (leave the arb agent's take)
  }
  const effectiveDeviation =
    informedArbFeeBps > 0
      ? Math.max(0, rawDeviation - informedArbFeeBps / 10_000)
      : rawDeviation;
  let informedTokenIn: TokenSymbol = poolPrice < fairPrice ? "USDC" : base;
  const gap = Math.min(1, effectiveDeviation * 20);
  const informedWethEquiv =
    (informedMaxWethWei * BigInt(Math.max(1, Math.floor(gap * 100)))) / 100n;
  if (
    informedTokenIn === base &&
    (usdcOnlyFlow ||
      (balances?.informed && balances.informed.wethWei < informedWethEquiv))
  ) {
    // USDC-only runs start flow wallets with no base token. Buy base first so a later
    // sell-side informed flow can use the same wallet instead of reverting.
    informedTokenIn = "USDC";
  }
  const informedAmount =
    informedTokenIn === base
      ? informedWethEquiv
      : capUsdc(
          baseToQuoteUnits(informedWethEquiv, base, fairPrice),
          balances?.informed ?? null,
        );
  const informedFee =
    defaultPriorityFeeWei + BigInt(rng.int(50, 100)) * 1_000_000n;
  if (informedAmount > 0n) {
    orders.push({
      kind: "informed",
      action: {
        type: swapType,
        tokenIn: informedTokenIn,
        amountIn: informedAmount.toString(),
        slippageBps: FLOW_SLIPPAGE_BPS,
        ...baseField,
      } as LeafAction,
      priorityFeeWei: informedFee,
    });
  }

  return orders;
}

// GMX perp orderflow: open small longs/shorts to create fill volume (executed by the keeper).
// ADR 0015 Notes / amm-challenge retail: with arrivalRate>0, make the per-block count Poisson(λ) and
// size lognormal (heavy-tailed = occasionally large positions) (realistic perp flow).
// arrivalRate=0 is the old Bernoulli(activityProb) + uniform burst + uniform size (byte-compatible).
export function buildGmxFlow(
  rng: Rng,
  gmxFlowMaxSizeUsd: bigint,
  defaultPriorityFeeWei: bigint,
  fairPrice: number,
  balance?: FlowBalance | null,
  canPrepareWeth = false,
  activityProb = 0.5,
  maxBurst = 1,
  arrivalRate = 0,
  sizeSigma = 1,
): FlowOrderOut[] {
  // Count: Poisson mode (arrivalRate>0) uses poisson(λ) (0-count blocks arise naturally).
  // Legacy mode is a Bernoulli(activityProb) gate -> a uniform burst of 1..maxBurst (byte-compatible).
  let burst: number;
  if (arrivalRate > 0) {
    burst = rng.poisson(arrivalRate);
    if (burst <= 0) return [];
  } else {
    if (rng.next() >= activityProb) return [];
    burst = maxBurst <= 1 ? 1 : rng.int(1, maxBurst + 1);
  }
  const orders: FlowOrderOut[] = [];
  for (let i = 0; i < burst; i++) {
    const isLong = rng.bool();
    // size: Poisson mode is lognormal (mean = gmxMax×0.025 = the median of the old uniform. clamped to [0.5%, 10%]).
    // Legacy mode is uniform over gmxMax's 1/100..1/25 (baseline 1/50. about 2x leverage, so collateral = size/2x).
    const sizeUsd =
      arrivalRate > 0
        ? scaleFraction(
            gmxFlowMaxSizeUsd,
            Math.min(0.1, Math.max(0.005, rng.lognormal(0.025, sizeSigma))),
          )
        : randomBigInt(rng, gmxFlowMaxSizeUsd / 100n, gmxFlowMaxSizeUsd / 25n);
    // collateral (WETH wei) ≈ (sizeUsd/2) converted USD->WETH. oraclePrices aren't available, so divide by an approximate fairPrice-equivalent
    const sizeUsdNum = Number(sizeUsd) / 1e30;
    const collateralWei = BigInt(
      Math.max(1, Math.floor(((sizeUsdNum / 2) * 1e18) / 2100)),
    );
    const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 60)) * 1_000_000n;
    if (
      balance &&
      balance.wethWei < collateralWei * (canPrepareWeth ? 2n : 1n)
    ) {
      if (!canPrepareWeth) break;
      const usdcIn = capUsdc(
        wethToUsdcUnits(collateralWei, fairPrice),
        balance,
      );
      if (usdcIn <= 0n) break;
      // On a block with no WETH inventory, prepare just one USDC->WETH for collateral and stop (open next block).
      orders.push({
        protocol: "uniswap",
        walletProtocol: "gmx",
        kind: "uninformed",
        action: {
          type: "swap",
          tokenIn: "USDC",
          amountIn: usdcIn.toString(),
          slippageBps: FLOW_SLIPPAGE_BPS,
        } as LeafAction,
        priorityFeeWei: fee,
      });
      break;
    }
    const action = {
      type: "gmxIncrease",
      isLong,
      collateral: "WETH",
      collateralAmount: collateralWei.toString(),
      sizeDeltaUsd: sizeUsd.toString(),
    } as unknown as LeafAction;
    orders.push({
      protocol: "gmx",
      kind: "uninformed",
      action,
      priorityFeeWei: fee,
    });
  }
  return orders;
}

// Aave (single-wallet simple churn. Backward-compatible / fallback when aaveActors is unset).
// Advance the state machine one step: supply -> (repeat borrow <-> repay) -> when debt is 0, withdraw with some probability.
// The realtime main path uses buildAaveActorsFlow (multi-actor persistent positions).
export function buildAaveFlow(
  rng: Rng,
  aaveFlowMaxWethWei: bigint,
  maxAaveBorrowUsdcUnits: bigint,
  defaultPriorityFeeWei: bigint,
  reserves: { wethSupplied: bigint; usdcBorrowed: bigint },
  fairPrice: number,
  balance?: FlowBalance | null,
  canPrepareWeth = false,
  activityProb = 0.5,
): FlowOrderOut[] {
  // Send in this block only with probability activityProb (default 0.5. 1 = churn every block, <1 = intermittent).
  if (rng.next() >= activityProb) return [];
  const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 40)) * 1_000_000n;
  let action: LeafAction;
  if (reserves.wethSupplied === 0n) {
    // supply amount is random over max's 1/4..3/4 (baseline 1/2).
    const amount = randomBigInt(
      rng,
      aaveFlowMaxWethWei / 4n,
      (aaveFlowMaxWethWei * 3n) / 4n,
    );
    if (balance && balance.wethWei < amount * (canPrepareWeth ? 2n : 1n)) {
      if (!canPrepareWeth) return [];
      const usdcIn = capUsdc(wethToUsdcUnits(amount, fairPrice), balance);
      if (usdcIn <= 0n) return [];
      return [
        {
          protocol: "uniswap",
          walletProtocol: "aave",
          kind: "informed",
          action: {
            type: "swap",
            tokenIn: "USDC",
            amountIn: usdcIn.toString(),
            slippageBps: FLOW_SLIPPAGE_BPS,
          } as LeafAction,
          priorityFeeWei: fee,
        },
      ];
    }
    action = {
      type: "aaveSupply",
      asset: "WETH",
      amount: amount.toString(),
    } as unknown as LeafAction;
  } else if (reserves.usdcBorrowed > 0n) {
    action = {
      type: "aaveRepay",
      asset: "USDC",
      amount: "max",
    } as unknown as LeafAction;
  } else if (rng.bool()) {
    const amount = randomBigInt(
      rng,
      maxAaveBorrowUsdcUnits / 10n,
      (maxAaveBorrowUsdcUnits * 3n) / 10n,
    );
    action = {
      type: "aaveBorrow",
      asset: "USDC",
      amount: (amount > 0n ? amount : 100_000_000n).toString(),
    } as unknown as LeafAction;
  } else {
    action = {
      type: "aaveWithdraw",
      asset: "WETH",
      amount: "max",
    } as unknown as LeafAction;
  }
  return [{ protocol: "aave", kind: "informed", action, priorityFeeWei: fee }];
}

// One actor's persistent position state (the coordinator reads it from each actor wallet and passes it in).
export type AaveActorState = {
  key: string; // flow wallet key (e.g. "aave:actor0")
  wethSupplied: bigint; // WETH this actor has supplied to Aave
  usdcBorrowed: bigint; // this actor's USDC debt (persistent. remains into the next block)
  wethWei: bigint; // the wallet's WETH balance (source for topping up collateral)
  usdcUnits: bigint; // the wallet's USDC balance (grows via borrow, source for repay)
};

// Aave borrower pool (closer to a real market). N independent actors each keep their own persistent
// position and, each block, independently decide by probability to execute exactly one of
// borrow/repay/supply/withdraw. There's no forced repay after a borrow, so debt persists into later
// blocks. Multiple borrows in one block arise naturally from different actors (max = actor count).
// Each borrow stays within HF headroom (collateral × LTV × safety factor) to avoid revert.
export function buildAaveActorsFlow(
  rng: Rng,
  actors: AaveActorState[],
  aaveFlowMaxWethWei: bigint,
  maxAaveBorrowUsdcUnits: bigint,
  defaultPriorityFeeWei: bigint,
  fairPrice: number,
  activityProb: number,
  // ADR 0015 Notes / amm-challenge retail: >0 makes each actor's target collateral heterogeneous via
  // lognormal (a mix of whales/minnows). 0 makes all actors uniform = aaveFlowMaxWethWei (legacy).
  // Borrows track 30% LTV of each actor's collateral, so HF safety is unchanged (only size gets heavy-tailed).
  actorSizeSigma = 0,
): FlowOrderOut[] {
  // Target-leverage approach (suppresses staleness-driven reverts). The flow bot decides on actor state
  // 1-2 blocks stale (async pipeline), so give large HF/balance headroom to stay "safe even on slightly old state":
  //   - Build collateral up to target only once, then don't supply again (avoids thrashing the supply cap).
  //   - Target debt at 30% of collateral value (large headroom to LT 0.84), and borrow small amounts only
  //     while leaving room for 2 steps (a stale double-borrow won't breach HF). Once reached, repay part.
  const TARGET_LTV_NUM = 30n;
  const TARGET_LTV_DEN = 100n;
  const minStep = maxAaveBorrowUsdcUnits / 25n; // don't move a difference below this (avoids fractional loops)
  const orders: FlowOrderOut[] = [];
  for (const actor of actors) {
    // Each actor independently decides "act this block?" (intermittent).
    if (rng.next() >= activityProb) continue;
    // Target collateral: if actorSizeSigma>0, make it heterogeneous per actor via a key-derived lognormal (whale/minnow).
    // Seeded by key, so stable across blocks (doesn't thrash supply). If 0, uniform = aaveFlowMaxWethWei.
    const targetCollateralWei =
      actorSizeSigma > 0
        ? scaleFraction(
            aaveFlowMaxWethWei,
            Math.min(
              3,
              Math.max(0.1, actorRng(actor.key).lognormal(1, actorSizeSigma)),
            ),
          )
        : aaveFlowMaxWethWei;
    const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 40)) * 1_000_000n;
    const pushAave = (action: LeafAction): void => {
      orders.push({
        protocol: "aave",
        walletKey: actor.key,
        kind: "informed",
        action,
        priorityFeeWei: fee,
      });
    };

    // 1) Build collateral up to target only once (treat reaching 80% as established and stop supplying).
    if (actor.wethSupplied < (targetCollateralWei * 8n) / 10n) {
      const want = targetCollateralWei - actor.wethSupplied;
      // Guard against stale balances by capping at 70% of wallet WETH.
      const amount = minBI(want, (actor.wethWei * 7n) / 10n);
      if (amount > 0n)
        pushAave({
          type: "aaveSupply",
          asset: "WETH",
          amount: amount.toString(),
        } as unknown as LeafAction);
      continue;
    }

    // 2) After collateral is established, only borrow/repay (persistent debt. no more supply).
    const collateralValueUsdc = wethToUsdcUnits(actor.wethSupplied, fairPrice);
    const targetDebt = (collateralValueUsdc * TARGET_LTV_NUM) / TARGET_LTV_DEN;
    const r = rng.next();

    if (actor.usdcBorrowed + 2n * minStep < targetDebt && r < 0.55) {
      // Borrow a bit more toward the target debt (leave room for 2 steps = HF-safe even on a stale double-borrow).
      const room = targetDebt - actor.usdcBorrowed;
      const want = randomBigInt(
        rng,
        maxAaveBorrowUsdcUnits / 20n,
        maxAaveBorrowUsdcUnits / 10n,
      );
      const amount = minBI(want, room);
      if (amount > 0n)
        pushAave({
          type: "aaveBorrow",
          asset: "USDC",
          amount: amount.toString(),
        } as unknown as LeafAction);
    } else if (actor.usdcBorrowed > minStep && r < 0.9) {
      // Partial repay (a partial amount, not max -> debt remains). Repay up to the smaller of wallet USDC balance and debt.
      const want = randomBigInt(
        rng,
        actor.usdcBorrowed / 4n,
        actor.usdcBorrowed / 2n,
      );
      const amount = minBI(want, actor.usdcUnits);
      if (amount > 0n)
        pushAave({
          type: "aaveRepay",
          asset: "USDC",
          amount: amount.toString(),
        } as unknown as LeafAction);
    }
    // Otherwise no-op (with collateral established and debt near target, some blocks do nothing = natural).
  }
  return orders;
}

// Restore the wire's string limits into bigint.
export function decodeFlowLimits(wire: FlowContextWire["limits"]): FlowLimits {
  return {
    uninformedFlowMaxWethWei: BigInt(wire.uninformedFlowMaxWethWei),
    uninformedFlowCountPerBlock: Math.max(
      1,
      Number(wire.uninformedFlowCountPerBlock ?? "1"),
    ),
    uninformedFlowPersistBlocks: Math.max(
      1,
      Number(wire.uninformedFlowPersistBlocks ?? "1"),
    ),
    informedFlowMaxWethWei: BigInt(wire.informedFlowMaxWethWei),
    balancerFlowMaxWethWei: BigInt(wire.balancerFlowMaxWethWei),
    curveFlowMaxWethWei: BigInt(wire.curveFlowMaxWethWei),
    gmxFlowMaxSizeUsd: BigInt(wire.gmxFlowMaxSizeUsd),
    gmxFlowActivityProb: clampProb(wire.gmxFlowActivityProb, 0.5),
    gmxFlowMaxBurst: Math.max(1, Number(wire.gmxFlowMaxBurst ?? "1")),
    aaveFlowMaxWethWei: BigInt(wire.aaveFlowMaxWethWei),
    maxAaveBorrowUsdcUnits: BigInt(wire.maxAaveBorrowUsdcUnits),
    aaveFlowActivityProb: clampProb(wire.aaveFlowActivityProb, 0.5),
    informedArbFeeBps: Math.max(0, Number(wire.informedArbFeeBps ?? "0")),
    uninformedArrivalRate: Math.max(
      0,
      Number(wire.uninformedArrivalRate ?? "0"),
    ),
    uninformedSizeSigma: Math.max(0, Number(wire.uninformedSizeSigma ?? "1")),
    gmxArrivalRate: Math.max(0, Number(wire.gmxArrivalRate ?? "0")),
    gmxSizeSigma: Math.max(0, Number(wire.gmxSizeSigma ?? "1")),
    aaveActorSizeSigma: Math.max(0, Number(wire.aaveActorSizeSigma ?? "0")),
    defaultPriorityFeeWei: BigInt(wire.defaultPriorityFeeWei),
  };
}

// Generate all orders for one round from the FlowContext.
// Iterate protocols in the order the coordinator passes (default uniswap, balancer, curve, gmx, aave), consuming RNG in that order.
export function buildFlowOrders(
  rng: Rng,
  ctx: FlowContextWire,
): FlowOrderOut[] {
  const limits = decodeFlowLimits(ctx.limits);
  const out: FlowOrderOut[] = [];
  const tag = (protocol: ProtocolId, orders: FlowOrder[]): void => {
    for (const o of orders) out.push({ protocol, ...o });
  };

  // [uninformedMax, informedMax] per AMM (uniswap/balancer/curve).
  // balancer/curve use a single cap for both.
  const ammMax: Record<"uniswap" | "balancer" | "curve", [bigint, bigint]> = {
    uniswap: [limits.uninformedFlowMaxWethWei, limits.informedFlowMaxWethWei],
    balancer: [limits.balancerFlowMaxWethWei, limits.balancerFlowMaxWethWei],
    curve: [limits.curveFlowMaxWethWei, limits.curveFlowMaxWethWei],
  };

  for (const protocol of ctx.protocols) {
    if (
      protocol === "uniswap" ||
      protocol === "balancer" ||
      protocol === "curve"
    ) {
      const [uninformedMax, informedMax] = ammMax[protocol];
      tag(
        protocol,
        buildAmmFlow(
          rng,
          protocol,
          ctx.poolPrices[protocol] ?? ctx.fairPriceUsdcPerWeth,
          ctx.fairPriceUsdcPerWeth,
          uninformedMax,
          informedMax,
          limits.defaultPriorityFeeWei,
          {
            uninformed: flowBalance(ctx, protocol, "uninformed"),
            informed: flowBalance(ctx, protocol, "informed"),
          },
          ctx.usdcOnlyFlow === true,
          "WETH",
          limits.uninformedFlowCountPerBlock,
          ctx.round,
          limits.uninformedFlowPersistBlocks,
          limits.informedArbFeeBps,
          limits.uninformedArrivalRate,
          limits.uninformedSizeSigma,
        ),
      );
    } else if (protocol === "aave") {
      if (ctx.aaveActors && ctx.aaveActors.length > 0) {
        // Realtime main path: multi-actor persistent-position borrower pool.
        out.push(
          ...buildAaveActorsFlow(
            rng,
            ctx.aaveActors.map((a) => ({
              key: a.key,
              wethSupplied: BigInt(a.wethSupplied),
              usdcBorrowed: BigInt(a.usdcBorrowed),
              wethWei: BigInt(a.wethWei),
              usdcUnits: BigInt(a.usdcUnits),
            })),
            limits.aaveFlowMaxWethWei,
            limits.maxAaveBorrowUsdcUnits,
            limits.defaultPriorityFeeWei,
            ctx.fairPriceUsdcPerWeth,
            limits.aaveFlowActivityProb,
            limits.aaveActorSizeSigma,
          ),
        );
      } else {
        // Backward-compatible: single-wallet simple churn.
        out.push(
          ...buildAaveFlow(
            rng,
            limits.aaveFlowMaxWethWei,
            limits.maxAaveBorrowUsdcUnits,
            limits.defaultPriorityFeeWei,
            {
              wethSupplied: BigInt(ctx.aaveReserves?.wethSupplied ?? "0"),
              usdcBorrowed: BigInt(ctx.aaveReserves?.usdcBorrowed ?? "0"),
            },
            ctx.fairPriceUsdcPerWeth,
            flowBalance(ctx, "aave", "informed"),
            ctx.protocols.includes("uniswap"),
            limits.aaveFlowActivityProb,
          ),
        );
      }
    } else if (protocol === "gmx") {
      out.push(
        ...buildGmxFlow(
          rng,
          limits.gmxFlowMaxSizeUsd,
          limits.defaultPriorityFeeWei,
          ctx.fairPriceUsdcPerWeth,
          flowBalance(ctx, "gmx", "uninformed"),
          ctx.protocols.includes("uniswap"),
          limits.gmxFlowActivityProb,
          limits.gmxFlowMaxBurst,
          limits.gmxArrivalRate,
          limits.gmxSizeSigma,
        ),
      );
    }
  }

  // ADR 0013 Phase 8: AMM flow for non-WETH bases (WBTC, etc.). Placed after WETH is fully processed
  // above. If ctx.extraBases is unset (WETH-only run), zero iterations = no RNG consumed = byte-compatible.
  // For each base × venue, early-continue if max=0/unset and consume no RNG for that base/venue
  // (with WBTC off by default, the WETH-only RNG consumption sequence and output are unchanged).
  for (const extra of ctx.extraBases ?? []) {
    const extraMax: Record<"uniswap" | "balancer" | "curve", bigint> = {
      uniswap: BigInt(extra.uninformedFlowMaxBaseWei ?? "0"),
      balancer: BigInt(extra.balancerFlowMaxBaseWei ?? "0"),
      curve: BigInt(extra.curveFlowMaxBaseWei ?? "0"),
    };
    const informedMax = BigInt(extra.informedFlowMaxBaseWei ?? "0");
    for (const protocol of ctx.protocols) {
      if (
        protocol !== "uniswap" &&
        protocol !== "balancer" &&
        protocol !== "curve"
      )
        continue;
      const uninformedMax = extraMax[protocol];
      // If off (both uninformed and informed caps are 0), skip without consuming any RNG.
      const venueInformedMax =
        protocol === "uniswap" ? informedMax : extraMax[protocol];
      if (uninformedMax <= 0n && venueInformedMax <= 0n) continue;
      const poolPrice = extra.poolPrices[protocol];
      if (poolPrice === undefined || poolPrice <= 0) continue;
      tag(
        protocol,
        buildAmmFlow(
          rng,
          protocol,
          poolPrice,
          extra.fairPriceUsd,
          uninformedMax,
          venueInformedMax,
          limits.defaultPriorityFeeWei,
          {
            uninformed: flowBalance(ctx, protocol, "uninformed"),
            informed: flowBalance(ctx, protocol, "informed"),
          },
          ctx.usdcOnlyFlow === true,
          extra.base,
          limits.uninformedFlowCountPerBlock,
          ctx.round,
          limits.uninformedFlowPersistBlocks,
          limits.informedArbFeeBps,
          limits.uninformedArrivalRate,
          limits.uninformedSizeSigma,
        ),
      );
    }
  }

  return out;
}
