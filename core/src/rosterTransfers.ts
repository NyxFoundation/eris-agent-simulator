// Value moved between registered addresses (issue #208; rules §8).
//
// Rules §8 forbids a participant unit from moving assets between its own two submissions, and the
// scoring makes the incentive concrete: P is per agent, a unit's final score is the higher of its
// two (§2.2), and the population's σ is shared -- so a sacrificial agent that hands its endowment to
// its sibling lifts the sibling's P and compresses everyone else's T at once. Nothing in the trade
// path can refuse it: `rawTx` carries any `to`, any `value`, any calldata, and the environment is
// not supposed to decode a participant's transactions before they land.
//
// So, like the fee cap and the gas budget, this is read off what the chain recorded after the run:
//   eth          a transaction from one registered address to another carrying value
//                (blocks.csv `to` / `valueWei`, from the tx itself)
//   erc20        a Transfer log whose `from` and `to` are both registered addresses
//   contract     two registered addresses with opposite net flows of one token through one
//                participant-created contract (a registry entry whose creator is registered):
//                A put tokens into C, B took them out -- a pool, a vault, a forwarder, a "bug"
//   lending      a registered supplier and a registered borrower of the same participant-created
//                lending market on the SimpleLending singleton (the supplier's USDC is what the
//                borrower walks away with when the collateral is worthless)
//   liquidation  a registered liquidator seizing a registered borrower's collateral in such a market
//
// A report, not a verdict. Two agents of *different* units trading against each other through a
// participant-created venue is the competition working (the hunter draining the leaky vault is the
// Hacker skill, issue #40), and a large direct transfer between strangers is at worst strange; so a
// cross-unit movement is flagged only above a threshold (`run.rosterTransferFlagBps` of the smaller
// endowment of the pair). Between two submissions of the *same* unit any amount is flagged: there
// is no legitimate reason for one to pay the other. Everything found, flagged or not, is written to
// summary.json and events.jsonl; the flagged ones travel into matrix.json as `flags` beside the
// score (scenarioScores.ts), where the operator judges them. Nothing here changes P.
//
// What this cannot see (documented limitations, not oversights):
//   - value that moves inside a contract call (an agent's own contract forwarding ETH with `call`,
//     or an internal CREATE whose contract never reaches the registry): no trace is taken;
//   - a counterparty route through an environment venue -- two agents on opposite sides of a
//     Uniswap pool is ordinary trading, and so it is not a route here;
//   - the practice period's earlier segments: the check runs at the end over the final segment's
//     blocks.csv and the node's retained history, the same window the other post-run checks have.
import { formatUnits } from "viem";
import { BLOCKS_CSV_INDEX } from "./logger.js";

export type RosterAgent = {
  id: string;
  address: string;
  // Rules §2.2: the participant unit. Two agents sharing it are the same unit.
  participant?: string;
  // V_0 in USDC, which sizes the cross-unit threshold. Absent when the run never valued the agent.
  initialValueUsdc?: number;
};

// An ERC-20 Transfer log as viem returns it (sdk/src/agentMarkets.ts TransferLogLike, plus the
// block it landed in). `topics.length === 3` is the ERC-20 shape; ERC-721 shares the topic0 and
// has four.
export type RosterTransferLog = {
  address: string;
  topics: readonly string[];
  args?: { from?: string; to?: string; value?: bigint };
  blockNumber?: bigint | null;
};

// A decoded SimpleLending event over the run window (sdk/src/protocols/lending.ts simpleLendingAbi).
export type LendingEventLike = {
  eventName: string;
  args: {
    id?: string;
    caller?: string;
    assets?: bigint;
    liquidator?: string;
    borrower?: string;
    seizedAssets?: bigint;
  };
  blockNumber?: bigint | null;
};

// A participant-created contract the environment knows (MarketRegistry entry), by lowercase address.
export type RouteContract = { kind: string; creatorId: string };

// A participant-created lending market, by its market id (the registry entry's `extra`).
export type RouteMarket = {
  loanToken: string;
  collateralToken: string;
  creatorId: string;
};

