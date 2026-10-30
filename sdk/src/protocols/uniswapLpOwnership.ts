// Which of an agent's Uniswap V3 position NFTs are its own: the ones its value counts and its
// observation lists.
//
// The scorer used to enumerate what an address holds (NonfungiblePositionManager
// .tokenOfOwnerByIndex) and value the first LP_POSITIONS_LIMIT. But anyone can `mint` a position
// with `recipient = <someone else>` or transfer one to them, and the NPM keeps a holder's tokens in
// insertion order (OZ EnumerableSet, swap-and-pop on removal). An attacker who minted
// LP_POSITIONS_LIMIT dust positions to a rival early in the epoch pushed every position the rival
// opened afterwards past the bound, where it scored 0 at the bell -- for ~128 x 0.4M gas at tip 0 --
// while the rival's own observation, which enumerated without a bound, showed nothing wrong and
// paid two reads or more per spam NFT every block. ERC-721 transfers are outside the roster-transfer
// scan, so nothing was flagged.
//
// The rule: **a position counts for an agent when the agent obtained it itself** -- the NPM's
// Transfer(from, to = agent, tokenId) was emitted in a transaction the agent sent (tx.from = agent).
// A mint it sent, a transfer it pulled as an approved operator, a position a contract minted to it
// inside a call it made: each is the agent's own action. A position minted to it or sent to it in
// anyone else's transaction is neither valued nor listed, and is reported (`uniswap-lp-received`):
// counting it would let a third party decide what an agent holds -- push its positions past the
// bound, or hand it a gift paired with the giver's own token and drain it during the epoch. A
// position the agent sends away stops counting for it either way, so no NFT moves value between
// two agents.
//
// The ledger is pure bookkeeping over Transfer logs that the caller has already resolved to their
// transaction's sender (readLpTransfers below). Two readers feed it the same logs -- the live scorer
// every block, the post-run sweep once over the window -- and ask it at each boundary B for the
// positions held at B, so both value the same set (`interval_series_agreement`). Holdings carry the
// blocks they were held between, the way the GMX insolvency ledger's lives do
// (protocols/gmxInsolvency.ts), so a ledger that has read past B still answers for B.
//
// Read cost does not grow with what other addresses send: the valued set is at most
// LP_POSITIONS_LIMIT ids per agent, and syncing is one getLogs per direction per chunk plus one
// block (with its transactions) per block in which an agent *received* a position -- bounded by the
// chain's blocks, not by how many NFTs arrive in them.
import {
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  nonfungiblePositionManagerAbi,
  nonfungiblePositionManagerEventsAbi,
} from "../abis.js";
import { UNISWAP } from "../constants.js";

// The most LP NFTs one agent's valuation reads at a boundary (issue #196). The count is the agent's
// own to raise -- minting a position costs it gas and nothing else -- and each one is two reads
// (ownerOf, positions) plus its pool's state, at every boundary and at every block of the median
// window. Past the bound the positions are not read and the agent is told so in its value
// (`uniswap-lp-unscanned`, like `lending-unscanned`), rather than the field paying for them. 128
// holds every reference strategy many times over; the same figure as USER_MARKET_LIMIT. Since the
// ownership rule the bound counts only positions the agent obtained itself: nobody else can fill it.
export const LP_POSITIONS_LIMIT = 128;

// How many of its own positions the ledger tracks by id per agent. Beyond LP_POSITIONS_LIMIT so that
// an agent which went over the bound and closed some gets the next ones valued (they move up, as
// they did when the bound cut an enumeration); beyond this, further acquisitions are only counted,
// which keeps a month-long period's checkpoint the size of the field rather than of one agent's gas.
export const LP_OWN_TRACK_LIMIT = 8 * LP_POSITIONS_LIMIT;

// One getLogs per this many blocks while catching up (gmxShortfall.ts uses the same).
const LOG_CHUNK_BLOCKS = 2_000;
// Blocks fetched at once to resolve the senders of received positions.
const BLOCK_FETCH_CONCURRENCY = 16;

const lc = (a: string): string => a.toLowerCase();

/** One NPM Transfer, with the sender of the transaction it was emitted in. */
export type LpTransfer = {
  from: Address;
  to: Address;
  tokenId: bigint | string;
  blockNumber: number;
  logIndex: number;
  /**
   * tx.from of the transaction. Needed only when `to` is a tracked account; null (unknown) makes the
   * arrival someone else's doing, which is the conservative reading.
   */
  txFrom: Address | null;
};

