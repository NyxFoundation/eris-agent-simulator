import type { AgentAction, AgentObservation } from "@eris/sdk";

// The normalized flat shape the existing logic assumes (top-level pool / positions).
// AgentObservation is nested (protocols.uniswap.pool / .positions), so we project it inside decide.
type Observation = {
  pool: {
    priceUsdcPerWeth: number;
    tick: number;
    tickSpacing: number;
  };
  fairPriceUsdcPerWeth: number;
  balances: {
    wethWei: string;
    usdcUnits: string;
  };
  positions: Array<{
    tokenId: string;
    tickLower: number;
    tickUpper: number;
    liquidity: string;
    tokensOwedWethWei: string;
    tokensOwedUsdcUnits: string;
  }>;
  limits: {
    defaultPriorityFeePerGasWei: string;
    maxLpWethWei: string;
    maxLpUsdcUnits: string;
    maxOpenPositions: number;
    // Per-round cap on USDC spent in one swap. Bounds how fast inventory can be acquired.
    maxUsdcInUnits: string;
  };
};

const RANGE_WIDTH_MULTIPLIER = 60;
const EDGE_BUFFER_MULTIPLIER = 8;
const MINT_BUDGET_BPS = 3500;
const MIN_WETH_MINT_WEI = 10_000_000_000_000_000n;
const MIN_USDC_MINT_UNITS = 25_000_000n;

export function decide(obs: AgentObservation): AgentAction | null {
  // Normalize the new schema (protocols.uniswap) into the old flat shape to reuse the existing logic
  const uni = obs.protocols.uniswap;
  if (!uni) return { type: "noop", reason: "uniswap unavailable" };
  const observation = {
    ...obs,
    pool: uni.pool,
    positions: uni.positions,
  } as unknown as Observation;
  return decideAction(observation);
}

function decideAction(observation: Observation): AgentAction {
  const priorityFee = observation.limits.defaultPriorityFeePerGasWei;
  const managedPosition = observation.positions.find(
    (position) => BigInt(position.liquidity) > 0n,
  );
  if (managedPosition) {
    if (shouldRebalance(observation, managedPosition)) {
      return {
        type: "bundle",
        maxPriorityFeePerGasWei: priorityFee,
        actions: [
          {
            type: "removeLiquidity",
            tokenId: managedPosition.tokenId,
            liquidity: managedPosition.liquidity,
          },
          {
            type: "collectFees",
            tokenId: managedPosition.tokenId,
          },
        ],
      };
    }

    if (hasCollectableFees(managedPosition)) {
      return {
        type: "collectFees",
        tokenId: managedPosition.tokenId,
        maxPriorityFeePerGasWei: priorityFee,
      };
    }

    return { type: "noop", reason: "LP position is in range" };
  }

  const collectOnly = observation.positions.find((position) =>
    hasCollectableFees(position),
  );
  if (collectOnly) {
    return {
      type: "collectFees",
      tokenId: collectOnly.tokenId,
      maxPriorityFeePerGasWei: priorityFee,
    };
  }

  if (observation.positions.length >= observation.limits.maxOpenPositions) {
    return { type: "noop", reason: "max open LP positions reached" };
  }

  const amountWethDesired = budgetAmount(
    BigInt(observation.balances.wethWei),
    BigInt(observation.limits.maxLpWethWei),
  );
  const amountUsdcDesired = budgetAmount(
    BigInt(observation.balances.usdcUnits),
    BigInt(observation.limits.maxLpUsdcUnits),
  );
  if (
    amountWethDesired < MIN_WETH_MINT_WEI ||
    amountUsdcDesired < MIN_USDC_MINT_UNITS
  ) {
    return acquireInventory(observation, priorityFee);
  }

  const { tickLower, tickUpper } = chooseRange(observation);
  return {
    type: "mintLiquidity",
    tickLower,
    tickUpper,
    amountWethDesired: amountWethDesired.toString(),
    amountUsdcDesired: amountUsdcDesired.toString(),
    maxPriorityFeePerGasWei: priorityFee,
    slippageBps: 100,
  };
}

