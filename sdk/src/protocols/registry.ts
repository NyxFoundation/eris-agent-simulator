import type { Address } from "viem";
import { setActiveBases, setActiveStables } from "../chain.js";
import type { LeafAction, ProtocolId } from "../types.js";
import type { ProtocolAdapter } from "./types.js";
import { uniswapAdapter } from "./uniswap.js";
import { balancerAdapter } from "./balancer.js";
import { curveAdapter } from "./curve.js";
import { aaveAdapter } from "./aave.js";
import { gmxAdapter } from "./gmx.js";
import { lstAdapter } from "./lst.js";
import { liquityAdapter } from "./liquity.js";
import { activeBaseSymbols, tokenInfo } from "../markets.js";
import { setEnabledProtocolIds } from "./enabled.js";
import { stablesForProtocols } from "../stables.js";

// All adapters (only implemented ones are registered). Added as phases progress.
const ALL_ADAPTERS: ProtocolAdapter[] = [
  uniswapAdapter,
  balancerAdapter,
  curveAdapter,
  aaveAdapter,
  gmxAdapter,
  lstAdapter,
  liquityAdapter,
];

const ALL_BY_ID = new Map<ProtocolId, ProtocolAdapter>(
  ALL_ADAPTERS.map((a) => [a.id, a]),
);

export const ALL_PROTOCOL_IDS: ProtocolId[] = ALL_ADAPTERS.map((a) => a.id);

// The venues a run gets when it does not say. lst and liquity are left out because they exist only
// under local deploy (issues #38 / #39) -- defaulting either on would break every fork run at the
// first read.
const LOCAL_ONLY_PROTOCOL_IDS: ProtocolId[] = ["lst", "liquity"];
const DEFAULT_PROTOCOL_IDS: ProtocolId[] = ALL_ADAPTERS.map((a) => a.id).filter(
  (id) => !LOCAL_ONLY_PROTOCOL_IDS.includes(id),
);

// Set by the coordinator at startup. When unset, the default set above is treated as enabled.
let enabledIds: ProtocolId[] = [...DEFAULT_PROTOCOL_IDS];
setEnabledProtocolIds(enabledIds);

export function setEnabledProtocols(ids: ProtocolId[]): void {
  const filtered = ids.filter((id) => ALL_BY_ID.has(id));
  enabledIds = filtered.length > 0 ? filtered : [...DEFAULT_PROTOCOL_IDS];
  // Published so an adapter can ask what the run enabled without importing this module back
  // (which would be a cycle, since this one imports every adapter).
  setEnabledProtocolIds(enabledIds);
}

export function enabledAdapters(): ProtocolAdapter[] {
  return enabledIds.map((id) => ALL_BY_ID.get(id)!).filter(Boolean);
}

// Standard initialization that bundles configuring enabled protocols and registering the unified stable accounting (active stable).
// The environment (coordinator) and the direct-mode agent shim share the same procedure.
export function initProtocols(ids: ProtocolId[]): ProtocolAdapter[] {
  setEnabledProtocols(ids);
  const adapters = enabledAdapters();
  setActiveStables([
    // Each venue's USDC-equivalent leg...
    ...adapters
      .map((a) => a.stableToken)
      .filter((t): t is Address => Boolean(t)),
    // ...plus every stable this run's venues bring with them, which are swept and priced from their
    // own market rather than assumed to be dollars (issue #27). eUSD arrives with liquity, a
    // stableswap-paired stable with curve.
    ...stablesForProtocols(enabledIds).map((m) => m.token),
  ]);
  // ADR 0013: register the enabled protocols' bases (WETH + additional bases) into ACTIVE_BASES. getBalances
  // reads all base balances and feeds observation (baseBalances) and scoring. [WETH] on the default fork (matches prior behavior).
  setActiveBases(
    activeBaseSymbols(enabledIds).map((s) => tokenInfo(s).address),
  );
  return adapters;
}

export function getAdapter(id: ProtocolId): ProtocolAdapter {
  const adapter = ALL_BY_ID.get(id);
  if (!adapter) throw new Error(`adapter not implemented: ${id}`);
  return adapter;
}

export function hasAdapter(id: ProtocolId): boolean {
  return ALL_BY_ID.has(id);
}

// Resolve the adapter / protocol that owns a leaf action from its type.
// Try each adapter's parse and take the first that returns non-null.
export function adapterForAction(action: LeafAction): ProtocolAdapter {
  for (const adapter of enabledAdapters()) {
    const parsed = adapter.parse({ ...action });
    if (parsed) return adapter;
  }
  throw new Error(
    `no adapter owns action type: ${(action as { type: string }).type}`,
  );
}

export function protocolForAction(action: LeafAction): ProtocolId {
  return adapterForAction(action).id;
}