type Holding = {
  tokenId: string;
  /** First block it was held at; null = held when the ledger began tracking the account. */
  from: number | null;
  /** Block it left the account at; null = still held. Held at B iff from <= B < until. */
  until: number | null;
};

type AccountState = {
  /** Positions the account obtained itself, in chain order. At most LP_OWN_TRACK_LIMIT held. */
  own: Holding[];
  /**
   * Held when the ledger began tracking the account, provenance unknown (a checkpoint from before
   * the ledger, an agent registered mid-period, positions from before the window). At most
   * LP_POSITIONS_LIMIT, and valued after every `own` one, so a holding seeded here never displaces
   * a position the account is known to have obtained itself.
   */
  seeded: Holding[];
  /** Own acquisitions past LP_OWN_TRACK_LIMIT: counted, not tracked by id. [block, +1 | -1]. */
  overflow: Array<[number, number]>;
  /** overflow entries already folded by prune(). */
  overflowBase: number;
};

/** Serializable ledger state (period resume). */
export type LpOwnershipLedgerState = {
  accounts: Record<string, AccountState>;
};

/** What the ledger says an account holds at a block. */
export type LpHeldAt = {
  /** The positions to value: own first (in the order obtained), then seeded; at most the bound. */
  tokenIds: bigint[];
  /** Own positions held at the block (tracked by id). */
  heldOwn: number;
  /** Seeded positions held at the block. */
  heldSeeded: number;
  /** Own positions held at the block beyond LP_OWN_TRACK_LIMIT (counted only). */
  ownOverflow: number;
};

const held = (h: Holding, block: number): boolean =>
  (h.from === null || h.from <= block) && (h.until === null || h.until > block);

export class LpOwnershipLedger {
  private readonly state = new Map<string, AccountState>();
  // account -> tokenId -> the holding still open (until null), own or seeded. Derived, not
  // serialized: it keeps release() and the track limit constant-time however long the list grows
  // between prunes (the post-run sweep never prunes).
  private readonly open = new Map<string, Map<string, Holding>>();
  // account -> how many of the open holdings are own (tracked by id).
  private readonly openOwn = new Map<string, number>();

  constructor(accounts: Iterable<Address> = []) {
    for (const a of accounts) this.track(a);
  }

  private index(account: string): Map<string, Holding> {
    let m = this.open.get(account);
    if (!m) {
      m = new Map();
      this.open.set(account, m);
    }
    return m;
  }

  /** Record another account. Idempotent. Its holdings so far come from seed(). */
  track(account: Address): void {
    const k = lc(account);
    if (!this.state.has(k))
      this.state.set(k, { own: [], seeded: [], overflow: [], overflowBase: 0 });
  }

  tracks(account: Address): boolean {
    return this.state.has(lc(account));
  }

  accounts(): Address[] {
    return [...this.state.keys()] as Address[];
  }

  /** What the account held when the ledger began tracking it (bounded by the caller). */
  seed(account: Address, tokenIds: ReadonlyArray<bigint | string>): void {
    this.track(account);
    const k = lc(account);
    const s = this.state.get(k) as AccountState;
    const index = this.index(k);
    for (const h of s.seeded) if (h.until === null) index.delete(h.tokenId);
    s.seeded = [];
    for (const id of tokenIds.slice(0, LP_POSITIONS_LIMIT)) {
      const tokenId = id.toString();
      if (index.has(tokenId)) continue; // already known as its own
      const h: Holding = { tokenId, from: null, until: null };
      s.seeded.push(h);
      index.set(tokenId, h);
    }
  }

  /**
   * Feed Transfer logs of the position manager, in chain order across calls. Within a call they are
   * sorted by (block, logIndex), so the caller may concatenate two filtered queries.
   */
  ingest(transfers: readonly LpTransfer[]): void {
    const sorted = [...transfers].sort((a, b) =>
      a.blockNumber !== b.blockNumber
        ? a.blockNumber - b.blockNumber
        : a.logIndex - b.logIndex,
    );
    for (const t of sorted) {
      const id = t.tokenId.toString();
      const from = lc(t.from);
      if (this.state.has(from)) this.release(from, id, t.blockNumber);
      const to = lc(t.to);
      // Arrived in a transaction the recipient sent: its own. Otherwise someone else's doing, and
      // nothing is recorded -- the boundary's balanceOf counts it as received.
      if (this.state.has(to) && t.txFrom !== null && lc(t.txFrom) === to)
        this.acquire(to, id, t.blockNumber);
    }
  }

