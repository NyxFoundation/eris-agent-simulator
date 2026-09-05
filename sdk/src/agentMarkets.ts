// What an agent has left inside a contract the environment cannot value (issue #40 T1 / T3).
//
// The round-trip rule needs exactly one number that the old scorer never produced: for each agent,
// the known tokens it moved *into* an unregistered-or-unknown contract and did not get back. Profit
// taken **through** an unknown contract counts in full — deposit 10,000 USDC at block 100, withdraw
// 11,000 at block 500, and the +1,000 is credited by ordinary spot accounting. What is not credited
// is a position still sitting inside when the bell rings.
//
// That number is not a valuation and cannot be forged: it is the net of the token contract's own
// Transfer logs, in tokens the environment prices. It exists so that a zero in the value series is
// never mistaken for a trading loss (`scoring_unpriced_holdings`), and so an agent can see, before
// the last block, what it still has to get out.
//
// It is deliberately **not** the contract's balance: a pool holding 1,000 USDC owes it to whoever
// holds the LP, and crediting the depositor as well would count the same reserves twice. But the
// balance is an *upper bound* and the report is capped by it, because the net alone overclaims: if
// C pulls 100 USDC from A and forwards it to B in the same transaction, C ends holding nothing and
// A's net into C is still 100. A did lose the 100 -- its spot balance says so, and that is where
// the loss is scored -- but "stranded in C" would be the wrong account of where it went.
import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { MULTICALL3 } from "./constants.js";
import { erc20Abi } from "./abis.js";
import {
  entryObservation,
  readCodehashes,
  readOracleOwners,
  readRegistryEntries,
  ZERO_ADDRESS,
} from "./marketRegistry.js";
import type {
  RegistryObservation,
  StrandedHoldingObservation,
} from "./types.js";

export const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export type TransferLogLike = {
  address: Address;
  topics: readonly Hex[];
  args?: { from?: Address; to?: Address; value?: bigint };
};

export type StrandedFlow = {
  market: Address;
  token: Address;
  amountRaw: bigint;
};

// Cap each flow by what the contract actually still holds of that token. Without it the report
// claims value is sitting somewhere it is not: a contract that passed the tokens straight through
// to a third party holds none of them.
//
// Single-agent form. Use `allocateToBalances` when more than one agent's flows are in hand: capping
// each agent independently against the same balance would report the same tokens once per agent.
export function clampToBalances(
  flows: readonly StrandedFlow[],
  balances: ReadonlyMap<string, bigint>,
): StrandedFlow[] {
  const out: StrandedFlow[] = [];
  for (const flow of flows) {
    const held = balances.get(`${flow.market.toLowerCase()}|${flow.token.toLowerCase()}`);
    if (held === undefined) {
      // The balance could not be read. Report the net rather than dropping the flow: an unread
      // balance is not evidence that nothing is there.
      out.push(flow);
      continue;
    }
    const amount = held < flow.amountRaw ? held : flow.amountRaw;
    if (amount > 0n) out.push({ ...flow, amountRaw: amount });
  }
  return out;
}

export type AgentFlows<T> = { agent: T; flows: readonly StrandedFlow[] };

// The same cap, taken across every agent at once and split pro rata.
//
// Clamping each agent separately against the same balance reports the same tokens once per agent:
// A and B each put 100 into C, C forwards 100 away and keeps 100, and both are told 100 is theirs.
// Two hundred is reported as sitting in a contract holding one hundred. Splitting in proportion to
// what each put in is the only allocation available -- the contract's balance is fungible and its
// internal accounting is, by construction, something the environment cannot read.
export function allocateToBalances<T>(
  byAgent: ReadonlyArray<AgentFlows<T>>,
  balances: ReadonlyMap<string, bigint>,
): Array<AgentFlows<T>> {
  const totals = new Map<string, bigint>();
  for (const { flows } of byAgent) {
    for (const f of flows) {
      const k = key(f.market, f.token);
      totals.set(k, (totals.get(k) ?? 0n) + f.amountRaw);
    }
  }
  return byAgent.map(({ agent, flows }) => ({
    agent,
    flows: flows.flatMap((f) => {
      const k = key(f.market, f.token);
      const held = balances.get(k);
      // An unread balance is not evidence that nothing is there.
      if (held === undefined) return [f];
      const total = totals.get(k) ?? 0n;
      if (total === 0n) return [];
      const amount = held >= total ? f.amountRaw : (f.amountRaw * held) / total;
      return amount > 0n ? [{ ...f, amountRaw: amount }] : [];
    }),
  }));
}

