// GMX insolvent closes, and who pays for them (cross-margin per account and market).
//
// GMX v2 lets a position be closed with a loss larger than its collateral only on a liquidation
// (DecreasePositionCollateralUtils: `isInsolventCloseAllowed`). The pool absorbs the rest and says so
// in an `InsolventClose` event. The GM pool is not a participant, so nobody's score paid it: a long
// and a short of the same size, both at 20x, lost at most the losing leg's collateral while the
// winning leg kept all of its PnL. On spike#101 (150 blocks), $24k of USDC collateral in a 19.5x
// straddle scored P = +51,411 against noop's +6,799.
//
// The rule (charged in the boundary values, so P = V_K - V_0 carries it):
//
//   At boundary B, for each account and market,
//     charge = min(S, max(0, W))
//   S = the shortfalls GMX reported on that account's liquidations in that market at blocks <= B
//       (`remainingCostUsd` of each InsolventClose).
//   W = the PnL of the account's *opposite-side* positions in that market whose life overlapped one
//       of those insolvent positions' life: realised (`basePnlUsd` of every PositionDecrease at or
//       before B) plus unrealised at B (the same base PnL, if the position is still open).
//
// So a one-sided position keeps the limited liability it has on chain (W = 0), and a straddle's
// winning leg pays its losing leg's shortfall up to what it won. Closing the winner does not reopen
// the hole: its realised PnL stays in W. A position opened only after the liquidation does not
// count (its life does not overlap), so the debt does not follow the account into an unrelated trade.
//
// The ledger is pure bookkeeping over decoded EventEmitter logs; the caller fetches the logs (the
// live scorer every block, the post-run sweep before each cross-section) and feeds them in order.
// Both readers ingest the same logs and read the same unrealised PnL at B, so the two series agree.
import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";

const keyValue = (type: string) =>
  ({
    type: "tuple",
    components: [
      {
        name: "items",
        type: "tuple[]",
        components: [
          { name: "key", type: "string" },
          { name: "value", type },
        ],
      },
      {
        name: "arrayItems",
        type: "tuple[]",
        components: [
          { name: "key", type: "string" },
          { name: "value", type: `${type}[]` },
        ],
      },
    ],
  }) as const;

// EventUtils.EventLogData (gmx-synthetics contracts/event/EventUtils.sol).
const eventLogData = {
  name: "eventData",
  type: "tuple",
  components: [
    { name: "addressItems", ...keyValue("address") },
    { name: "uintItems", ...keyValue("uint256") },
    { name: "intItems", ...keyValue("int256") },
    { name: "boolItems", ...keyValue("bool") },
    { name: "bytes32Items", ...keyValue("bytes32") },
    { name: "bytesItems", ...keyValue("bytes") },
    { name: "stringItems", ...keyValue("string") },
  ],
} as const;

/** EventEmitter's three general-purpose events (contracts/event/EventEmitter.sol). */
export const gmxEventEmitterAbi = [
  {
    type: "event",
    name: "EventLog",
    inputs: [
      { name: "msgSender", type: "address", indexed: false },
      { name: "eventName", type: "string", indexed: false },
      { name: "eventNameHash", type: "string", indexed: true },
      eventLogData,
    ],
  },
  {
    type: "event",
    name: "EventLog1",
    inputs: [
      { name: "msgSender", type: "address", indexed: false },
      { name: "eventName", type: "string", indexed: false },
      { name: "eventNameHash", type: "string", indexed: true },
      { name: "topic1", type: "bytes32", indexed: true },
      eventLogData,
    ],
  },
  {
    type: "event",
    name: "EventLog2",
    inputs: [
      { name: "msgSender", type: "address", indexed: false },
      { name: "eventName", type: "string", indexed: false },
      { name: "eventNameHash", type: "string", indexed: true },
      { name: "topic1", type: "bytes32", indexed: true },
      { name: "topic2", type: "bytes32", indexed: true },
      eventLogData,
    ],
  },
] as const;