  private release(account: string, tokenId: string, block: number): void {
    const s = this.state.get(account) as AccountState;
    const index = this.index(account);
    const h = index.get(tokenId);
    if (h) {
      h.until = block;
      index.delete(tokenId);
      // Own holdings start at a block; seeded ones (from null) do not count toward the track limit.
      if (h.from !== null)
        this.openOwn.set(account, (this.openOwn.get(account) ?? 1) - 1);
      return;
    }
    // Not tracked by id: an own position past LP_OWN_TRACK_LIMIT, or one that was never the
    // account's own. Which of the two cannot be told without tracking every id, so a counted own
    // overflow is taken down first; the split only moves between the two reports, neither of which
    // is valued.
    if (this.overflowNow(s) > 0) s.overflow.push([block, -1]);
  }

  private acquire(account: string, tokenId: string, block: number): void {
    const s = this.state.get(account) as AccountState;
    const tracked = this.openOwn.get(account) ?? 0;
    if (tracked < LP_OWN_TRACK_LIMIT) {
      const h: Holding = { tokenId, from: block, until: null };
      s.own.push(h);
      this.index(account).set(tokenId, h);
      this.openOwn.set(account, tracked + 1);
    } else s.overflow.push([block, 1]);
  }

  private overflowNow(s: AccountState): number {
    return s.overflow.reduce((n, [, d]) => n + d, s.overflowBase);
  }

  /**
   * The account's holdings at `block`: only transfers at blocks <= `block` count, so a ledger that
   * has read past the boundary (the live scorer syncs every block) answers for the boundary.
   * Undefined for an account the ledger does not track.
   */
  heldAt(account: Address, block: number): LpHeldAt | undefined {
    const s = this.state.get(lc(account));
    if (!s) return undefined;
    const own = s.own.filter((h) => held(h, block));
    const seeded = s.seeded.filter((h) => held(h, block));
    const ownOverflow =
      s.overflowBase +
      s.overflow.reduce((n, [b, d]) => (b <= block ? n + d : n), 0);
    return {
      tokenIds: [...own, ...seeded]
        .slice(0, LP_POSITIONS_LIMIT)
        .map((h) => BigInt(h.tokenId)),
      heldOwn: own.length,
      heldSeeded: seeded.length,
      ownOverflow: Math.max(0, ownOverflow),
    };
  }

  /**
   * Forget what no boundary after `block` can ask about: holdings released at or before it, and the
   * overflow counts up to it (folded into a base). Every later heldAt(B > block) is unchanged.
   */
  prune(block: number): void {
    for (const s of this.state.values()) {
      s.own = s.own.filter((h) => h.until === null || h.until > block);
      s.seeded = s.seeded.filter((h) => h.until === null || h.until > block);
      const keep: Array<[number, number]> = [];
      for (const [b, d] of s.overflow) {
        if (b <= block) s.overflowBase += d;
        else keep.push([b, d]);
      }
      s.overflow = keep;
    }
  }

  snapshot(): LpOwnershipLedgerState {
    const accounts: Record<string, AccountState> = {};
    for (const [k, s] of this.state)
      accounts[k] = {
        own: s.own.map((h) => ({ ...h })),
        seeded: s.seeded.map((h) => ({ ...h })),
        overflow: s.overflow.map(([b, d]) => [b, d] as [number, number]),
        overflowBase: s.overflowBase,
      };
    return { accounts };
  }

  restore(state: LpOwnershipLedgerState): void {
    this.state.clear();
    this.open.clear();
    this.openOwn.clear();
    for (const [key, s] of Object.entries(state.accounts)) {
      const k = lc(key);
      const restored: AccountState = {
        own: s.own.map((h) => ({ ...h })),
        seeded: s.seeded.map((h) => ({ ...h })),
        overflow: s.overflow.map(([b, d]) => [b, d] as [number, number]),
        overflowBase: s.overflowBase,
      };
      this.state.set(k, restored);
      const index = this.index(k);
      for (const h of [...restored.own, ...restored.seeded])
        if (h.until === null) index.set(h.tokenId, h);
      this.openOwn.set(
        k,
        restored.own.filter((h) => h.until === null).length,
      );
    }
  }
}

