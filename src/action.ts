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

// 各 adapter の parse を順に試し、最初に非 null を返したものを採用。
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
    const result = adapter.validate(item, observation, balances);
    if (!result.ok) return result;

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

// getAdapter re-export（coordinator から buildTxs 用に使う場合に備え）
export { getAdapter };