/** topics[1] of an EventEmitter log is keccak256 of the event's name (an indexed string). */
export const GMX_EVENT_NAME_HASH = {
  PositionIncrease: keccak256(toBytes("PositionIncrease")),
  PositionDecrease: keccak256(toBytes("PositionDecrease")),
  InsolventClose: keccak256(toBytes("InsolventClose")),
} as const;

/** The topics[1] values the ledger reads, for a getLogs filter. */
export const GMX_LEDGER_NAME_HASHES: Hex[] = Object.values(GMX_EVENT_NAME_HASH);

/** One EventEmitter log, flattened: items by key, per type. Array items are not kept. */
export type GmxEventLog = {
  name: string;
  address: Record<string, Address>;
  uint: Record<string, bigint>;
  int: Record<string, bigint>;
  bool: Record<string, boolean>;
  bytes32: Record<string, Hex>;
  string: Record<string, string>;
};

type RawLog = { topics: readonly Hex[]; data: Hex };

/** Decode an EventEmitter log, or null when it is not one of EventLog/EventLog1/EventLog2. */
export function decodeGmxEventLog(log: RawLog): GmxEventLog | null {
  let decoded: { args: unknown };
  try {
    decoded = decodeEventLog({
      abi: gmxEventEmitterAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    }) as { args: unknown };
  } catch {
    return null;
  }
  const args = decoded.args as {
    eventName: string;
    eventData: Record<
      string,
      { items: ReadonlyArray<{ key: string; value: unknown }> }
    >;
  };
  const items = <T>(group: string): Record<string, T> =>
    Object.fromEntries(
      (args.eventData[group]?.items ?? []).map((i) => [i.key, i.value as T]),
    );
  return {
    name: args.eventName,
    address: items<Address>("addressItems"),
    uint: items<bigint>("uintItems"),
    int: items<bigint>("intItems"),
    bool: items<boolean>("boolItems"),
    bytes32: items<Hex>("bytes32Items"),
    string: items<string>("stringItems"),
  };
}

/** Position.getPositionKey: keccak256(abi.encode(account, market, collateralToken, isLong)). */
export function gmxPositionKey(
  account: Address,
  market: Address,
  collateralToken: Address,
  isLong: boolean,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
      ],
      [account, market, collateralToken, isLong],
    ),
  );
}

// USD at 30 decimals to a number, through the integer part first so whole dollars stay exact.
const toUsd = (v: bigint): number => Number(v / 10n ** 18n) / 1e12;

/** A log as getLogs returns it, with what ordering and grouping need. */
export type GmxLedgerLog = RawLog & {
  blockNumber: bigint | number | null;
  logIndex: number | null;
  transactionHash: Hex | null;
};

/** A liquidation GMX closed below zero, matched to its position. */
export type GmxInsolventClose = {
  account: Address;
  market: Address;
  collateralToken: Address;
  isLong: boolean;
  positionKey: Hex;
  orderKey: Hex;
  blockNumber: number;
  transactionHash: Hex;
  /** InsolventClose.remainingCostUsd: what the collateral did not cover, in USD. */
  shortfallUsd: number;
  /** InsolventClose.basePnlUsd, in USD. */
  basePnlUsd: number;
  /** The GMX step the collateral ran out at ("pnl", "fees", ...). */
  step: string;
  /** First block of the closed position's life; null = opened before the ledger began. */
  openedAt: number | null;
};

// One life of a position key: from the increase that opened it to the decrease that closed it.
type Life = {
  positionKey: Hex;
  account: string; // lowercase
  market: string; // lowercase
  isLong: boolean;
  /** null: open before the ledger's first block (its open is earlier than anything recorded). */
  open: number | null;
  close: number | null;
  realised: Array<[block: number, usd: number]>;
};

/** Serializable ledger state (period resume). */
export type GmxInsolvencyLedgerState = {
  lives: Life[];
  shortfalls: GmxInsolventClose[];
};

