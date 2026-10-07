// The chain-reading half of the roster-transfer check (issue #208; rules §8). The verdicts are in
// core/src/rosterTransfers.ts, which is pure; this file is what fetches the run window's Transfer
// logs, the lending singleton's position events and the registry's participant-created entries,
// reads blocks.csv, and hands all of it over. Runs after the run, before resetFork erases history
// -- the same place and the same cost shape as the stranded-asset sweep (reconstruct.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { transferEvent } from "@eris/sdk/agentMarkets.js";
import { readRegistryEntries } from "@eris/sdk/marketRegistry.js";
import { tokenRegistry } from "@eris/sdk/markets.js";
import { simpleLendingAbi } from "@eris/sdk/protocols/lending.js";
import type { StablePrices } from "@eris/sdk/stables.js";
import {
  contractMovementsFromLogs,
  erc20MovementsFromLogs,
  ethMovementsFromBlocksCsv,
  flaggedRosterTransfersByAgent,
  lendingMovementsFromLogs,
  summarizeRosterTransfers,
  type LendingEventLike,
  type RosterAgent,
  type RosterMovement,
  type RosterPricing,
  type RosterTransfer,
  type RosterTransferLog,
  type RouteContract,
  type RouteMarket,
} from "../rosterTransfers.js";

export type RosterTransferScan = {
  transfers: RosterTransfer[];
  // Flagged transfers by agent id, both sides.
  byAgent: Record<string, RosterTransfer[]>;
  thresholdBps: number;
  // Which sources were actually read. "No transfers" means nothing only for a source that was.
  sources: {
    blocksCsv: boolean;
    transferLogs: boolean;
    lendingLogs: boolean;
    registry: boolean;
  };
  errors: string[];
};

const LENDING_ROUTE_EVENTS = new Set([
  "Supply",
  "Withdraw",
  "Borrow",
  "Repay",
  "Liquidate",
]);

// How many registered addresses go into one getLogs topic filter. anvil takes any length; the
// chunk keeps a hosted node's request size ordinary.
const ADDRESSES_PER_QUERY = 50;