const transferEvent = nonfungiblePositionManagerEventsAbi[0];

type DecodedTransferLog = {
  args: { from?: Address; to?: Address; tokenId?: bigint };
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
  removed?: boolean;
};

/**
 * The position manager's Transfer logs into or out of `accounts` over [fromBlock, toBlock], each
 * incoming one resolved to the sender of its transaction. Two filtered queries (the node indexes
 * the topic), then one block with its transactions per block that has an incoming transfer.
 * Throws when a read fails.
 */
export async function readLpTransfers(
  publicClient: PublicClient,
  accounts: readonly Address[],
  fromBlock: number,
  toBlock: number,
): Promise<LpTransfer[]> {
  if (accounts.length === 0 || fromBlock > toBlock) return [];
  const range = { fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) };
  const [incoming, outgoing] = (await Promise.all([
    publicClient.getLogs({
      address: UNISWAP.nonfungiblePositionManager,
      event: transferEvent,
      args: { to: [...accounts] },
      ...range,
      strict: false,
    }),
    publicClient.getLogs({
      address: UNISWAP.nonfungiblePositionManager,
      event: transferEvent,
      args: { from: [...accounts] },
      ...range,
      strict: false,
    }),
  ])) as unknown as [DecodedTransferLog[], DecodedTransferLog[]];
  const tracked = new Set(accounts.map(lc));
  // A transfer between two tracked accounts is in both queries.
  const byPosition = new Map<string, DecodedTransferLog>();
  for (const log of [...incoming, ...outgoing]) {
    if (log.removed || log.blockNumber === null || log.logIndex === null) continue;
    const { from, to, tokenId } = log.args;
    if (from === undefined || to === undefined || tokenId === undefined) continue;
    byPosition.set(`${log.blockNumber}:${log.logIndex}`, log);
  }
  const logs = [...byPosition.values()];

  // tx.from for the blocks where a tracked account received a position.
  const senderBlocks = [
    ...new Set(
      logs
        .filter((l) => tracked.has(lc(l.args.to as Address)))
        .map((l) => l.blockNumber as bigint),
    ),
  ];
  const senderByTx = new Map<string, Address>();
  for (let i = 0; i < senderBlocks.length; i += BLOCK_FETCH_CONCURRENCY) {
    const blocks = await Promise.all(
      senderBlocks.slice(i, i + BLOCK_FETCH_CONCURRENCY).map((blockNumber) =>
        publicClient.getBlock({ blockNumber, includeTransactions: true }),
      ),
    );
    for (const block of blocks)
      for (const tx of block.transactions)
        if (typeof tx !== "string") senderByTx.set(lc(tx.hash), tx.from);
  }

  return logs.map((l) => ({
    from: l.args.from as Address,
    to: l.args.to as Address,
    tokenId: l.args.tokenId as bigint,
    blockNumber: Number(l.blockNumber),
    logIndex: l.logIndex as number,
    txFrom:
      l.transactionHash === null
        ? null
        : (senderByTx.get(lc(l.transactionHash)) ?? null),
  }));
}

/**
 * What `account` holds at `blockNumber` by the holder enumeration, at most LP_POSITIONS_LIMIT: how
 * the ledger is seeded, where it has no logs to go on. Throws when a read fails.
 */
export async function enumerateLpPositions(
  publicClient: PublicClient,
  account: Address,
  blockNumber?: number,
): Promise<{ balance: bigint; tokenIds: bigint[] }> {
  const at =
    blockNumber === undefined ? {} : { blockNumber: BigInt(blockNumber) };
  const balance = (await publicClient.readContract({
    address: UNISWAP.nonfungiblePositionManager,
    abi: nonfungiblePositionManagerAbi,
    functionName: "balanceOf",
    args: [account],
    ...at,
  })) as bigint;
  const n = Math.min(Number(balance), LP_POSITIONS_LIMIT);
  const tokenIds = (await Promise.all(
    Array.from({ length: n }, (_, i) =>
      publicClient.readContract({
        address: UNISWAP.nonfungiblePositionManager,
        abi: nonfungiblePositionManagerAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [account, BigInt(i)],
        ...at,
      }),
    ),
  )) as bigint[];
  return { balance, tokenIds };
}