/** A position open at the boundary, with its base PnL there (USD). */
export type GmxOpenPositionPnl = {
  account: Address;
  market: Address;
  collateralToken: Address;
  isLong: boolean;
  basePnlUsd: number;
};

export type GmxShortfallCharge = {
  /** What is deducted from the account's value at this boundary. */
  chargedUsd: number;
  /** All shortfalls of the account's liquidations so far. */
  shortfallUsd: number;
  /** The opposite legs' PnL the charge was capped by (summed over markets, floored at 0 each). */
  coverUsd: number;
};

const lc = (a: string): string => a.toLowerCase();
const accountMarket = (account: string, market: string): string =>
  `${lc(account)}|${lc(market)}`;

const overlaps = (
  life: Pick<Life, "open" | "close">,
  from: number | null,
  to: number,
): boolean =>
  (life.open === null || life.open <= to) &&
  (life.close === null || from === null || life.close >= from);

export class GmxInsolvencyLedger {
  // positionKey -> lives, oldest first.
  private readonly lives = new Map<string, Life[]>();
  private readonly shortfalls: GmxInsolventClose[] = [];

  /**
   * @param accounts Only these accounts are recorded (lowercased). Omit to record every account.
   */
  constructor(private readonly accounts?: Set<string>) {}

  private tracked(account: string): boolean {
    return !this.accounts || this.accounts.has(lc(account));
  }

  /** Record another account (an agent registered mid-period). Its earlier events are not replayed. */
  track(account: Address): void {
    this.accounts?.add(lc(account));
  }

