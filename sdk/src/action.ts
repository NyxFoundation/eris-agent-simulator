import type { Address } from "viem";
import type {
  AgentAction,
  AgentObservation,
  BalanceSnapshot,
  BundleActionItem,
  LeafAction,
  ProtocolId,
  RawTx,
} from "./types.js";
import {
  adapterForAction,
  enabledAdapters,
  getAdapter,
} from "./protocols/registry.js";
import { kindOf, tokenInfo } from "./markets.js";

export type ValidatedIntent = {
  action: LeafAction;
  protocol: ProtocolId;
  priorityFeeWei: bigint;
  bundleId?: string;
  bundleIndex?: number;
};
export type ValidatedRawIntent = {
  tx: RawTx;
  priorityFeeWei: bigint;
  bundleId?: string;
  bundleIndex?: number;
};

export type ActionValidation =
  | {
      ok: true;
      action: { type: "noop"; reason?: string };
      intents: [];
      rawIntents: [];
      priorityFeeWei: 0n;
      slippageBps: 0;
    }
  | {
      ok: true;
      action: AgentAction;
      intents: ValidatedIntent[];
      rawIntents: ValidatedRawIntent[];
    }
  | { ok: false; reason: string };

const DECIMAL_INTEGER = /^[0-9]+$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export function parseAction(raw: unknown): AgentAction {
  if (!raw || typeof raw !== "object")
    throw new Error("action must be an object");
  const obj = raw as Record<string, unknown>;
  if (obj.type === "noop") {
    return {
      type: "noop",
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
    };
  }
  if (obj.type === "bundle") return parseBundleAction(obj);
  if (obj.type === "rawTx") return parseRawTxAction(obj);
  if (obj.type === "rawBundle") return parseRawBundleAction(obj);
  return parseLeafAction(obj);
}

// Try each adapter's parse in order and take the first non-null result.
function parseLeafAction(obj: Record<string, unknown>): LeafAction {
  for (const adapter of enabledAdapters()) {
    const parsed = adapter.parse(obj);
    if (parsed) return parsed;
  }
  throw new Error(`unknown or disabled action type: ${String(obj.type)}`);
}

function parseBundleAction(obj: Record<string, unknown>): AgentAction {
  if (!Array.isArray(obj.actions))
    throw new Error("bundle actions must be an array");
  const action: Extract<AgentAction, { type: "bundle" }> = {
    type: "bundle",
    actions: obj.actions.map((item) => {
      if (!item || typeof item !== "object")
        throw new Error("bundle action must be an object");
      const itemType = (item as Record<string, unknown>).type;
      if (itemType === "noop") throw new Error("bundle cannot contain noop");
      if (itemType === "bundle")
        throw new Error("bundle cannot contain nested bundle");
      const parsed = parseLeafAction(item as Record<string, unknown>);
      const adapter = adapterForAction(parsed);
      if (!adapter.bundleable(parsed))
        throw new Error(`action type ${itemType} cannot be bundled`);
      return parsed as BundleActionItem;
    }),
  };
  addPriorityFee(action, obj);
  return action;
}

function parseRawTxAction(obj: Record<string, unknown>): AgentAction {
  if (!obj.tx || typeof obj.tx !== "object")
    throw new Error("rawTx must have a tx object");
  const tx = parseRawTx(obj.tx as Record<string, unknown>);
  const action: Extract<AgentAction, { type: "rawTx" }> = { type: "rawTx", tx };
  addPriorityFee(action, obj);
  return action;
}

function parseRawBundleAction(obj: Record<string, unknown>): AgentAction {
  if (!Array.isArray(obj.txs))
    throw new Error("rawBundle txs must be an array");
  if (obj.txs.length === 0) throw new Error("rawBundle txs must not be empty");
  const txs = obj.txs.map((item: unknown, i: number) => {
    if (!item || typeof item !== "object")
      throw new Error(`rawBundle txs[${i}] must be an object`);
    return parseRawTx(item as Record<string, unknown>);
  });
  const action: Extract<AgentAction, { type: "rawBundle" }> = {
    type: "rawBundle",
    txs,
  };
  addPriorityFee(action, obj);
  return action;
}