/** Serializable tracker state (period resume). */
export type LpOwnershipTrackerState = {
  /** Last block whose logs are in the ledger; null = begins at the next sync. */
  scannedThrough: number | null;
  /** Accounts still to be seeded at the next sync. */
  pendingSeed: string[];
  ledger: LpOwnershipLedgerState;
};

/**
 * Feeds the ledger from the chain as it goes past. Each account is seeded once, at the block before
 * the first logs read for it (the holder enumeration, bounded), and followed by its Transfer logs
 * after that. Started with a `fromBlock`, the first logs are that block's; without one, the tracker
 * begins at the first block it is synced to -- the agent runtime's observation, which has no history
 * of its own to go on.
 */
export class LpOwnershipTracker {
  readonly ledger: LpOwnershipLedger;
  private scannedThrough: number | null;
  private readonly pendingSeed = new Set<string>();

  constructor(
    private readonly opts: {
      publicClient: PublicClient;
      accounts: readonly Address[];
      /** First block to read logs from; holdings before it are seeded. Omit: the first sync's. */
      fromBlock?: number;
    },
  ) {
    this.ledger = new LpOwnershipLedger(opts.accounts);
    for (const a of opts.accounts) this.pendingSeed.add(lc(a));
    this.scannedThrough =
      opts.fromBlock === undefined ? null : opts.fromBlock - 1;
  }

  /** Follow another account (an agent registered mid-period), seeded at the next sync. */
  track(account: Address): void {
    if (this.ledger.tracks(account)) return;
    this.ledger.track(account);
    this.pendingSeed.add(lc(account));
  }

  /** Last block whose logs are in the ledger, or null before the first sync. */
  get syncedThrough(): number | null {
    return this.scannedThrough;
  }

  /**
   * Read every Transfer through `block`. Throws when a read fails (and retries it next time). Calls
   * are serialized: two readers sharing one tracker (the runtime's observation and its account
   * value) must not read and ingest the same range twice.
   */
  syncTo(block: number): Promise<void> {
    const run = this.queue.then(() => this.sync(block));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private queue: Promise<unknown> = Promise.resolve();

  private async sync(block: number): Promise<void> {
    if (this.scannedThrough === null) this.scannedThrough = block;
    if (this.pendingSeed.size > 0) await this.seedPending(this.scannedThrough);
    while (this.scannedThrough < block) {
      const from = this.scannedThrough + 1;
      const to = Math.min(block, from + LOG_CHUNK_BLOCKS - 1);
      this.ledger.ingest(
        await readLpTransfers(
          this.opts.publicClient,
          this.ledger.accounts(),
          from,
          to,
        ),
      );
      this.scannedThrough = to;
    }
  }

  // The holder enumeration at `block`, the state the next logs build on. Before genesis there is
  // nothing to hold.
  private async seedPending(block: number): Promise<void> {
    const accounts = [...this.pendingSeed];
    const seeds = await Promise.all(
      accounts.map((account) =>
        block < 0
          ? Promise.resolve({ tokenIds: [] as bigint[] })
          : enumerateLpPositions(
              this.opts.publicClient,
              account as Address,
              block,
            ),
      ),
    );
    accounts.forEach((account, i) => {
      this.ledger.seed(account as Address, seeds[i].tokenIds);
      this.pendingSeed.delete(account);
    });
  }

  /**
   * A practice period resumed from a checkpoint written before this ledger existed. The logs back to
   * the period's start are not kept on a practice node, so the ledger is rebuilt instead: every
   * account is seeded from the holder enumeration at the first block synced after the restart
   * (bounded, provenance unknown), and followed by its logs from there.
   */
  rebuildAtNextSync(): void {
    this.scannedThrough = null;
    for (const a of this.ledger.accounts()) this.pendingSeed.add(lc(a));
  }

  snapshot(): LpOwnershipTrackerState {
    return {
      scannedThrough: this.scannedThrough,
      pendingSeed: [...this.pendingSeed],
      ledger: this.ledger.snapshot(),
    };
  }

  restore(state: LpOwnershipTrackerState): void {
    this.scannedThrough = state.scannedThrough;
    this.ledger.restore(state.ledger);
    this.pendingSeed.clear();
    for (const a of state.pendingSeed) this.pendingSeed.add(lc(a));
    // An account this start tracks that the checkpoint did not (none today: the roster is part of
    // the period) is seeded like a mid-period registration.
    for (const a of this.opts.accounts)
      if (!this.ledger.tracks(a)) this.track(a);
  }
}