export async function scanRosterTransfers(opts: {
  publicClient: PublicClient;
  agents: readonly RosterAgent[];
  runDir: string;
  fromBlock: number;
  toBlock: number;
  // False when the window outran the node's retained history: the log-based routes are then
  // skipped and said so, and only blocks.csv (the coordinator's own record) is read.
  scanLogs: boolean;
  pricing: RosterPricing;
  thresholdBps: number;
  // The lending singleton and the registry, when the run deployed them (agentMarkets.enabled).
  lending?: Address;
  marketRegistry?: Address;
  // Addresses the agents' wallets funded (DerivedSenderLedger.ownerByAddress(), issue #212): lowercase
  // address -> agent id. Only the EOAs among them count as an agent's address for the direct routes
  // (derivedEoaOwners).
  derivedOwners?: ReadonlyMap<string, string>;
}): Promise<RosterTransferScan> {
  const { publicClient, agents, fromBlock, toBlock } = opts;
  const errors: string[] = [];
  const sources = {
    blocksCsv: false,
    transferLogs: false,
    lendingLogs: false,
    registry: false,
  };
  const movements: RosterMovement[] = [];

  let derived = new Map<string, string>();
  if (opts.derivedOwners && opts.derivedOwners.size > 0) {
    try {
      derived = await derivedEoaOwners(publicClient, opts.derivedOwners);
    } catch (err) {
      errors.push(`derived senders: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const csvPath = join(opts.runDir, "blocks.csv");
  if (existsSync(csvPath)) {
    sources.blocksCsv = true;
    movements.push(
      ...ethMovementsFromBlocksCsv(readFileSync(csvPath, "utf8"), agents, derived),
    );
  }

  if (opts.scanLogs && fromBlock <= toBlock && agents.length > 0) {
    // Participant-created contracts and lending markets first: the Transfer logs are read once and
    // serve both the direct route and the contract route.
    const contracts: Record<string, RouteContract> = {};
    const markets: Record<string, RouteMarket> = {};
    if (opts.marketRegistry) {
      try {
        const byAddress = new Map(
          agents.map((a) => [a.address.toLowerCase(), a.id] as const),
        );
        const entries = await readRegistryEntries(
          publicClient,
          opts.marketRegistry,
          BigInt(toBlock),
        );
        sources.registry = true;
        for (const e of entries) {
          const creatorId = byAddress.get(e.creator.toLowerCase());
          // Only what a registered address created. The environment's own launches (issue #29)
          // are venues like any other, and a creator nobody registered is nobody's sibling.
          if (creatorId === undefined) continue;
          if (e.kind === "lendingMarket") {
            markets[e.extra.toLowerCase()] = {
              loanToken: e.token0,
              collateralToken: e.token1,
              creatorId,
            };
          } else {
            contracts[e.market.toLowerCase()] = { kind: e.kind, creatorId };
          }
        }
      } catch (err) {
        errors.push(`registry: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      const logs = await fetchRosterTransferLogs(
        publicClient,
        [
          ...agents.map((a) => a.address as Address),
          ...[...derived.keys()].map((a) => a as Address),
        ],
        BigInt(fromBlock),
        BigInt(toBlock),
      );
      sources.transferLogs = true;
      // A participant-created contract is the contract route's, never an agent's own address.
      for (const address of Object.keys(contracts)) derived.delete(address);
      movements.push(...erc20MovementsFromLogs(logs, agents, derived));
      if (Object.keys(contracts).length > 0)
        movements.push(...contractMovementsFromLogs(logs, agents, contracts));
    } catch (err) {
      errors.push(`transfer logs: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (opts.lending && Object.keys(markets).length > 0) {
      try {
        const logs = await fetchLendingEvents(
          publicClient,
          opts.lending,
          BigInt(fromBlock),
          BigInt(toBlock),
        );
        sources.lendingLogs = true;
        movements.push(...lendingMovementsFromLogs(logs, agents, markets));
      } catch (err) {
        errors.push(`lending logs: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const transfers = summarizeRosterTransfers({
    movements,
    agents,
    pricing: opts.pricing,
    thresholdBps: opts.thresholdBps,
  });
  return {
    transfers,
    byAgent: flaggedRosterTransfersByAgent(transfers),
    thresholdBps: opts.thresholdBps,
    sources,
    errors,
  };
}

// The derived addresses that are EOAs, by agent. DerivedSenderLedger derives every recipient of an
// agent's value the run does not otherwise know, and that includes contracts: the first venue pool
// an agent swaps into, the router its ETH paid an execution fee to, a contract it created. Read as
// the agent's own address, the pool would turn every later swap through it into a payment between
// agents, so a recipient with code is left out: a contract the agents share is a venue (not a route
// here) or a participant-created contract (the contract route's). Code is read at the node's head,
// after the run; an EIP-7702 delegation designator is still an EOA.
export async function derivedEoaOwners(
  publicClient: Pick<PublicClient, "getCode">,
  derivedOwners: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const entries = [...derivedOwners];
  const codes = await Promise.all(
    entries.map(([address]) => publicClient.getCode({ address: address as Address })),
  );
  const out = new Map<string, string>();
  entries.forEach(([address, ownerId], i) => {
    const code = codes[i];
    if (code === undefined || code === "0x" || code.toLowerCase().startsWith("0xef0100"))
      out.set(address.toLowerCase(), ownerId);
  });
  return out;
}

// Every ERC-20 Transfer with a registered address (or a derived EOA) at either end, each log once. A log from one
// registered address to another is returned by both the `from` and the `to` query (and by two
// chunks when the ends fall in different ones), so the dedup is what keeps a sibling transfer from
// counting twice.
export async function fetchRosterTransferLogs(
  publicClient: PublicClient,
  addresses: readonly Address[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RosterTransferLog[]> {
  const out: RosterTransferLog[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < addresses.length; i += ADDRESSES_PER_QUERY) {
    const chunk = addresses.slice(i, i + ADDRESSES_PER_QUERY);
    const [sent, received] = await Promise.all([
      publicClient.getLogs({
        event: transferEvent,
        args: { from: chunk },
        fromBlock,
        toBlock,
        strict: false,
      }),
      publicClient.getLogs({
        event: transferEvent,
        args: { to: chunk },
        fromBlock,
        toBlock,
        strict: false,
      }),
    ]);
    for (const log of [...sent, ...received]) {
      const key = `${log.transactionHash}|${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(log as unknown as RosterTransferLog);
    }
  }
  return out;
}

// The singleton's position events over the window, decoded with the venue's own ABI.
export async function fetchLendingEvents(
  publicClient: PublicClient,
  lending: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<LendingEventLike[]> {
  const raw = await publicClient.getLogs({
    address: lending,
    fromBlock,
    toBlock,
  });
  const out: LendingEventLike[] = [];
  for (const log of raw) {
    let decoded: { eventName: string; args: unknown };
    try {
      decoded = decodeEventLog({
        abi: simpleLendingAbi,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data,
      }) as { eventName: string; args: unknown };
    } catch {
      continue; // an event the ABI does not name (AccrueInterest, CreateMarket) is not a position
    }
    if (!LENDING_ROUTE_EVENTS.has(decoded.eventName)) continue;
    out.push({
      eventName: decoded.eventName,
      args: decoded.args as LendingEventLike["args"],
      blockNumber: log.blockNumber,
    });
  }
  return out;
}

// What the scorer prices things at, for the registry's tokens, in the shape the pure module reads.
// A base at its fair price, a stable at its market price (par when the market did not quote --
// stables.ts already resolved that), an LST unpriced: its mark is the vault's and a direct
// transfer of it is rare enough to report rather than value.
export function rosterPricingFromMarks(
  fairPrices: Readonly<Record<string, number>>,
  stablePrices: StablePrices,
): RosterPricing {
  const tokens: RosterPricing["tokens"] = {};
  for (const t of Object.values(tokenRegistry())) {
    const address = t.address.toLowerCase();
    const priceUsdc =
      t.kind === "base"
        ? (fairPrices[t.symbol] ?? null)
        : t.kind === "stable"
          ? (stablePrices.byToken[address] ?? 1)
          : null;
    tokens[address] = { symbol: t.symbol, decimals: t.decimals, priceUsdc };
  }
  return { ethUsdc: fairPrices.WETH ?? 0, tokens };
}
