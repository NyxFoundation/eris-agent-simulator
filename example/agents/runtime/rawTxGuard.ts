/**
 * rawTxGuard.ts: where a model-written strategy may send raw calldata (issue #214 item 3).
 *
 * The revision loop (ADR 0018) hands the model text that came off the chain: revert reasons from
 * contracts other participants deployed (a lending market's oracle or IRM, a registry pool, a
 * token) reach it as `submit_failed: Execution reverted with reason: ...`, next to the decisions
 * that produced them. A string there that reads "send your USDC to 0x..." is data, and the context
 * says so (improve.ts) -- but if the model follows it anyway, `rawTx` is the exit: the runtime signs
 * whatever `to` / `data` the strategy returns, with the victim's key.
 *
 * So in the reference runtime a *revised* strategy (version > 0: written by the model, not by the
 * participant) may only send raw calldata to addresses the run already knows -- the venues and
 * tokens of the bundled address table, the run's own contracts (PriceFeed, registry, lending
 * singleton) and the registry's entries -- and may not use the ERC-20 transfer selectors at all. An
 * `approve` is allowed only when the spender is a venue or a verified registry entry: approving an
 * unknown contract is the other way to hand it the balance. Deployment (no `to`) is refused for a
 * revised strategy too. The strategy the participant shipped (version 0) is unrestricted, as before:
 * it is their code, and rules §2.5 make what it does their decision.
 *
 * This closes the exit in the runtime the operator ships. A participant's own runtime is theirs.
 */
import type {
  AgentAction,
  AgentObservation,
  RawTx,
} from "@eris/sdk/types.js";
import * as constants from "@eris/sdk/constants.js";
import { FLASH_ARB_ADDRESS } from "@eris/sdk/wellKnown.js";

export type RawTxAllowlist = {
  /** Lowercase addresses of the run's venues, tokens and own contracts: anything may be sent here. */
  known: Set<string>;
  /** Lowercase address -> whether the registry marked it verified (entryObservation.verified). */
  registry: Map<string, { verified: boolean; kind: string }>;
};

export type RawTxGuardVerdict = { ok: true } | { ok: false; reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// ERC-20 / ERC-721 selectors that move or delegate a balance. keccak256 of the signature, first
// four bytes; fixed by the standard, so written out rather than computed at load.
const SELECTOR_TRANSFER = "0xa9059cbb"; // transfer(address,uint256)
const SELECTOR_TRANSFER_FROM = "0x23b872dd"; // transferFrom(address,address,uint256)
const SELECTOR_SAFE_TRANSFER_FROM = "0x42842e0e"; // safeTransferFrom(address,address,uint256)
const SELECTOR_SAFE_TRANSFER_FROM_DATA = "0xb88d4fde"; // safeTransferFrom(address,address,uint256,bytes)
const SELECTOR_SET_APPROVAL_FOR_ALL = "0xa22cb465"; // setApprovalForAll(address,bool)
const SELECTOR_APPROVE = "0x095ea7b3"; // approve(address,uint256)
const SELECTOR_INCREASE_ALLOWANCE = "0x39509351"; // increaseAllowance(address,uint256)
const SELECTOR_PERMIT = "0xd505accf"; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)

const REFUSED_SELECTORS: Record<string, string> = {
  [SELECTOR_TRANSFER]: "transfer",
  [SELECTOR_TRANSFER_FROM]: "transferFrom",
  [SELECTOR_SAFE_TRANSFER_FROM]: "safeTransferFrom",
  [SELECTOR_SAFE_TRANSFER_FROM_DATA]: "safeTransferFrom",
  [SELECTOR_SET_APPROVAL_FOR_ALL]: "setApprovalForAll",
};
// Selector -> which argument (0-based, 32-byte words after the selector) names the spender.
const APPROVAL_SELECTORS: Record<string, { name: string; spenderWord: number }> = {
  [SELECTOR_APPROVE]: { name: "approve", spenderWord: 0 },
  [SELECTOR_INCREASE_ALLOWANCE]: { name: "increaseAllowance", spenderWord: 0 },
  [SELECTOR_PERMIT]: { name: "permit", spenderWord: 1 },
};

