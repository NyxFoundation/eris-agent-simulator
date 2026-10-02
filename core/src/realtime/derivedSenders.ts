// Attribution of transactions sent from addresses an agent's wallet funded (issue #212).
//
// blocks.csv attributes a mined transaction by its sender: an agent's registered wallet, a flow or
// system wallet, or -- for a sender the run does not know -- `external`, which nothing scores or
// rule-checks. An agent that moved ETH or tokens from its wallet to a second EOA and sent from there
// had therefore stepped out of all three post-run checks (the fee rule, the gas budget, the
// unlogged-tx reconciliation). The gateway holds every sender to the fee rule and the per-tx gas cap
// at the entrance, so what was open was the per-agent-per-block gas sum, the reconciliation, and
// any setup where a participant reaches the node directly.
//
// This ledger follows the value. Every mined transaction whose sender belongs to an agent -- the
// registered wallet, or an address already derived from it -- is inspected for what it handed out:
// ETH (`value`), a contract it created, and transfers of the tokens the run prices (ERC-20 Transfer
// logs). Each recipient the run does not otherwise know becomes a *derived sender* of that agent,
// transitively, and a transaction it later sends is recorded under the agent (role `agent`, with
// `derivedFrom` naming the address that funded it), so every reader of blocks.csv sees it as the
// agent's. The coordinator keeps this ledger while it writes blocks.csv, block by block, in order.
//
// What it deliberately does not do:
//   - Follow a Transfer whose `from` is the agent but whose transaction somebody else sent. An
//     allowance pulled by another participant's contract moves the victim's tokens, and attributing
//     the puller's EOA to the victim would let anyone pin a violation on anyone. Only transactions
//     the agent (or its derived senders) sent propagate.
//   - Trust Transfer logs from tokens the run does not price. A contract can emit any log it likes,
//     so a fake token's `Transfer(victim, attacker)` is evidence of nothing.
//   - See ETH forwarded inside a call (a contract paying out). That needs traces; the token path
//     through a contract is visible in logs and is followed.
// It is a report with a mechanism behind it, not a verdict: the operator reads the flag (rules §8).
import { toEventSelector } from "viem";

export const ERC20_TRANSFER_TOPIC = toEventSelector(
  "Transfer(address,address,uint256)",
);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type DerivedSender = {
  // Lowercase.
  address: string;
  // The agent it is attributed to.
  ownerId: string;
  // Lowercase address of the hop that funded it: the agent's wallet, another derived sender, or a
  // contract one of them created.
  fundedBy: string;
  fundedAtBlock: number;
  via: "eth" | "token" | "create";
  // Mined transactions sent from this address once it was derived. A recipient that never sends
  // (a venue contract paid an execution fee, say) stays at zero and is not reported.
  txCount: number;
};

// What the ledger needs of a mined transaction: the block fetch and the receipt already carry it.
export type MinedTxFacts = {
  from: string;
  to: string | null | undefined;
  value: bigint;
  blockNumber: number;
  contractAddress?: string | null;
  logs: ReadonlyArray<{
    address: string;
    topics: readonly string[];
    data?: string;
  }>;
};

export type DerivedSenderLedgerOptions = {
  // The agent a registered wallet belongs to; undefined for every other address.
  agentOf: (address: string) => string | undefined;
  // Any address the run knows (agent, flow, system wallets). Never derived from anyone.
  isKnown: (address: string) => boolean;
  // Lowercase addresses of the tokens whose Transfer logs count as value moving. Called lazily, on
  // the first transaction, so the set can depend on protocol state that is settled by then.
  trackedTokens: () => ReadonlySet<string>;
};

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export class DerivedSenderLedger {
  private readonly derived = new Map<string, DerivedSender>();
  private tokens: ReadonlySet<string> | undefined;

  constructor(private readonly opts: DerivedSenderLedgerOptions) {}

  // The record for a sender derived from an agent, if it is one. Consulted for a sender the run does
  // not know, before the row is written as `external`.
  senderOf(from: string): DerivedSender | undefined {
    return this.derived.get(from.toLowerCase());
  }

  // Which agent an address belongs to: its registered wallet, or the agent it was derived from.
  ownerOf(address: string): string | undefined {
    const a = address.toLowerCase();
    return this.opts.agentOf(a) ?? this.derived.get(a)?.ownerId;
  }

  // Record what a mined transaction sent by `ownerId` -- from its wallet or from a derived sender --
  // handed out. The caller has already decided the row belongs to `ownerId`.
  observe(tx: MinedTxFacts, ownerId: string): void {
    const from = tx.from.toLowerCase();
    const sender = this.derived.get(from);
    if (sender) sender.txCount++;
    if (tx.value > 0n && tx.to) this.fund(tx.to, from, ownerId, "eth", tx.blockNumber);
    if (tx.contractAddress)
      this.fund(tx.contractAddress, from, ownerId, "create", tx.blockNumber);
    this.tokens ??= this.opts.trackedTokens();
    for (const log of tx.logs) {
      if (!this.tokens.has(log.address.toLowerCase())) continue;
      // Three topics = a fungible Transfer (ERC-721 shares topic0 and adds a fourth).
      if (log.topics.length !== 3 || log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
      if (!transferredSomething(log.data)) continue;
      const src = topicAddress(log.topics[1]);
      // The tokens have to be leaving this agent's own holdings: its wallet, a sender derived from
      // it, or a contract it created. A transfer out of somebody else's balance inside this
      // transaction (a swap's pool leg) says nothing about who the recipient is.
      if (this.ownerOf(src) !== ownerId) continue;
      this.fund(topicAddress(log.topics[2]), src, ownerId, "token", tx.blockNumber);
    }
  }

  private fund(
    recipient: string,
    fundedBy: string,
    ownerId: string,
    via: DerivedSender["via"],
    blockNumber: number,
  ): void {
    const to = recipient.toLowerCase();
    if (to === ZERO_ADDRESS || to === fundedBy) return;
    if (this.opts.isKnown(to) || this.derived.has(to)) return;
    this.derived.set(to, {
      address: to,
      ownerId,
      fundedBy,
      fundedAtBlock: blockNumber,
      via,
      txCount: 0,
    });
  }

  // Every derived address -> its agent, including recipients that never sent anything. For the
  // post-run checks, which may meet a row written as `external` before the funding was seen (a
  // zero-fee transaction needs no ETH, so a second EOA can send before it is funded).
  ownerByAddress(): Map<string, string> {
    return new Map([...this.derived.values()].map((d) => [d.address, d.ownerId]));
  }

  // The derived senders that actually sent, grouped by agent: the flag.
  byOwner(): Record<string, DerivedSender[]> {
    const out: Record<string, DerivedSender[]> = {};
    for (const d of this.derived.values()) {
      if (d.txCount === 0) continue;
      (out[d.ownerId] ??= []).push({ ...d });
    }
    return out;
  }
}

function transferredSomething(data: string | undefined): boolean {
  if (!data || data === "0x") return false;
  try {
    return BigInt(data) > 0n;
  } catch {
    return false;
  }
}