function parseRawTx(obj: Record<string, unknown>): RawTx {
  if (typeof obj.to !== "string" || !HEX_PATTERN.test(obj.to))
    throw new Error("raw tx to must be a hex string");
  if (typeof obj.data !== "string" || !HEX_PATTERN.test(obj.data))
    throw new Error("raw tx data must be a hex string");
  const tx: RawTx = { to: obj.to, data: obj.data };
  if (obj.value !== undefined) {
    requireDecimalString(obj.value, "raw tx value");
    tx.value = obj.value;
  }
  return tx;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export function validateAction(
  action: AgentAction,
  observation: AgentObservation,
  balances: BalanceSnapshot,
): ActionValidation {
  if (action.type === "noop")
    return {
      ok: true,
      action,
      intents: [],
      rawIntents: [],
      priorityFeeWei: 0n,
      slippageBps: 0,
    };
  if (action.type === "rawTx") return validateRawTxAction(action, observation);
  if (action.type === "rawBundle")
    return validateRawBundleAction(action, observation);
  if (action.type === "bundle") {
    if (action.actions.length === 0)
      return { ok: false, reason: "bundle actions must not be empty" };
    if (action.actions.length > observation.limits.maxBundleActions)
      return {
        ok: false,
        reason: "bundle action count exceeds configured max",
      };
    const bundlePriority = action.maxPriorityFeePerGasWei;
    const bundleId = `${observation.runId}:${observation.round}:${hashAction(action)}`;
    return validateLeafItems(
      action,
      action.actions,
      observation,
      balances,
      bundlePriority === undefined ? undefined : BigInt(bundlePriority),
      bundleId,
    );
  }
  return validateLeafItems(
    action,
    [action as LeafAction],
    observation,
    balances,
  );
}

function validateLeafItems(
  original: AgentAction,
  actions: LeafAction[],
  observation: AgentObservation,
  balances: BalanceSnapshot,
  bundlePriorityFeeWei?: bigint,
  bundleId?: string,
): ActionValidation {
  if (
    bundlePriorityFeeWei !== undefined &&
    bundlePriorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)
  ) {
    return { ok: false, reason: "priority fee exceeds configured max" };
  }

  // Enforce cumulative balances/position counts across the bundle. Validate each leaf against
  // "the balance minus what earlier leaves already consumed", preventing multiple leaves from
  // collectively exceeding the wallet balance or maxOpenPositions (no effect on single actions).
  const work: BalanceSnapshot = {
    ethWei: balances.ethWei,
    wethWei: balances.wethWei,
    usdcUnits: balances.usdcUnits,
    stables: { ...(balances.stables ?? {}) },
    // ADR 0013: accumulate base balances (WETH/WBTC…) across the bundle too. Without this the
    // base-balance check in adapter.validate falls back to work.wethWei and misjudges a WBTC swap
    // against the WETH balance. Even in a WETH-only run bases={WETH:wethWei}, so spendBase keeps
    // it in sync with wethWei and stays byte-compatible.
    ...(balances.bases ? { bases: { ...balances.bases } } : {}),
  };
  const baseLpPositions = observation.protocols.uniswap?.positions.length ?? 0;
  let newLpPositions = 0;

  const intents: ValidatedIntent[] = [];
  for (let i = 0; i < actions.length; i++) {
    const item = actions[i];
    const priorityFeeWei =
      bundlePriorityFeeWei ??
      BigInt(
        item.maxPriorityFeePerGasWei ??
          observation.limits.defaultPriorityFeePerGasWei,
      );
    if (priorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
      return { ok: false, reason: "priority fee exceeds configured max" };
    }

    const adapter = adapterForAction(item);
    const result = adapter.validate(item, observation, work);
    if (!result.ok) return result;

    if (item.type === "mintLiquidity") {
      if (
        baseLpPositions + newLpPositions >=
        observation.limits.maxOpenPositions
      ) {
        return {
          ok: false,
          reason: "open LP position count exceeds configured max",
        };
      }
      newLpPositions++;
    }
    applyLeafSpend(work, item, observation, adapter.stableToken);

    intents.push({
      action: item,
      protocol: adapter.id,
      priorityFeeWei,
      bundleId,
      bundleIndex: bundleId === undefined ? undefined : i,
    });
  }
  return { ok: true, action: original, intents, rawIntents: [] };
}