  /**
   * Feed logs from the GMX EventEmitter, in chain order. Every log of a transaction must arrive in
   * the same call (a getLogs over whole blocks guarantees it): an InsolventClose names only its
   * order, and the account comes from the PositionDecrease of the same order in the same tx.
   * Returns the insolvent closes recorded by this call.
   */
  ingest(logs: readonly GmxLedgerLog[]): GmxInsolventClose[] {
    const sorted = [...logs].sort((a, b) => {
      const ba = Number(a.blockNumber ?? 0);
      const bb = Number(b.blockNumber ?? 0);
      return ba !== bb ? ba - bb : (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });
    // tx|orderKey -> the half seen first.
    const pendingInsolvent = new Map<string, GmxEventLog>();
    const pendingDecrease = new Map<
      string,
      { event: GmxEventLog; life: Life | null }
    >();
    const out: GmxInsolventClose[] = [];
    for (const log of sorted) {
      const event = decodeGmxEventLog(log);
      if (!event) continue;
      const block = Number(log.blockNumber ?? 0);
      const tx = (log.transactionHash ?? "0x") as Hex;
      if (event.name === "PositionIncrease") {
        this.onIncrease(event, block);
      } else if (event.name === "PositionDecrease") {
        const life = this.onDecrease(event, block);
        const orderKey = event.bytes32.orderKey;
        const key = `${tx}|${orderKey}`;
        const insolvent = pendingInsolvent.get(key);
        if (insolvent) {
          pendingInsolvent.delete(key);
          const rec = this.recordInsolvent(insolvent, event, life, block, tx);
          if (rec) out.push(rec);
        } else pendingDecrease.set(key, { event, life });
      } else if (event.name === "InsolventClose") {
        const key = `${tx}|${event.bytes32.orderKey}`;
        const decrease = pendingDecrease.get(key);
        if (decrease) {
          pendingDecrease.delete(key);
          const rec = this.recordInsolvent(
            event,
            decrease.event,
            decrease.life,
            block,
            tx,
          );
          if (rec) out.push(rec);
        } else pendingInsolvent.set(key, event);
      }
    }
    return out;
  }

  private current(positionKey: string): Life | undefined {
    const list = this.lives.get(lc(positionKey));
    const last = list?.at(-1);
    return last && last.close === null ? last : undefined;
  }

  private newLife(event: GmxEventLog, open: number | null): Life {
    const positionKey = event.bytes32.positionKey;
    const life: Life = {
      positionKey,
      account: lc(event.address.account),
      market: lc(event.address.market),
      isLong: event.bool.isLong,
      open,
      close: null,
      realised: [],
    };
    const k = lc(positionKey);
    const list = this.lives.get(k) ?? [];
    list.push(life);
    this.lives.set(k, list);
    return life;
  }

  private onIncrease(event: GmxEventLog, block: number): void {
    if (!this.tracked(event.address.account)) return;
    const live = this.current(event.bytes32.positionKey);
    if (live) return;
    // sizeInUsd is the size after the increase: equal to the delta means it opened here; larger
    // means the position was open before anything the ledger saw.
    const fresh = event.uint.sizeInUsd === event.uint.sizeDeltaUsd;
    this.newLife(event, fresh ? block : null);
  }

  private onDecrease(event: GmxEventLog, block: number): Life | null {
    if (!this.tracked(event.address.account)) return null;
    const life =
      this.current(event.bytes32.positionKey) ?? this.newLife(event, null);
    life.realised.push([block, toUsd(event.int.basePnlUsd ?? 0n)]);
    // sizeInUsd is the size after the decrease.
    if (event.uint.sizeInUsd === 0n) life.close = block;
    return life;
  }

  private recordInsolvent(
    insolvent: GmxEventLog,
    decrease: GmxEventLog,
    life: Life | null,
    block: number,
    tx: Hex,
  ): GmxInsolventClose | null {
    if (!life) return null; // an account the ledger does not track
    const rec: GmxInsolventClose = {
      account: decrease.address.account,
      market: decrease.address.market,
      collateralToken: decrease.address.collateralToken,
      isLong: decrease.bool.isLong,
      positionKey: decrease.bytes32.positionKey,
      orderKey: insolvent.bytes32.orderKey,
      blockNumber: block,
      transactionHash: tx,
      shortfallUsd: toUsd(insolvent.uint.remainingCostUsd ?? 0n),
      basePnlUsd: toUsd(insolvent.int.basePnlUsd ?? 0n),
      step: insolvent.string.step ?? "",
      openedAt: life.open,
    };
    this.shortfalls.push(rec);
    return rec;
  }

  /** Every insolvent close recorded, in order. */
  insolventCloses(): readonly GmxInsolventClose[] {
    return this.shortfalls;
  }

  /**
   * The charge at boundary `block`, per account (lowercase address). Only events at blocks <= `block`
   * count, so a ledger that has already read past the boundary (the live scorer syncs every block)
   * answers for the boundary. `open` is every position open at the boundary with its base PnL there;
   * a position missing from it is taken as closed.
   */
  chargesAt(
    block: number,
    open: readonly GmxOpenPositionPnl[],
  ): Map<string, GmxShortfallCharge> {
    const out = new Map<string, GmxShortfallCharge>();
    const byAccountMarket = new Map<string, GmxInsolventClose[]>();
    for (const s of this.shortfalls) {
      if (s.blockNumber > block) continue;
      const k = accountMarket(s.account, s.market);
      const list = byAccountMarket.get(k) ?? [];
      list.push(s);
      byAccountMarket.set(k, list);
    }
    if (byAccountMarket.size === 0) return out;

    const openPnl = new Map<string, number>();
    for (const p of open)
      openPnl.set(
        lc(gmxPositionKey(p.account, p.market, p.collateralToken, p.isLong)),
        p.basePnlUsd,
      );

    for (const [k, shortfalls] of byAccountMarket) {
      const [account, market] = k.split("|");
      const shortfallUsd = shortfalls.reduce((n, s) => n + s.shortfallUsd, 0);
      // The opposite-side lives of this account and market that overlap any insolvent life.
      let cover = 0;
      const counted = new Set<Life>();
      const openKeysSeen = new Set<string>();
      for (const s of shortfalls) {
        for (const [positionKey, lives] of this.lives) {
          for (const life of lives) {
            if (counted.has(life)) continue;
            if (life.account !== account || life.market !== market) continue;
            if (life.isLong === s.isLong) continue;
            // A life the boundary has not reached yet does not exist here.
            if (life.open !== null && life.open > block) continue;
            const closedBy =
              life.close !== null && life.close <= block ? life.close : null;
            if (!overlaps({ open: life.open, close: closedBy }, s.openedAt, s.blockNumber))
              continue;
            counted.add(life);
            for (const [b, usd] of life.realised) if (b <= block) cover += usd;
            if (closedBy === null) {
              openKeysSeen.add(positionKey);
              cover += openPnl.get(positionKey) ?? 0;
            }
          }
        }
        // An opposite position open at the boundary that the ledger never saw an event for: it was
        // opened before the ledger began and has not been touched since, so it was open across the
        // whole insolvent life.
        for (const p of open) {
          if (lc(p.account) !== account || lc(p.market) !== market) continue;
          if (p.isLong === s.isLong) continue;
          const key = lc(
            gmxPositionKey(p.account, p.market, p.collateralToken, p.isLong),
          );
          if (openKeysSeen.has(key) || this.lives.has(key)) continue;
          openKeysSeen.add(key);
          cover += p.basePnlUsd;
        }
      }
      const coverUsd = Math.max(0, cover);
      const prev = out.get(account) ?? {
        chargedUsd: 0,
        shortfallUsd: 0,
        coverUsd: 0,
      };
      out.set(account, {
        chargedUsd: prev.chargedUsd + Math.min(shortfallUsd, coverUsd),
        shortfallUsd: prev.shortfallUsd + shortfallUsd,
        coverUsd: prev.coverUsd + coverUsd,
      });
    }
    return out;
  }

  /**
   * Forget what can no longer matter once every boundary to be asked about is past `block`: a
   * closed life that overlaps no recorded shortfall's life and cannot overlap a future one (it
   * closed before every opposite position still open had opened). Keeps a month-long period's
   * ledger the size of its open positions plus its insolvent closes.
   */
  prune(block: number): void {
    for (const [key, lives] of this.lives) {
      const keep = lives.filter((life) => {
        if (life.close === null || life.close > block) return true;
        const am = accountMarket(life.account, life.market);
        for (const s of this.shortfalls) {
          if (accountMarket(s.account, s.market) !== am) continue;
          if (s.isLong === life.isLong) continue;
          if (overlaps(life, s.openedAt, s.blockNumber)) return true;
        }
        for (const other of this.lives.values()) {
          const o = other.at(-1);
          if (!o || o.close !== null) continue;
          if (o.account !== life.account || o.market !== life.market) continue;
          if (o.isLong === life.isLong) continue;
          if (o.open === null || o.open <= life.close) return true;
        }
        return false;
      });
      if (keep.length === 0) this.lives.delete(key);
      else if (keep.length !== lives.length) this.lives.set(key, keep);
    }
  }

  snapshot(): GmxInsolvencyLedgerState {
    return {
      lives: [...this.lives.values()].flat().map((l) => ({
        ...l,
        realised: l.realised.map(([b, u]) => [b, u] as [number, number]),
      })),
      shortfalls: this.shortfalls.map((s) => ({ ...s })),
    };
  }

  restore(state: GmxInsolvencyLedgerState): void {
    this.lives.clear();
    this.shortfalls.length = 0;
    for (const life of state.lives) {
      const k = lc(life.positionKey);
      const list = this.lives.get(k) ?? [];
      list.push({
        ...life,
        realised: life.realised.map(([b, u]) => [b, u] as [number, number]),
      });
      this.lives.set(k, list);
    }
    this.shortfalls.push(...state.shortfalls.map((s) => ({ ...s })));
  }
}
