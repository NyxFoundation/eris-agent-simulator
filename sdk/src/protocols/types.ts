import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type { makeChain } from "../chain.js";
import type { SimConfig } from "../config.js";
import type { Rng } from "../rng.js";
import type { StablePrices } from "../stables.js";
import type { UnpricedAmount } from "../valuation.js";
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
  // Issue #40: contracts the environment deploys per *run* rather than per deployment, so they
  // cannot live in constants.local.ts the way a venue address does. Both are undefined in a run
  // without agent-created markets, and every reader treats that as "the capability is off" rather
  // than as an error.
  //
  //   marketRegistry  where agent-deployed contracts are published (the PriceFeed pattern).
  //   lending         the permissionless lending singleton agents open markets in.
  marketRegistry?: Address;
  lending?: Address;
  // Flow wallet per protocol/kind
  flowWallet(protocol: ProtocolId, kind: FlowKind): FlowWallet;
  // Look up a flow wallet by an arbitrary key (e.g. "aave:actor0" of the aave borrower pool; throws if unregistered).
  flowWalletByKey(key: string): FlowWallet;
}

// ---------------------------------------------------------------------------
// Historical valuation for scoring (issue #41)
//
// The scorer used to hand-assemble a multicall per protocol behind hasUniswap / hasAave / hasGmx
// flags, which fixed the set of valuable things at the scorer: anything not wired in was worth zero
// rather than unsupported. These types move that knowledge into the adapters.
//
// The shape is a *staged generator* rather than the obvious `valueAtBlock(agent, block)`: a per-agent
// async call would issue one round trip per agent per protocol, dissolving ADR 0006 §4's "one
// multicall per block cross-section" batching (a 30-agent / 300-block run goes from ~1,500 multicalls
// to ~45,000 RPC calls). Yielding the reads instead lets the scorer merge every adapter's stage-N
// reads into a single multicall, so the round-trip count tracks the number of stages, not agents.
// ---------------------------------------------------------------------------

// One contract read inside a batched cross-section multicall.
export type ValuationRead = {
  address: Address;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous ABIs share a single multicall
  abi: any;
  functionName: string;
  args?: readonly unknown[];
};

export type ValuationAgent = { id: string; address: Address };

export type ValuationContext = {
  publicClient: PublicClient;
  blockNumber: number;
  // Last block of the run window. Realizable-exit marking needs to know how much of the run is
  // left: a redemption queued now is only worth par if it finalizes before the run ends (issue
  // #38). Equals blockNumber when the caller has no horizon, which is the conservative reading.
  horizonBlock: number;
  agents: readonly ValuationAgent[];
  // The stables the run sweeps as spot.
  activeStables: readonly Address[];
  // USD price per base symbol. The prices are themselves read in the first stage, so this is only
  // populated once that stage returns: call it when computing values, never when choosing reads.
  fairByBase(): Record<string, number>;
  // What each market-priced stable is worth in USDC at this cross-section (issue #27). One owner
  // for the number: the scorer probes each stable's market in stage 0 and every venue that names a
  // stable leg reads it from here, so nothing prices the same token twice or differently. Same
  // "populated after stage 0" contract as fairByBase.
  stablePrices(): StablePrices;
};

// A holding the adapter could not fold into its value, either because it cannot be priced (#41) or
// because the read that would have revealed it failed (#44). Reported rather than silently zeroed.
export type UnpricedHoldingDetail = UnpricedAmount & {
  // Where it came from, e.g. "uniswap-lp:<tokenId>" / "balancer-bpt".
  source: string;
};

export type AgentProtocolValue = {
  valueUsdc: number;
  // What the position would actually realize on exit. Equal to valueUsdc for venues that exit at
  // par; #38 (queued LST withdrawal), #39 (depegged eUSD) and #40 (self-issued token in a thin pool)
  // are the cases that will diverge. Existing venues are deliberately not re-marked -- that would
  // invalidate comparison with every past run.
  liquidatableValueUsdc: number;
  unpriced: UnpricedHoldingDetail[];
};

// Yields the reads it wants for a stage, receives that stage's results, and finally returns each
// agent's value. Returning early is fine; the scorer just stops advancing it.
export type ValuationRun = AsyncGenerator<
  ValuationRead[],
  Record<string, AgentProtocolValue>,
  unknown[]
>;

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

  // ---- Historical valuation for post-run scoring (ADR 0006 §4) ----
  // Adapters without one contribute nothing to an agent's value at a block cross-section.
  valueAtBlock?(ctx: ValuationContext): ValuationRun;

  // ---- Tokens this adapter already accounts for ----
  // The scorer reports ERC-20 holdings that nothing sums (issue #41). A token listed here is either
  // valued by valueAtBlock or covered by an aggregate it reads, so reporting it would be a false
  // positive. Tokens a venue issues but does not yet value must be left out, so they stay visible.
  accountedTokens?(publicClient: PublicClient): Promise<Address[]>;

  // ---- Per-wallet setup (returns txs such as approvals; the coordinator sends them with the owner key) ----
  setupWallet?(ctx: SimContext, owner: Address): Promise<BuiltTx[]>;

  // ---- Global setup (mock deploy / role granting / swapping the oracle source) ----
  setupGlobal?(ctx: SimContext): Promise<void>;
}

// Helper type that widens a bundle leaf to a LeafAction
export type { BundleActionItem };