// balanceOf for a set of (holder, token) pairs, keyed the way clampToBalances reads them.
export async function readHeldBalances(
  publicClient: PublicClient,
  pairs: ReadonlyArray<{ holder: Address; token: Address }>,
  blockNumber?: bigint,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (pairs.length === 0) return out;
  let results: Array<{ status: "success" | "failure"; result?: unknown }>;
  try {
    results = (await publicClient.multicall({
      contracts: pairs.map(({ holder, token }) => ({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holder],
      })) as never,
      multicallAddress: MULTICALL3,
      allowFailure: true,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  } catch {
    return out;
  }
  pairs.forEach(({ holder, token }, i) => {
    const r = results[i];
    if (r.status !== "success" || typeof r.result !== "bigint") return;
    out.set(`${holder.toLowerCase()}|${token.toLowerCase()}`, r.result);
  });
  return out;
}

function key(market: string, token: string): string {
  return `${market.toLowerCase()}|${token.toLowerCase()}`;
}

// Net token flow from `agent` into each of `markets`, accumulated across calls so a per-block reader
// can feed it one block range at a time and the post-run scorer can feed it the whole run.
export class StrandedLedger {
  private readonly net = new Map<string, bigint>();
  private readonly meta = new Map<string, { market: Address; token: Address }>();

  // `markets` is matched case-insensitively; entries added later are picked up on the next apply,
  // which is correct — a contract that was not in the registry yet was not a registry entry yet.
  apply(
    logs: readonly TransferLogLike[],
    agent: Address,
    markets: ReadonlySet<string>,
  ): void {
    const me = agent.toLowerCase();
    for (const log of logs) {
      // ERC-721 shares topic0 but indexes tokenId as well, giving four topics. A non-fungible
      // "amount" is not a quantity of anything the scorer prices.
      if (log.topics.length !== 3) continue;
      const from = log.args?.from?.toLowerCase();
      const to = log.args?.to?.toLowerCase();
      const value = log.args?.value;
      if (value === undefined || from === undefined || to === undefined) continue;
      const token = log.address;
      if (from === me && markets.has(to)) {
        const k = key(to, token);
        this.net.set(k, (this.net.get(k) ?? 0n) + value);
        this.meta.set(k, { market: to as Address, token });
      } else if (to === me && markets.has(from)) {
        const k = key(from, token);
        this.net.set(k, (this.net.get(k) ?? 0n) - value);
        this.meta.set(k, { market: from as Address, token });
      }
    }
  }

  // Only what is still in there. A negative net means the agent took more out than it put in, which
  // is profit already sitting in its wallet and counted by spot accounting — not a debt.
  outstanding(): StrandedFlow[] {
    const out: StrandedFlow[] = [];
    for (const [k, amount] of this.net) {
      if (amount <= 0n) continue;
      const m = this.meta.get(k);
      if (!m) continue;
      out.push({ market: m.market, token: m.token, amountRaw: amount });
    }
    return out;
  }
}

// Fetch the Transfer logs that can move `agent`'s balance over a block range. Two filters rather
// than one unfiltered scan: the node indexes the topic, and an epoch of every transfer on the chain
// is not something a per-block agent loop can afford.
export async function fetchAgentTransfers(
  publicClient: PublicClient,
  agent: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TransferLogLike[]> {
  if (fromBlock > toBlock) return [];
  const [sent, received] = await Promise.all([
    publicClient.getLogs({
      event: transferEvent,
      args: { from: agent },
      fromBlock,
      toBlock,
      strict: false,
    }),
    publicClient.getLogs({
      event: transferEvent,
      args: { to: agent },
      fromBlock,
      toBlock,
      strict: false,
    }),
  ]);
  return [...sent, ...received] as TransferLogLike[];
}

export type AllowanceRead = {
  spender: Address;
  token: Address;
  amount: bigint;
};

// Outstanding allowances this agent has granted to registry entries. Approvals are the victim's
// problem — a contract that drains through an unlimited `approve` is in scope under the rules — so
// the observation shows them rather than the runtime forbidding them.
export async function readAllowances(
  publicClient: PublicClient,
  agent: Address,
  pairs: ReadonlyArray<{ spender: Address; token: Address }>,
): Promise<AllowanceRead[]> {
  if (pairs.length === 0) return [];
  const results = (await publicClient.multicall({
    contracts: pairs.map(({ spender, token }) => ({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [agent, spender],
    })) as never,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  const out: AllowanceRead[] = [];
  pairs.forEach((pair, i) => {
    const r = results[i];
    if (r.status !== "success" || typeof r.result !== "bigint") return;
    if (r.result <= 0n) return;
    out.push({ spender: pair.spender, token: pair.token, amount: r.result });
  });
  return out;
}

// viem's MaxUint256, spelled out rather than imported so the meaning is on the page: this is the
// approval that hands a contract the whole balance forever.
export const MAX_UINT256 = (1n << 256n) - 1n;

// An allowance large enough that it is a standing grant rather than a sized one. Anything at or
// above 2^255 can only have come from "approve everything".
export const UNLIMITED_ALLOWANCE_THRESHOLD = 1n << 255n;

// ---------------------------------------------------------------------------
// The registry section of the observation (issue #40 T3)
// ---------------------------------------------------------------------------

// Builds `observation.registry` block by block, keeping the running stranded-holdings ledger the
// round-trip rule needs. Stateful because the ledger is: it is a net over the whole run, and a
// per-block reader that re-scanned from the start every block would spend the run doing it.
// How many registry entries one observation carries. Deployment is permissionless and costs the
// creator only gas, so the entry count is somebody's choice; the per-block cost of reading it must
// not be. Newest first, and the number dropped is reported rather than left to be inferred from a
// list that looks complete.
export const REGISTRY_OBSERVATION_LIMIT = 128;

export class MarketRegistryWatcher {
  private readonly ledger = new StrandedLedger();
  private readonly markets = new Set<string>();
  private scannedThroughBlock: number | null = null;

  constructor(
    private readonly registry: Address,
    private readonly agent: Address,
    // The block the registry was deployed. Nothing before it can be an entry.
    private readonly fromBlock: number,
    // Tokens the environment prices. A holding of anything else is worth zero anyway, so tracking
    // where it went would report a number nobody scores.
    private readonly pricedTokens: ReadonlySet<string>,
  ) {}

  async observe(
    publicClient: PublicClient,
    blockNumber: number,
  ): Promise<RegistryObservation> {
    const all = await readRegistryEntries(publicClient, this.registry);
    // Every entry feeds the ledger's market set -- an omitted entry would make a real deposit look
    // like it went nowhere -- but only a bounded, newest-first slice is read back per block and
    // carried in the observation.
    for (const e of all) this.markets.add(e.market.toLowerCase());
    const entries = all.slice(-REGISTRY_OBSERVATION_LIMIT).reverse();
    const droppedEntries = all.length - entries.length;

    const [codehashes, oracleOwners] = await Promise.all([
      readCodehashes(
        publicClient,
        entries.map((e) => e.market),
      ),
      readOracleOwners(
        publicClient,
        entries.map((e) => e.oracle).filter((o) => o !== ZERO_ADDRESS),
      ),
    ]);

    // Only the newly-mined range: the ledger is cumulative, so rescanning would double-count.
    const start =
      this.scannedThroughBlock === null
        ? this.fromBlock
        : this.scannedThroughBlock + 1;
    if (blockNumber >= start) {
      try {
        const logs = await fetchAgentTransfers(
          publicClient,
          this.agent,
          BigInt(start),
          BigInt(blockNumber),
        );
        this.ledger.apply(logs, this.agent, this.markets);
        this.scannedThroughBlock = blockNumber;
      } catch {
        // Leave scannedThroughBlock alone so the range is retried rather than skipped: a gap here
        // would understate what is stranded, which is the direction that costs the agent money.
      }
    }

    const unknownMarkets = new Set(
      entries
        .filter((e) => !e.verified)
        .map((e) => e.market.toLowerCase()),
    );
    const outstanding = this.ledger
      .outstanding()
      .filter(
        (f) =>
          unknownMarkets.has(f.market.toLowerCase()) &&
          this.pricedTokens.has(f.token.toLowerCase()),
      );
    // Capped by what the contract still holds: the net alone would claim value is sitting somewhere
    // it is not, for a contract that forwarded it on.
    const held = await readHeldBalances(
      publicClient,
      outstanding.map((f) => ({ holder: f.market, token: f.token })),
    );
    const strandedUnknown: StrandedHoldingObservation[] = clampToBalances(
      outstanding,
      held,
    ).map((f) => ({
      market: f.market,
      token: f.token,
      amountRaw: f.amountRaw.toString(),
    }));

    // Allowances are read only against tokens the agent could actually lose: the run's priced set.
    const allowancePairs = entries.flatMap((e) =>
      [...this.pricedTokens].map((token) => ({
        spender: e.market,
        token: token as Address,
      })),
    );
    const allowances =
      allowancePairs.length === 0
        ? []
        : await readAllowances(publicClient, this.agent, allowancePairs).catch(
            () => [],
          );

    return {
      address: this.registry,
      entries: entries.map((entry) =>
        entryObservation(entry, {
          agent: this.agent,
          codehashNow: codehashes[entry.market.toLowerCase()],
          oracleOwner: oracleOwners[entry.oracle.toLowerCase()],
        }),
      ),
      allowances: allowances.map((a) => ({
        spender: a.spender,
        token: a.token,
        amount: a.amount.toString(),
        unlimited: a.amount >= UNLIMITED_ALLOWANCE_THRESHOLD,
      })),
      strandedUnknown,
      dropped: droppedEntries,
    };
  }
}