// Price (USDC per base) of the venue where the swap leg executes. Used to estimate swap output
// inside a bundle. ADR 0013: when base!=="WETH", read that base/USDC market price rather than the
// WETH pool price (the WETH path keeps using the pool price → byte-compatible). If the market is
// not present, degrade to fairPricesUsd → fair.
function swapVenuePrice(obs: AgentObservation, item: LeafAction): number {
  const base = (item as { base?: string }).base ?? "WETH";
  const fallback = obs.fairPricesUsd?.[base] ?? obs.fairPriceUsdcPerWeth;
  const pick = (
    top: number | undefined,
    markets: Record<string, { priceUsdcPerWeth: number }> | undefined,
  ): number =>
    (base === "WETH" ? top : markets?.[`${base}/USDC`]?.priceUsdcPerWeth) ??
    fallback;
  if (item.type === "swap")
    return pick(
      obs.protocols.uniswap?.pool.priceUsdcPerWeth,
      obs.protocols.uniswap?.markets,
    );
  if (item.type === "balancerSwap")
    return pick(
      obs.protocols.balancer?.priceUsdcPerWeth,
      obs.protocols.balancer?.markets,
    );
  if (item.type === "curveSwap")
    return pick(
      obs.protocols.curve?.priceUsdcPerWeth,
      obs.protocols.curve?.markets,
    );
  return fallback;
}

// Deduct the WETH / stable a leaf consumes from the working balance, and for swaps credit back the
// estimated output token (for cumulative bundle validation). Without the output credit, a 2-leg
// "buy USDC→WETH → sell WETH→USDC" arbitrage would be judged to have 0 WETH balance on the sell leg
// and get rejected (breaking the premise of measuring pure alpha under USDC-only funding).
// Estimates are venue-price based; actual slippage is checked on-chain (the validator only prevents
// coarse over-spend).
function applyLeafSpend(
  work: BalanceSnapshot,
  item: LeafAction,
  observation: AgentObservation,
  stableToken?: Address,
): void {
  const stableKey = (stableToken ?? "").toLowerCase();
  // ADR 0013: adjust base balances per base symbol. For WETH, move wethWei and bases["WETH"]
  // together to stay in sync (adapter.validate reads bases["WETH"] while the legacy path reads wethWei).
  const spendBase = (base: string, amount: bigint) => {
    if (base === "WETH")
      work.wethWei = work.wethWei > amount ? work.wethWei - amount : 0n;
    if (work.bases && base in work.bases) {
      const cur = work.bases[base];
      work.bases[base] = cur > amount ? cur - amount : 0n;
    }
  };
  const creditBase = (base: string, amount: bigint) => {
    if (base === "WETH") work.wethWei += amount;
    if (work.bases) work.bases[base] = (work.bases[base] ?? 0n) + amount;
  };
  const spendStable = (amount: bigint) => {
    work.usdcUnits = work.usdcUnits > amount ? work.usdcUnits - amount : 0n;
    if (work.stables && stableKey in work.stables) {
      const cur = work.stables[stableKey];
      work.stables[stableKey] = cur > amount ? cur - amount : 0n;
    }
  };
  const creditStable = (amount: bigint) => {
    work.usdcUnits += amount;
    if (work.stables && stableKey in work.stables)
      work.stables[stableKey] += amount;
  };
  const currentStable = (): bigint =>
    work.stables?.[stableKey] ?? work.usdcUnits;

  switch (item.type) {
    case "swap":
    case "balancerSwap":
    case "curveSwap": {
      const amt = BigInt(item.amountIn);
      const base = item.base ?? "WETH";
      const baseScale = 10 ** tokenInfo(base).decimals; // WETH=1e18 / WBTC=1e8
      const price = swapVenuePrice(observation, item); // quote(USDC) per base
      if (item.tokenIn === base) {
        spendBase(base, amt);
        // base→stable: output stable ≈ amountBase × price
        if (price > 0)
          creditStable(
            BigInt(Math.floor((Number(amt) / baseScale) * price * 1e6)),
          );
      } else {
        spendStable(amt);
        // stable→base: output base ≈ amountStable / price
        if (price > 0)
          creditBase(
            base,
            BigInt(Math.floor((Number(amt) / 1e6 / price) * baseScale)),
          );
      }
      break;
    }
    case "mintLiquidity":
      spendBase(
        item.base ?? "WETH",
        BigInt(item.amountBaseDesired ?? item.amountWethDesired),
      );
      spendStable(BigInt(item.amountQuoteDesired ?? item.amountUsdcDesired));
      break;
    case "aaveSupply":
      if (kindOf(item.asset) === "base")
        spendBase(item.asset, BigInt(item.amount));
      else spendStable(BigInt(item.amount));
      break;
    case "aaveRepay": {
      const isBase = kindOf(item.asset) === "base";
      const amt =
        item.amount === "max"
          ? isBase
            ? (work.bases?.[item.asset] ?? work.wethWei)
            : currentStable()
          : BigInt(item.amount);
      if (isBase) spendBase(item.asset, amt);
      else spendStable(amt);
      break;
    }
    default:
      break; // borrow/withdraw/collectFees/removeLiquidity/gmx do not consume input
  }
}

