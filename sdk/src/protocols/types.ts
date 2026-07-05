import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type { makeChain } from "../chain.js";
import type { SimConfig } from "../config.js";
import type { Rng } from "../rng.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  BundleActionItem,
  LeafAction,
  ProtocolId,
} from "../types.js";

export type FlowKind = "informed" | "uninformed";

export interface FlowWallet {
  id: string;
  address: Address;
  privateKey: Hex;
}

export interface BuiltTx {
  to: Address;
  data: Hex;
  value?: bigint;
  gas?: bigint;
}

export interface FlowOrder {
  kind: FlowKind;
  action: LeafAction;
  priorityFeeWei: bigint;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

// Oracle control handles for GMX / Aave (finalized in setupGlobal)
export interface OracleHandles {
  gmxProvider?: Address;
  aaveAggregators: Record<string, Address>; // token address(lower) -> MockAggregator
}

export interface SimContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: ReturnType<typeof makeChain>;
  config: SimConfig;
  rng: Rng;
  adminPk: Hex;
  keeperPk: Hex;
  oracle: OracleHandles;
  gmx: {
    mockProvider?: Address;
    market: Address; // WETH (ETH/USD) market. Kept for backward compatibility (= markets["WETH"]).
    markets?: Record<string, Address>; // ADR 0013: base -> GMX market (WBTC etc.)
  };
  // ADR 0013: fair price (USD) for all bases. When unset or WETH-only, adapters fall back to the single
  // fairPrice. Adapters that handle the WBTC market use ctx.fairPrices?.[base].
  fairPrices?: Record<string, number>;
  // GMX order keys created during the competition block (executed in the keeper block)
  pendingGmxOrders: Hex[];
  // GMX mock oracle update (set by gmx.setupGlobal; called from oracles.updateOracles)
  // opts.noMine=true submits to the mempool without mining for realtime (bids via priorityFeeWei).
  updateGmxOracle?: (
    ctx: SimContext,
    fairPrice: number,
    opts?: { noMine?: boolean; priorityFeeWei?: bigint },
  ) => Promise<void>;
  // Flow wallet per protocol/kind
  flowWallet(protocol: ProtocolId, kind: FlowKind): FlowWallet;
  // Look up a flow wallet by an arbitrary key (e.g. "aave:actor0" of the aave borrower pool; throws if unregistered).
  flowWalletByKey(key: string): FlowWallet;
}

export interface ProtocolAdapter {
  id: ProtocolId;

  // The stable token this protocol treats as "USDC" (for unified stable accounting).
  // If unspecified, native USDC is assumed.
  stableToken?: Address;

  // ---- Action parse/validate (pure functions; no clients needed) ----
  // null if not this adapter's type
  parse(obj: Record<string, unknown>): LeafAction | null;
  // Whether it is allowed inside a bundle (false for GMX)
  bundleable(action: LeafAction): boolean;
  validate(
    action: LeafAction,
    obs: AgentObservation,
    balances: BalanceSnapshot,
  ): ValidationResult;

  // ---- Per-round state read ----
  readState(ctx: SimContext, fairPrice: number): Promise<unknown>;

  // ---- Observation contribution (goes into obs.protocols[id]) ----
  observe(
    ctx: SimContext,
    state: unknown,
    agent: Address,
    fairPrice: number,
  ): Promise<unknown>;

  // ---- intent -> on-chain tx ----
  buildTxs(
    ctx: SimContext,
    owner: Address,
    action: LeafAction,
    state: unknown,
  ): Promise<BuiltTx[]>;

  // ---- Post-mine hook (GMX keeper execution) ----
  // Keeper processing after the competition block (e.g. executing GMX orders).
  // opts.noMine=true submits to the mempool without mining for realtime.
  // The target blocks are given as the range fromBlock..toBlock (to scan the realtime catch-up in one
  // getLogs). blockNumber is the old form for a single block (kept for the synchronous coordinator).
  afterMine?(
    ctx: SimContext,
    opts?: {
      noMine?: boolean;
      priorityFeeWei?: bigint;
      blockNumber?: bigint;
      fromBlock?: bigint;
      toBlock?: bigint;
    },
  ): Promise<void>;

  // ---- PnL contribution (USDC) ----
  valueUsdc(
    ctx: SimContext,
    agent: Address,
    state: unknown,
    fairPrice: number,
  ): Promise<number>;

  // ---- Per-wallet setup (returns txs such as approvals; the coordinator sends them with the owner key) ----
  setupWallet?(ctx: SimContext, owner: Address): Promise<BuiltTx[]>;

  // ---- Global setup (mock deploy / role granting / swapping the oracle source) ----
  setupGlobal?(ctx: SimContext): Promise<void>;
}

// Helper type that widens a bundle leaf to a LeafAction
export type { BundleActionItem };