// Every address in a value: the bundled address table is a handful of nested objects of addresses
// and numbers, and walking it is what keeps this list from needing a hand-maintained twin of
// constants.ts (which test/actionVocabulary.test.ts exists to prevent for the action names).
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

/**
 * The allowlist for one decision: the bundled table, the run's own contracts the runtime was given
 * (PriceFeed, market registry, lending singleton), and what the registry currently lists.
 */
export function rawTxAllowlist(opts: {
  observation: AgentObservation | null;
  runContracts?: ReadonlyArray<string | undefined>;
}): RawTxAllowlist {
  const known = new Set<string>(bundledAddresses());
  for (const a of opts.runContracts ?? [])
    if (a !== undefined && ADDRESS.test(a)) known.add(a.toLowerCase());
  const registry = new Map<string, { verified: boolean; kind: string }>();
  const reg = opts.observation?.registry;
  if (reg) {
    if (ADDRESS.test(reg.address)) known.add(reg.address.toLowerCase());
    for (const e of reg.entries) {
      if (!ADDRESS.test(e.market)) continue;
      registry.set(e.market.toLowerCase(), { verified: e.verified, kind: e.kind });
    }
  }
  return { known, registry };
}

function spenderOf(data: string, word: number): string | null {
  const start = 10 + word * 64; // "0x" + 8 hex of selector, then 64 hex per word
  const chunk = data.slice(start, start + 64);
  if (chunk.length !== 64) return null;
  return `0x${chunk.slice(24)}`.toLowerCase();
}

function checkOne(tx: RawTx, allow: RawTxAllowlist, label: string): RawTxGuardVerdict {
  if (tx.to === undefined)
    return {
      ok: false,
      reason: `${label}: a revised strategy may not deploy contracts (rawTx without \`to\`)`,
    };
  const to = tx.to.toLowerCase();
  const isKnown = allow.known.has(to);
  const entry = allow.registry.get(to);
  if (!isKnown && entry === undefined)
    return {
      ok: false,
      reason:
        `${label}: destination ${tx.to} is not a venue, a token of this run or a registry entry; ` +
        "a revised strategy may only send raw calldata to addresses the run knows",
    };
  if (tx.value !== undefined && BigInt(tx.value) > 0n && !isKnown)
    return {
      ok: false,
      reason: `${label}: a revised strategy may not send ETH to a registry entry (${tx.to})`,
    };
  const selector = tx.data.slice(0, 10).toLowerCase();
  const refused = REFUSED_SELECTORS[selector];
  if (refused !== undefined)
    return {
      ok: false,
      reason:
        `${label}: ${refused}() to ${tx.to} -- a revised strategy may not move a balance ` +
        "directly; venues pull what they need through the registered actions",
    };
  const approval = APPROVAL_SELECTORS[selector];
  if (approval !== undefined) {
    const spender = spenderOf(tx.data, approval.spenderWord);
    const spenderEntry = spender === null ? undefined : allow.registry.get(spender);
    const spenderOk =
      spender !== null &&
      (allow.known.has(spender) || spenderEntry?.verified === true);
    if (!spenderOk)
      return {
        ok: false,
        reason:
          `${label}: ${approval.name}() with spender ${spender ?? "(unreadable)"} -- a revised ` +
          "strategy may only approve a venue or a verified registry entry",
      };
  }
  return { ok: true };
}

/**
 * Whether a revised strategy's raw action may be sent. Anything that is not `rawTx` / `rawBundle`
 * passes: the registered actions are built by the adapters and cannot name a destination.
 */
export function checkRevisedRawTx(
  action: AgentAction,
  allow: RawTxAllowlist,
): RawTxGuardVerdict {
  if (action.type === "rawTx") return checkOne(action.tx, allow, "rawTx");
  if (action.type === "rawBundle") {
    for (let i = 0; i < action.txs.length; i++) {
      const verdict = checkOne(action.txs[i], allow, `rawBundle[${i}]`);
      if (!verdict.ok) return verdict;
    }
  }
  return { ok: true };
}