function validateRawTxAction(
  action: Extract<AgentAction, { type: "rawTx" }>,
  observation: AgentObservation,
): ActionValidation {
  const priorityFeeWei = BigInt(
    action.maxPriorityFeePerGasWei ??
      observation.limits.defaultPriorityFeePerGasWei,
  );
  if (priorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
    return { ok: false, reason: "priority fee exceeds configured max" };
  }
  return {
    ok: true,
    action,
    intents: [],
    rawIntents: [{ tx: action.tx, priorityFeeWei }],
  };
}

function validateRawBundleAction(
  action: Extract<AgentAction, { type: "rawBundle" }>,
  observation: AgentObservation,
): ActionValidation {
  if (action.txs.length > observation.limits.maxBundleActions) {
    return { ok: false, reason: "rawBundle tx count exceeds configured max" };
  }
  const priorityFeeWei = BigInt(
    action.maxPriorityFeePerGasWei ??
      observation.limits.defaultPriorityFeePerGasWei,
  );
  if (priorityFeeWei > BigInt(observation.limits.maxPriorityFeePerGasWei)) {
    return { ok: false, reason: "priority fee exceeds configured max" };
  }
  const bundleId = `${observation.runId}:${observation.round}:${hashAction(action)}`;
  const rawIntents = action.txs.map((tx, i) => ({
    tx,
    priorityFeeWei,
    bundleId,
    bundleIndex: i,
  }));
  return { ok: true, action, intents: [], rawIntents };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function addPriorityFee(
  action: { maxPriorityFeePerGasWei?: string },
  obj: Record<string, unknown>,
): void {
  if (obj.maxPriorityFeePerGasWei === undefined) return;
  requireDecimalString(obj.maxPriorityFeePerGasWei, "maxPriorityFeePerGasWei");
  action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
}

function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

function hashAction(action: AgentAction): string {
  const json = JSON.stringify(action);
  let hash = 0;
  for (let i = 0; i < json.length; i++)
    hash = (hash * 31 + json.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

// getAdapter re-export (in case the coordinator needs it for buildTxs)
export { getAdapter };