// A two-sided LP position needs both legs, and the competition funds USDC only -- nobody is handed
// WETH (ADR 0019 §6). Being handed inventory and buying it are not the same thing: handed inventory
// is beta nobody chose and it cancels out of every score because the benchmark holds it too, while
// bought inventory costs the spread and then sits in this agent's own risk against a cash benchmark.
// So acquiring it is a decision the strategy makes, not something the funding rule does for it.
//
// It is deliberately made only when the position is about to be opened. WETH held outside a range
// earns nothing and is pure variance, so buying early or buying more than the mint can use is a
// straight loss under `mean - lambda*std`.
function acquireInventory(
  observation: Observation,
  priorityFee: string,
): AgentAction {
  const wethBalance = BigInt(observation.balances.wethWei);
  const usdcBalance = BigInt(observation.balances.usdcUnits);
  // Enough WETH for the WETH leg to match a full-size USDC leg. Not more.
  const targetWethWei = weiForUsdc(
    observation,
    BigInt(observation.limits.maxLpUsdcUnits),
  );
  if (wethBalance >= targetWethWei) {
    // Holding the inventory and still unable to mint means the USDC side is what is short.
    return { type: "noop", reason: "insufficient LP budget" };
  }
  const shortfallUsdc = usdcForWeth(observation, targetWethWei - wethBalance);
  const spend = minBig(
    minBig(shortfallUsdc, BigInt(observation.limits.maxUsdcInUnits)),
    // Keep the other leg fundable: spending everything on WETH would just move the shortage.
    usdcBalance / 2n,
  );
  if (spend < MIN_USDC_MINT_UNITS) {
    return { type: "noop", reason: "not enough USDC to buy LP inventory" };
  }
  return {
    type: "swap",
    tokenIn: "USDC",
    amountIn: spend.toString(),
    maxPriorityFeePerGasWei: priorityFee,
    slippageBps: 100,
  };
}

// USDC units (6 decimals) per 1 WETH, as an integer so the conversions stay in BigInt.
function priceUnits(observation: Observation): bigint {
  return BigInt(
    Math.max(1, Math.round(observation.pool.priceUsdcPerWeth * 1e6)),
  );
}

function usdcForWeth(observation: Observation, wei: bigint): bigint {
  return (wei * priceUnits(observation)) / 10n ** 18n;
}

function weiForUsdc(observation: Observation, units: bigint): bigint {
  return (units * 10n ** 18n) / priceUnits(observation);
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function shouldRebalance(
  observation: Observation,
  position: Observation["positions"][number],
): boolean {
  const buffer = observation.pool.tickSpacing * EDGE_BUFFER_MULTIPLIER;
  return (
    observation.pool.tick <= position.tickLower + buffer ||
    observation.pool.tick >= position.tickUpper - buffer
  );
}

function hasCollectableFees(
  position: Pick<
    Observation["positions"][number],
    "tokensOwedWethWei" | "tokensOwedUsdcUnits"
  >,
): boolean {
  return (
    BigInt(position.tokensOwedWethWei) > 0n ||
    BigInt(position.tokensOwedUsdcUnits) > 0n
  );
}

function budgetAmount(balance: bigint, limit: bigint): bigint {
  const capped = balance < limit ? balance : limit;
  return (capped * BigInt(MINT_BUDGET_BPS)) / 10_000n;
}

function chooseRange(observation: Observation): {
  tickLower: number;
  tickUpper: number;
} {
  const spacing = observation.pool.tickSpacing;
  const halfWidth = spacing * RANGE_WIDTH_MULTIPLIER;
  const fairGap =
    observation.fairPriceUsdcPerWeth / observation.pool.priceUsdcPerWeth - 1;
  const rawShift = Math.trunc(fairGap * halfWidth * 4);
  const boundedShift = clamp(
    rawShift,
    -Math.trunc(halfWidth / 2),
    Math.trunc(halfWidth / 2),
  );
  const center = alignTick(observation.pool.tick + boundedShift, spacing);
  return {
    tickLower: center - halfWidth,
    tickUpper: center + halfWidth,
  };
}

function alignTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