export type TokenPricing = {
  symbol: string;
  decimals: number;
  // USDC per whole token at the run's final marks; null when the scorer has no price for it.
  priceUsdc: number | null;
};

export type RosterPricing = {
  ethUsdc: number;
  // lowercase token address -> pricing. A token absent here is unknown: reported, never valued.
  tokens: Record<string, TokenPricing>;
};

export type RosterRoute =
  | "eth"
  | "erc20"
  | "contract"
  | "lending"
  | "liquidation";

// One movement before aggregation. `from` and `to` are agent ids; `token` is the lowercase token
// address, or null for ETH.
export type RosterMovement = {
  route: RosterRoute;
  from: string;
  to: string;
  token: string | null;
  amountRaw: bigint;
  block: number;
  via?: string;
  viaKind?: string;
  viaCreator?: string;
};

export type RosterTransferReason =
  | "same-participant"
  | "over-threshold"
  | "unpriced";

/**
 * Who a flagged movement is charged to. "both" where each end chose it -- two submissions of one
 * unit paying each other, or a transfer over the threshold, which takes a real position to make.
 * "sender" where the far end had no say: an ERC-20 transfer cannot be refused, so a flag on the
 * receiver would be a line anyone could write into anyone's record.
 */
export type RosterFlagSide = "both" | "sender";

// What summary.json / events.jsonl carry per (route, from, to, token, via). Plain JSON: amounts are
// decimal strings so a reader without bigint support can still read it.
export type RosterTransfer = {
  route: RosterRoute;
  from: string;
  to: string;
  sameParticipant: boolean;
  participant?: string;
  // "ETH", the registry symbol, or the lowercase token address when the registry does not know it.
  token: string;
  tokenAddress?: string;
  amountRaw: string;
  // Whole units, when the decimals are known.
  amount?: string;
  valueUsdc: number | null;
  count: number;
  firstBlock: number;
  lastBlock: number;
  via?: string;
  viaKind?: string;
  viaCreator?: string;
  flagged: boolean;
  reason?: RosterTransferReason;
  // Absent means "both", the ordinary case.
  flagSide?: RosterFlagSide;
  thresholdUsdc?: number;
};

export const DEFAULT_ROSTER_TRANSFER_FLAG_BPS = 100;

function lower(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

// Lowercase address -> agent, for every registered address in the roster.
export function rosterByAddress(
  agents: readonly RosterAgent[],
): Map<string, RosterAgent> {
  const out = new Map<string, RosterAgent>();
  for (const a of agents) out.set(lower(a.address), a);
  return out;
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

// ETH carried by a transaction from one registered address to another. blocks.csv records the tx's
// own `to` and `value` (not self-reported), so this needs no chain access. Rows from a run recorded
// before those columns existed have neither and yield nothing: the alternative, reading "" as
// zero, would report a clean roster for a run that was never measured. Reverted txs moved nothing.
export function ethMovementsFromBlocksCsv(
  blocksCsv: string,
  agents: readonly RosterAgent[],
): RosterMovement[] {
  const I = BLOCKS_CSV_INDEX;
  const byAddress = rosterByAddress(agents);
  const ids = new Set(agents.map((a) => a.id));
  const out: RosterMovement[] = [];
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    if (cols[I.role] !== "agent") continue;
    if (cols[I.status] !== "success") continue;
    const from = cols[I.ownerId];
    if (!ids.has(from)) continue;
    const to = byAddress.get(lower(cols[I.to]));
    if (!to || to.id === from) continue;
    const rawValue = cols[I.valueWei];
    if (rawValue === undefined || rawValue === "") continue;
    let value: bigint;
    try {
      value = BigInt(rawValue);
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    out.push({
      route: "eth",
      from,
      to: to.id,
      token: null,
      amountRaw: value,
      block: Number(cols[I.blockNumber]),
    });
  }
  return out;
}

// ERC-20 Transfer logs whose two ends are both registered addresses. A transfer is one log however
// it was made -- `transfer`, `transferFrom` through an approval, a contract moving the tokens on an
// agent's behalf -- which is why the log, not the calldata, is what is read.
export function erc20MovementsFromLogs(
  logs: readonly RosterTransferLog[],
  agents: readonly RosterAgent[],
): RosterMovement[] {
  const byAddress = rosterByAddress(agents);
  const out: RosterMovement[] = [];
  for (const log of logs) {
    if (log.topics.length !== 3) continue;
    const from = byAddress.get(lower(log.args?.from));
    const to = byAddress.get(lower(log.args?.to));
    if (!from || !to || from.id === to.id) continue;
    const value = log.args?.value ?? 0n;
    if (value <= 0n) continue;
    out.push({
      route: "erc20",
      from: from.id,
      to: to.id,
      token: lower(log.address),
      amountRaw: value,
      block: Number(log.blockNumber ?? 0n),
    });
  }
  return out;
}

// Who put a token into a contract and who took it out, netted per agent over the window, paired
// pro rata. A pool the creator seeded and a stranger swapped in reads as the creator putting and
// the stranger taking (of one token) -- which is the counterparty fact the rules care about, not an
// accusation; the threshold and the participant unit decide what becomes a flag.
export function contractMovementsFromLogs(
  logs: readonly RosterTransferLog[],
  agents: readonly RosterAgent[],
  contracts: Readonly<Record<string, RouteContract>>,
): RosterMovement[] {
  const byAddress = rosterByAddress(agents);
  // contract|token -> agent id -> net (sent − received), and the last block seen.
  const nets = new Map<
    string,
    { contract: string; token: string; net: Map<string, bigint>; block: number }
  >();
  for (const log of logs) {
    if (log.topics.length !== 3) continue;
    const from = lower(log.args?.from);
    const to = lower(log.args?.to);
    const value = log.args?.value ?? 0n;
    if (value <= 0n) continue;
    const token = lower(log.address);
    const block = Number(log.blockNumber ?? 0n);
    const bump = (contract: string, agent: string, delta: bigint) => {
      const key = `${contract}|${token}`;
      let entry = nets.get(key);
      if (!entry) {
        entry = { contract, token, net: new Map(), block };
        nets.set(key, entry);
      }
      entry.net.set(agent, (entry.net.get(agent) ?? 0n) + delta);
      entry.block = Math.max(entry.block, block);
    };
    const sender = byAddress.get(from);
    const recipient = byAddress.get(to);
    if (sender && contracts[to] && !recipient) bump(to, sender.id, value);
    if (recipient && contracts[from] && !sender)
      bump(from, recipient.id, -value);
  }
  const out: RosterMovement[] = [];
  for (const { contract, token, net, block } of nets.values()) {
    const puts = new Map<string, bigint>();
    const takes = new Map<string, bigint>();
    for (const [agent, n] of net) {
      if (n > 0n) puts.set(agent, n);
      else if (n < 0n) takes.set(agent, -n);
    }
    const route = contracts[contract];
    for (const pair of proRataPairs(puts, takes))
      out.push({
        route: "contract",
        from: pair.from,
        to: pair.to,
        token,
        amountRaw: pair.amount,
        block,
        via: contract,
        viaKind: route.kind,
        viaCreator: route.creatorId,
      });
  }
  return out;
}

// Suppliers and borrowers of one participant-created lending market, netted (supply − withdraw,
// borrow − repay) and paired pro rata; plus every liquidation between two registered addresses.
export function lendingMovementsFromLogs(
  logs: readonly LendingEventLike[],
  agents: readonly RosterAgent[],
  markets: Readonly<Record<string, RouteMarket>>,
): RosterMovement[] {
  const byAddress = rosterByAddress(agents);
  const perMarket = new Map<
    string,
    { supply: Map<string, bigint>; borrow: Map<string, bigint>; block: number }
  >();
  const out: RosterMovement[] = [];
  for (const log of logs) {
    const id = lower(log.args.id);
    const market = markets[id];
    if (!market) continue;
    const block = Number(log.blockNumber ?? 0n);
    if (log.eventName === "Liquidate") {
      const liquidator = byAddress.get(lower(log.args.liquidator));
      const borrower = byAddress.get(lower(log.args.borrower));
      const seized = log.args.seizedAssets ?? 0n;
      if (!liquidator || !borrower || liquidator.id === borrower.id) continue;
      if (seized <= 0n) continue;
      out.push({
        route: "liquidation",
        from: borrower.id,
        to: liquidator.id,
        token: lower(market.collateralToken),
        amountRaw: seized,
        block,
        via: id,
        viaKind: "lendingMarket",
        viaCreator: market.creatorId,
      });
      continue;
    }
    const caller = byAddress.get(lower(log.args.caller));
    if (!caller) continue;
    const assets = log.args.assets ?? 0n;
    if (assets <= 0n) continue;
    let entry = perMarket.get(id);
    if (!entry) {
      entry = { supply: new Map(), borrow: new Map(), block };
      perMarket.set(id, entry);
    }
    entry.block = Math.max(entry.block, block);
    const bump = (map: Map<string, bigint>, delta: bigint) =>
      map.set(caller.id, (map.get(caller.id) ?? 0n) + delta);
    switch (log.eventName) {
      case "Supply":
        bump(entry.supply, assets);
        break;
      case "Withdraw":
        bump(entry.supply, -assets);
        break;
      case "Borrow":
        bump(entry.borrow, assets);
        break;
      case "Repay":
        bump(entry.borrow, -assets);
        break;
      default:
        break;
    }
  }
  for (const [id, { supply, borrow, block }] of perMarket) {
    const market = markets[id];
    const puts = new Map<string, bigint>();
    const takes = new Map<string, bigint>();
    for (const [agent, n] of supply) if (n > 0n) puts.set(agent, n);
    for (const [agent, n] of borrow) if (n > 0n) takes.set(agent, n);
    for (const pair of proRataPairs(puts, takes))
      out.push({
        route: "lending",
        from: pair.from,
        to: pair.to,
        token: lower(market.loanToken),
        amountRaw: pair.amount,
        block,
        via: id,
        viaKind: "lendingMarket",
        viaCreator: market.creatorId,
      });
  }
  return out;
}

// Each taker's amount is attributed to the putters in proportion to what they put, so that two
// suppliers of 10,000 and one borrower of 10,000 read as 5,000 from each rather than 10,000 from
// both. An agent on both sides is excluded from its own pair but stays in the denominator (its
// share of what it borrowed came from itself). Capped at what the putter put.
export function proRataPairs(
  puts: ReadonlyMap<string, bigint>,
  takes: ReadonlyMap<string, bigint>,
): Array<{ from: string; to: string; amount: bigint }> {
  let total = 0n;
  for (const n of puts.values()) total += n;
  if (total <= 0n) return [];
  const out: Array<{ from: string; to: string; amount: bigint }> = [];
  for (const [taker, take] of takes) {
    for (const [putter, put] of puts) {
      if (putter === taker) continue;
      let amount = (take * put) / total;
      if (amount > put) amount = put;
      if (amount <= 0n) continue;
      out.push({ from: putter, to: taker, amount });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// aggregation, valuation and the verdict
// ---------------------------------------------------------------------------

export function summarizeRosterTransfers(opts: {
  movements: readonly RosterMovement[];
  agents: readonly RosterAgent[];
  pricing: RosterPricing;
  // Cross-unit movements below this share of the pair's smaller endowment are reported, not
  // flagged. 0 flags every priced one.
  thresholdBps: number;
}): RosterTransfer[] {
  const byId = new Map(opts.agents.map((a) => [a.id, a]));
  const groups = new Map<
    string,
    {
      m: RosterMovement;
      amountRaw: bigint;
      count: number;
      firstBlock: number;
      lastBlock: number;
    }
  >();
  for (const m of opts.movements) {
    const key = `${m.route}|${m.from}|${m.to}|${m.token ?? "eth"}|${m.via ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.amountRaw += m.amountRaw;
      g.count += 1;
      g.firstBlock = Math.min(g.firstBlock, m.block);
      g.lastBlock = Math.max(g.lastBlock, m.block);
    } else
      groups.set(key, {
        m,
        amountRaw: m.amountRaw,
        count: 1,
        firstBlock: m.block,
        lastBlock: m.block,
      });
  }
  const out: RosterTransfer[] = [];
  for (const g of groups.values()) {
    const { m } = g;
    const from = byId.get(m.from);
    const to = byId.get(m.to);
    const sameParticipant =
      from?.participant !== undefined &&
      to?.participant !== undefined &&
      from.participant === to.participant;
    const priced = priceMovement(m.token, g.amountRaw, opts.pricing);
    const threshold = thresholdUsdc(from, to, opts.thresholdBps);
    let flagged = false;
    let reason: RosterTransferReason | undefined;
    // Which side carries it into matrix.json. Both, except where the far end could not have
    // refused (see the unpriced branch).
    let flagSide: RosterFlagSide = "both";
    if (sameParticipant) {
      flagged = true;
      reason = "same-participant";
    } else if (priced.valueUsdc !== null) {
      // Only a direct transfer is charged to strangers on size alone. A routed one is a trade:
      // both ends of a swap through somebody's pool, a supply and a borrow in the same lending
      // market. Those are what the environment rewards -- taking the other side of a venue a
      // participant built is named as a skill, and 1% of the endowment is ~760 USDC, which the
      // reference agents cross in ordinary play. Between two submissions of one unit the route
      // does not matter (above); between strangers a routed movement is reported and not flagged.
      const direct = m.route === "eth" || m.route === "erc20";
      if (direct && priced.valueUsdc >= threshold) {
        flagged = true;
        reason = "over-threshold";
      }
    } else if (m.route === "eth" || m.route === "erc20") {
      // A direct transfer of something the scorer cannot price cannot be bounded by the threshold
      // either; between strangers it is still a transfer nobody trades through. Routed movements of
      // unknown tokens (a launch token through someone's pool) are reported only.
      //
      // The sender's flag only (`flagSide`). A transfer needs no consent from the far end: ERC-20
      // has no way to refuse one, and the scorer prices neither LST shares in a wallet nor a launch
      // token, both of which every official regime puts on the chain. One wei of either, sent to
      // whoever is in front in the standings, would otherwise write a §8 line into their record --
      // and the record is what the operator reads at the end of the week. Whoever sent it chose to.
      flagged = true;
      reason = "unpriced";
      flagSide = "sender";
    }
    out.push({
      route: m.route,
      from: m.from,
      to: m.to,
      sameParticipant,
      ...(sameParticipant && from?.participant !== undefined
        ? { participant: from.participant }
        : {}),
      token: priced.token,
      ...(m.token ? { tokenAddress: m.token } : {}),
      amountRaw: g.amountRaw.toString(),
      ...(priced.amount !== undefined ? { amount: priced.amount } : {}),
      valueUsdc: priced.valueUsdc,
      count: g.count,
      firstBlock: g.firstBlock,
      lastBlock: g.lastBlock,
      ...(m.via !== undefined ? { via: m.via } : {}),
      ...(m.viaKind !== undefined ? { viaKind: m.viaKind } : {}),
      ...(m.viaCreator !== undefined ? { viaCreator: m.viaCreator } : {}),
      flagged,
      ...(reason !== undefined ? { reason } : {}),
      ...(flagged && flagSide !== "both" ? { flagSide } : {}),
      ...(sameParticipant ? {} : { thresholdUsdc: threshold }),
    });
  }
  // Largest first, unpriced last, then a stable order so two runs of the same data agree.
  out.sort((a, b) => {
    const av = a.valueUsdc ?? -1;
    const bv = b.valueUsdc ?? -1;
    if (av !== bv) return bv - av;
    return `${a.from}|${a.to}|${a.route}|${a.token}`.localeCompare(
      `${b.from}|${b.to}|${b.route}|${b.token}`,
    );
  });
  return out;
}

function priceMovement(
  token: string | null,
  amountRaw: bigint,
  pricing: RosterPricing,
): { token: string; amount?: string; valueUsdc: number | null } {
  if (token === null) {
    const amount = formatUnits(amountRaw, 18);
    return { token: "ETH", amount, valueUsdc: Number(amount) * pricing.ethUsdc };
  }
  const info = pricing.tokens[token];
  if (!info) return { token, valueUsdc: null };
  const amount = formatUnits(amountRaw, info.decimals);
  return {
    token: info.symbol,
    amount,
    valueUsdc:
      info.priceUsdc === null ? null : Number(amount) * info.priceUsdc,
  };
}

// The smaller endowment of the pair, when both are known: what a transfer distorts is the
// recipient's P against its own V_0, and what it costs is the sender's. An agent the run never
// valued contributes nothing, and a pair with no V_0 at all has threshold 0 (every priced movement
// is flagged, which is the conservative reading of "not measured").
function thresholdUsdc(
  from: RosterAgent | undefined,
  to: RosterAgent | undefined,
  bps: number,
): number {
  const values = [from?.initialValueUsdc, to?.initialValueUsdc].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  if (values.length === 0) return 0;
  return (Math.min(...values) * Math.max(0, bps)) / 10_000;
}

// The flagged transfers each agent is a side of, by agent id. Both sides carry the same record:
// the sibling that received is as much a party to §8 as the one that sent.
export function flaggedRosterTransfersByAgent(
  transfers: readonly RosterTransfer[],
): Record<string, RosterTransfer[]> {
  const out: Record<string, RosterTransfer[]> = {};
  for (const t of transfers) {
    if (!t.flagged) continue;
    // `flagSide: "sender"` is charged to one end only: the far end could not have refused it, so
    // putting it in their record would let anyone write a §8 line into anyone's (see the unpriced
    // branch of summarizeRosterTransfers). This is the one place that decides whose record a
    // movement lands in -- summary.json's per-agent list and matrix.json's flags both read it.
    const sides = t.flagSide === "sender" ? [t.from] : [t.from, t.to];
    for (const id of sides) (out[id] ??= []).push(t);
  }
  return out;
}

// One flag line for one side of a flagged transfer, in the vocabulary of the other flags
// (scenarioScores.ts): a recorded fact, for the operator to judge.
export function rosterTransferFlag(t: RosterTransfer, agentId: string): string {
  const sent = t.from === agentId;
  const other = sent ? t.to : t.from;
  const value =
    t.valueUsdc === null
      ? `${t.amount ?? t.amountRaw} ${t.token} (unpriced)`
      : `${t.valueUsdc.toFixed(2)} USDC`;
  const what = (() => {
    switch (t.route) {
      case "eth":
      case "erc20":
        return `${sent ? "sent" : "received"} ${value} ${sent ? "to" : "from"} ${other} in ${t.count} ${t.route === "eth" ? "ETH" : "ERC-20"} transfer(s)`;
      case "contract":
        return `${sent ? "put" : "took"} ${value} ${sent ? "into" : "out of"} ${t.viaKind ?? "contract"} ${t.via ?? ""} (created by ${t.viaCreator ?? "?"}) ${sent ? "that" : "that"} ${other} ${sent ? "took out" : "put in"}`;
      case "lending":
        return sent
          ? `supplied ${value} that ${other} borrowed in lending market ${t.via ?? ""} (created by ${t.viaCreator ?? "?"})`
          : `borrowed ${value} that ${other} supplied in lending market ${t.via ?? ""} (created by ${t.viaCreator ?? "?"})`;
      case "liquidation":
        return sent
          ? `had ${value} of collateral seized by ${other} in lending market ${t.via ?? ""}`
          : `seized ${value} of ${other}'s collateral in lending market ${t.via ?? ""}`;
      default:
        return `${value} moved ${sent ? "to" : "from"} ${other}`;
    }
  })();
  const why =
    t.reason === "same-participant"
      ? `same participant unit ${t.participant ?? ""}: self-dealing between two submissions`
      : t.reason === "unpriced"
        ? "a direct transfer the scorer cannot price"
        : `over the ${t.thresholdUsdc === undefined ? "flag" : `${t.thresholdUsdc.toFixed(2)} USDC flag`} threshold`;
  return `value moved between registered addresses: ${what} -- ${why} (rules §8; for the operator to judge)`;
}
