// Issue #208 / rules §8: value moved between registered addresses, read off the run's record after
// the run. The pure half is exercised on synthetic blocks.csv rows, Transfer logs and lending
// events; the verdict rules (same unit at any size, strangers above a threshold) and the flag text
// that reaches matrix.json are pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import { BLOCKS_CSV_COLUMNS } from "../core/src/logger.js";
import {
  contractMovementsFromLogs,
  erc20MovementsFromLogs,
  ethMovementsFromBlocksCsv,
  flaggedRosterTransfersByAgent,
  lendingMovementsFromLogs,
  proRataPairs,
  rosterTransferFlag,
  summarizeRosterTransfers,
  type RosterAgent,
  type RosterPricing,
  type RosterTransferLog,
} from "../core/src/rosterTransfers.js";
import { scanRosterTransfers } from "../core/src/realtime/rosterTransferScan.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import {
  scoresFromSummary,
  type RunSummary,
} from "../core/src/backtest/scenarioScores.js";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const C = "0x00000000000000000000000000000000000000cc"; // a stranger
const POOL = "0x0000000000000000000000000000000000000d01"; // a participant-created contract
const VENUE = "0x0000000000000000000000000000000000000e01"; // an environment venue (not a route)
const USDC = "0x000000000000000000000000000000000000f001";
const WETH = "0x000000000000000000000000000000000000f002";
const JUNK = "0x000000000000000000000000000000000000f003"; // a token nobody prices

const agents: RosterAgent[] = [
  { id: "team-x-a", address: A, participant: "team-x", initialValueUsdc: 50_000 },
  { id: "team-x-b", address: B, participant: "team-x", initialValueUsdc: 50_000 },
  { id: "solo", address: C, initialValueUsdc: 20_000 },
];

const pricing: RosterPricing = {
  ethUsdc: 3_000,
  tokens: {
    [USDC]: { symbol: "USDC", decimals: 6, priceUsdc: 1 },
    [WETH]: { symbol: "WETH", decimals: 18, priceUsdc: 3_000 },
  },
};

function csv(rows: Array<Record<string, string>>): string {
  const header = BLOCKS_CSV_COLUMNS.join(",");
  const lines = rows.map((r) =>
    BLOCKS_CSV_COLUMNS.map((c) => r[c] ?? "").join(","),
  );
  return [header, ...lines].join("\n");
}

function transfer(
  token: string,
  from: string,
  to: string,
  value: bigint,
  block = 10,
): RosterTransferLog {
  return {
    address: token,
    topics: ["0xddf2", "0x1", "0x2"],
    args: { from, to, value },
    blockNumber: BigInt(block),
  };
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

test("ETH carried by a tx between two registered addresses comes off blocks.csv; nothing else does", () => {
  const rows = csv([
    // A -> B, 1 ETH: a movement.
    { role: "agent", status: "success", ownerId: "team-x-a", blockNumber: "10", hash: "0x1", to: B, valueWei: "1000000000000000000" },
    // Reverted: moved nothing.
    { role: "agent", status: "reverted", ownerId: "team-x-a", blockNumber: "11", hash: "0x2", to: B, valueWei: "1000000000000000000" },
    // To a venue: not a registered address.
    { role: "agent", status: "success", ownerId: "team-x-a", blockNumber: "12", hash: "0x3", to: VENUE, valueWei: "1000000000000000000" },
    // Zero value (a call): nothing moved.
    { role: "agent", status: "success", ownerId: "team-x-a", blockNumber: "13", hash: "0x4", to: B, valueWei: "0" },
    // An unregistered sender (role external) is not in the roster.
    { role: "external", status: "success", ownerId: C, blockNumber: "14", hash: "0x5", to: B, valueWei: "5" },
    // A row from a run before the columns existed: not measured, not zero.
    { role: "agent", status: "success", ownerId: "team-x-a", blockNumber: "15", hash: "0x6" },
    // Mixed-case recipient still resolves.
    { role: "agent", status: "success", ownerId: "solo", blockNumber: "16", hash: "0x7", to: A.toUpperCase().replace("0X", "0x"), valueWei: "7" },
  ]);
  const moves = ethMovementsFromBlocksCsv(rows, agents);
  assert.deepEqual(
    moves.map((m) => [m.from, m.to, m.amountRaw, m.block]),
    [
      ["team-x-a", "team-x-b", 1_000_000_000_000_000_000n, 10],
      ["solo", "team-x-a", 7n, 16],
    ],
  );
  assert.equal(moves[0].route, "eth");
  assert.equal(moves[0].token, null);
});

test("an ERC-20 Transfer log is a movement only with a registered address at both ends", () => {
  const logs: RosterTransferLog[] = [
    transfer(USDC, A, B, 5_000_000_000n, 20),
    transfer(USDC, A, VENUE, 5_000_000_000n, 21), // a swap leg
    transfer(USDC, VENUE, B, 5_000_000_000n, 21), // its other leg
    transfer(USDC, B, A, 0n, 22), // nothing moved
    // ERC-721 shares the topic0 and indexes the tokenId too.
    { address: JUNK, topics: ["0xddf2", "0x1", "0x2", "0x3"], args: { from: A, to: B, value: 1n }, blockNumber: 23n },
  ];
  const moves = erc20MovementsFromLogs(logs, agents);
  assert.equal(moves.length, 1);
  assert.deepEqual(
    [moves[0].route, moves[0].from, moves[0].to, moves[0].token, moves[0].amountRaw, moves[0].block],
    ["erc20", "team-x-a", "team-x-b", USDC, 5_000_000_000n, 20],
  );
});

// Issue #212's derived senders on the direct routes: X is an EOA team-x-a's wallet funded.
const X = "0x0000000000000000000000000000000000000a01";
const Y = "0x0000000000000000000000000000000000000c01"; // an EOA solo's wallet funded

test("ERC-20 through an EOA the sender funded: A -> X -> B is A paying B; A -> X alone is nothing", () => {
  const derived = new Map([[X, "team-x-a"], [Y, "solo"]]);
  const twoHop = erc20MovementsFromLogs(
    [transfer(USDC, A, X, 5_000_000_000n, 40), transfer(USDC, X, B, 5_000_000_000n, 41)],
    agents,
    derived,
  );
  assert.deepEqual(
    twoHop.map((m) => [m.route, m.from, m.to, m.amountRaw, m.block]),
    [["erc20", "team-x-a", "team-x-b", 5_000_000_000n, 41]],
  );
  // Within one agent's own set: not a movement.
  assert.deepEqual(erc20MovementsFromLogs([transfer(USDC, A, X, 1n)], agents, derived), []);
  // Between two derived EOAs of different agents.
  const between = erc20MovementsFromLogs([transfer(USDC, X, Y, 9n, 42)], agents, derived);
  assert.deepEqual(between.map((m) => [m.from, m.to]), [["team-x-a", "solo"]]);
  // Without the map the same logs are invisible (the gap this closes).
  assert.deepEqual(
    erc20MovementsFromLogs([transfer(USDC, X, B, 5n)], agents),
    [],
  );
  // A derived entry can never re-attribute a registered address.
  assert.deepEqual(
    erc20MovementsFromLogs([transfer(USDC, A, B, 3n)], agents, new Map([[B, "team-x-a"]]))
      .map((m) => [m.from, m.to]),
    [["team-x-a", "team-x-b"]],
  );
});

test("ETH through an EOA the sender funded: the derived hop's recipient and an early external row resolve", () => {
  const derived = new Map([[X, "team-x-a"]]);
  const rows = csv([
    // A -> X: parking on its own second EOA.
    { role: "agent", status: "success", ownerId: "team-x-a", blockNumber: "50", hash: "0x1", to: X, valueWei: "5" },
    // X (already derived, written under the agent) -> B.
    { role: "agent", status: "success", ownerId: "team-x-a", blockNumber: "51", hash: "0x2", to: B, valueWei: "5" },
    // X sent before its funding was seen: written external, ownerId = its address.
    { role: "external", status: "success", ownerId: X, blockNumber: "52", hash: "0x3", to: C, valueWei: "4" },
    // solo pays into X: solo -> team-x-a.
    { role: "agent", status: "success", ownerId: "solo", blockNumber: "53", hash: "0x4", to: X, valueWei: "3" },
  ]);
  assert.deepEqual(
    ethMovementsFromBlocksCsv(rows, agents, derived).map((m) => [m.from, m.to, m.amountRaw, m.block]),
    [
      ["team-x-a", "team-x-b", 5n, 51],
      ["team-x-a", "solo", 4n, 52],
      ["solo", "team-x-a", 3n, 53],
    ],
  );
});

test("the scan reads derived EOAs only: a pool the ledger attributed to an agent does not make swaps payments", async () => {
  // DerivedSenderLedger derives the first pool team-x-a sends tokens into (VENUE, which has code)
  // as well as its second EOA X (no code).
  const derived = new Map([[VENUE, "team-x-a"], [X, "team-x-a"]]);
  const logs = [
    transfer(USDC, A, VENUE, 7_000_000_000n, 60), // A's swap that derived the pool
    transfer(USDC, B, VENUE, 7_000_000_000n, 61), // B swaps through the same pool
    transfer(WETH, VENUE, B, 2_000_000_000_000_000_000n, 61),
    transfer(USDC, VENUE, C, 1_000_000_000n, 62), // and solo
    transfer(USDC, A, X, 4_000_000_000n, 63),
    transfer(USDC, X, B, 4_000_000_000n, 64),
  ].map((l, i) => ({ ...l, transactionHash: `0x${i}`, logIndex: 0 }));
  const touches = (l: RosterTransferLog, set: readonly string[] | undefined, end: "from" | "to") =>
    (set ?? []).some((a) => a.toLowerCase() === l.args?.[end]?.toLowerCase());
  const client = {
    getCode: async ({ address }: { address: string }) =>
      address.toLowerCase() === VENUE ? "0x6080" : undefined,
    getLogs: async ({ args }: { args: { from?: string[]; to?: string[] } }) =>
      logs.filter((l) => touches(l, args.from, "from") || touches(l, args.to, "to")),
  } as unknown as PublicClient;
  const runDir = mkdtempSync(join(tmpdir(), "roster-derived-"));
  writeFileSync(
    join(runDir, "blocks.csv"),
    csv([
      // ETH into the pool's router-like address from B: not a payment to team-x-a.
      { role: "agent", status: "success", ownerId: "team-x-b", blockNumber: "65", hash: "0x9", to: VENUE, valueWei: "1" },
    ]),
  );
  const scan = await scanRosterTransfers({
    publicClient: client,
    agents,
    runDir,
    fromBlock: 1,
    toBlock: 100,
    scanLogs: true,
    pricing,
    thresholdBps: 100,
    derivedOwners: derived,
  });
  assert.deepEqual(scan.errors, []);
  assert.deepEqual(
    scan.transfers.map((t) => [t.route, t.from, t.to, t.token, t.amountRaw]),
    [["erc20", "team-x-a", "team-x-b", "USDC", "4000000000"]],
  );
  assert.equal(scan.transfers[0].flagged, true); // same unit, any size
});

test("opposite net flows of one token through a participant-created contract pair the putter with the taker", () => {
  const logs: RosterTransferLog[] = [
    transfer(USDC, A, POOL, 10_000_000_000n, 30), // A put 10,000
    transfer(USDC, POOL, B, 6_000_000_000n, 31), // B took 6,000
    transfer(USDC, POOL, A, 1_000_000_000n, 32), // A took 1,000 back: net put 9,000
    transfer(USDC, A, VENUE, 7_000_000_000n, 33), // an environment venue is not a route
    transfer(USDC, VENUE, B, 7_000_000_000n, 33),
  ];
  const moves = contractMovementsFromLogs(logs, agents, {
    [POOL]: { kind: "unknown", creatorId: "team-x-a" },
  });
  assert.equal(moves.length, 1);
  const m = moves[0];
  assert.equal(m.route, "contract");
  assert.equal(m.from, "team-x-a");
  assert.equal(m.to, "team-x-b");
  assert.equal(m.amountRaw, 6_000_000_000n); // what B took, capped by what A net put (9,000)
  assert.equal(m.via, POOL);
  assert.equal(m.viaKind, "unknown");
  assert.equal(m.viaCreator, "team-x-a");
  assert.equal(m.block, 32); // the venue legs at 33 are not part of this route
});

test("a market's registered suppliers are paired pro rata with its registered borrowers; liquidations are direct", () => {
  const MARKET = "0x" + "1".repeat(64);
  const markets = {
    [MARKET]: { loanToken: USDC, collateralToken: WETH, creatorId: "solo" },
  };
  const ev = (eventName: string, args: Record<string, unknown>, block: number) => ({
    eventName,
    args: { id: MARKET, ...args },
    blockNumber: BigInt(block),
  });
  const moves = lendingMovementsFromLogs(
    [
      ev("Supply", { caller: A, assets: 10_000_000_000n }, 40), // A supplied 10,000
      ev("Supply", { caller: C, assets: 10_000_000_000n }, 40), // solo supplied 10,000
      ev("Withdraw", { caller: C, assets: 5_000_000_000n }, 41), // solo withdrew 5,000: net 5,000
      ev("Borrow", { caller: B, assets: 6_000_000_000n }, 42), // B borrowed 6,000
      ev("Repay", { caller: B, assets: 1_500_000_000n }, 43), // repaid 1,500: net 4,500
      ev("Liquidate", { liquidator: C, borrower: B, seizedAssets: 2_000_000_000_000_000_000n }, 44),
      ev("Supply", { id: "0x" + "2".repeat(64), caller: A, assets: 1n }, 45), // a market nobody registered made
    ],
    agents,
    markets,
  );
  const lending = moves.filter((m) => m.route === "lending");
  // 4,500 borrowed against 15,000 supplied: A's share 2/3, solo's 1/3.
  assert.deepEqual(
    lending.map((m) => [m.from, m.to, m.amountRaw, m.token, m.via]),
    [
      ["team-x-a", "team-x-b", 3_000_000_000n, USDC, MARKET],
      ["solo", "team-x-b", 1_500_000_000n, USDC, MARKET],
    ],
  );
  const liq = moves.filter((m) => m.route === "liquidation");
  assert.deepEqual(
    liq.map((m) => [m.from, m.to, m.amountRaw, m.token]),
    [["team-x-b", "solo", 2_000_000_000_000_000_000n, WETH]],
  );
});

test("proRataPairs attributes each taker to the putters by share, never to itself, never above what was put", () => {
  const pairs = proRataPairs(
    new Map([["a", 100n], ["b", 300n]]),
    new Map([["c", 200n], ["a", 40n]]),
  );
  assert.deepEqual(pairs, [
    { from: "a", to: "c", amount: 50n },
    { from: "b", to: "c", amount: 150n },
    { from: "b", to: "a", amount: 30n }, // a's own 10 is its own
  ]);
  assert.deepEqual(proRataPairs(new Map(), new Map([["c", 1n]])), []);
});

// ---------------------------------------------------------------------------
// the verdict
// ---------------------------------------------------------------------------

test("same unit: flagged at any size; strangers: only above the threshold, which is bps of the smaller V_0", () => {
  const transfers = summarizeRosterTransfers({
    movements: [
      // Two sibling transfers of 1 USDC each aggregate into one record of 2 USDC -- and flag.
      { route: "erc20", from: "team-x-a", to: "team-x-b", token: USDC, amountRaw: 1_000_000n, block: 10 },
      { route: "erc20", from: "team-x-a", to: "team-x-b", token: USDC, amountRaw: 1_000_000n, block: 12 },
      // A stranger paid 150 USDC: below 1% of min(50,000, 20,000) = 200 -> reported, not flagged.
      { route: "erc20", from: "solo", to: "team-x-a", token: USDC, amountRaw: 150_000_000n, block: 11 },
      // The same stranger sent 0.1 ETH (300 USDC): over -> flagged.
      { route: "eth", from: "solo", to: "team-x-b", token: null, amountRaw: 100_000_000_000_000_000n, block: 13 },
    ],
    agents,
    pricing,
    thresholdBps: 100,
  });
  assert.equal(transfers.length, 3);
  // Largest value first.
  assert.deepEqual(
    transfers.map((t) => [t.from, t.to, t.token, t.amount, t.valueUsdc, t.count, t.flagged, t.reason]),
    [
      ["solo", "team-x-b", "ETH", "0.1", 300, 1, true, "over-threshold"],
      ["solo", "team-x-a", "USDC", "150", 150, 1, false, undefined],
      ["team-x-a", "team-x-b", "USDC", "2", 2, 2, true, "same-participant"],
    ],
  );
  const sibling = transfers[2];
  assert.equal(sibling.sameParticipant, true);
  assert.equal(sibling.participant, "team-x");
  assert.equal(sibling.firstBlock, 10);
  assert.equal(sibling.lastBlock, 12);
  assert.equal(sibling.thresholdUsdc, undefined);
  assert.equal(transfers[0].thresholdUsdc, 200);
  assert.equal(transfers[1].thresholdUsdc, 200);
  assert.equal(transfers[0].tokenAddress, undefined);
  assert.equal(transfers[1].tokenAddress, USDC);
});

test("threshold 0 flags every priced cross-unit movement; a pair with no V_0 is threshold 0 too", () => {
  const tiny = { route: "erc20" as const, from: "solo", to: "team-x-a", token: USDC, amountRaw: 1n, block: 1 };
  assert.equal(
    summarizeRosterTransfers({ movements: [tiny], agents, pricing, thresholdBps: 0 })[0].flagged,
    true,
  );
  const unvalued = agents.map(({ initialValueUsdc: _v, ...a }) => a);
  const t = summarizeRosterTransfers({ movements: [tiny], agents: unvalued, pricing, thresholdBps: 100 })[0];
  assert.equal(t.flagged, true);
  assert.equal(t.thresholdUsdc, 0);
});

test("a token the scorer cannot price: a direct transfer between strangers is flagged as unpriced, a routed one is only reported", () => {
  const transfers = summarizeRosterTransfers({
    movements: [
      { route: "erc20", from: "solo", to: "team-x-a", token: JUNK, amountRaw: 5n, block: 1 },
      { route: "contract", from: "solo", to: "team-x-b", token: JUNK, amountRaw: 5n, block: 1, via: POOL, viaKind: "uniswapV3Pool", viaCreator: "solo" },
    ],
    agents,
    pricing,
    thresholdBps: 100,
  });
  const direct = transfers.find((t) => t.route === "erc20");
  const routed = transfers.find((t) => t.route === "contract");
  assert.equal(direct?.valueUsdc, null);
  assert.equal(direct?.token, JUNK); // the address, since no symbol is known
  assert.equal(direct?.amount, undefined);
  assert.equal(direct?.flagged, true);
  assert.equal(direct?.reason, "unpriced");
  assert.equal(routed?.flagged, false);
  assert.equal(routed?.reason, undefined);
  // Unpriced sorts after priced.
  assert.deepEqual(transfers.map((t) => t.valueUsdc), [null, null]);
});

test("a flag is charged to both ends when both chose it, and to the sender alone when one could not refuse", () => {
  const transfers = summarizeRosterTransfers({
    movements: [
      // Same unit, direct: both ends chose it.
      { route: "erc20", from: "team-x-a", to: "team-x-b", token: USDC, amountRaw: 5_000_000_000n, block: 10 },
      // Same unit, routed: the route does not matter between two submissions of one unit.
      { route: "lending", from: "team-x-b", to: "team-x-a", token: USDC, amountRaw: 7_000_000_000n, block: 11, via: "0xm", viaKind: "lendingMarket", viaCreator: "team-x-a" },
      // Strangers, routed: a trade. Reported, not flagged -- taking the other side of a venue a
      // participant built is a skill the environment rewards, and 1% of 20,000 is 200 USDC.
      { route: "lending", from: "solo", to: "team-x-b", token: USDC, amountRaw: 9_000_000_000n, block: 12, via: "0xm", viaKind: "lendingMarket", viaCreator: "team-x-b" },
      // Strangers, direct, unpriced: one wei of something nobody prices. The receiver had no say.
      { route: "erc20", from: "solo", to: "team-x-a", token: JUNK, amountRaw: 1n, block: 13 },
    ],
    agents,
    pricing,
    thresholdBps: 100,
  });
  const byAgent = flaggedRosterTransfersByAgent(transfers);

  // The routed cross-unit movement is in the run's list but carries no flag for either end.
  const routedStranger = transfers.find((t) => t.route === "lending" && t.from === "solo");
  assert.equal(routedStranger?.flagged, false);
  assert.equal(routedStranger?.reason, undefined);

  // The dust is flagged, and only against whoever sent it.
  const dust = transfers.find((t) => t.token === JUNK.toLowerCase() || t.token === JUNK);
  assert.equal(dust?.flagged, true);
  assert.equal(dust?.reason, "unpriced");
  assert.equal(dust?.flagSide, "sender");

  // So the receiver's record says nothing about it: otherwise anyone could write a §8 line into
  // anyone's record for one wei, and the record is what the operator reads at the end.
  const sent = byAgent["solo"] ?? [];
  const received = byAgent["team-x-a"] ?? [];
  assert.equal(sent.filter((t) => t.reason === "unpriced").length, 1);
  assert.equal(received.filter((t) => t.reason === "unpriced").length, 0);

  // Both ends of the same-unit transfers, each line read from its own seat.
  const sibling = byAgent["team-x-a"].find((t) => t.route === "erc20" && t.reason === "same-participant");
  assert.ok(sibling);
  assert.match(
    rosterTransferFlag(sibling, "team-x-a"),
    /^value moved between registered addresses: sent 5000\.00 USDC to team-x-b in 1 ERC-20 transfer\(s\) -- same participant unit team-x: self-dealing between two submissions \(rules §8; for the operator to judge\)$/,
  );
  assert.match(
    rosterTransferFlag(sibling, "team-x-b"),
    /received 5000\.00 USDC from team-x-a in 1 ERC-20 transfer\(s\)/,
  );
  const routedSame = byAgent["team-x-b"].find((t) => t.route === "lending");
  assert.ok(routedSame);
  assert.match(rosterTransferFlag(routedSame, "team-x-b"), /supplied 7000\.00 USDC/);
  assert.match(rosterTransferFlag(routedSame, "team-x-a"), /borrowed/);
});
test("summary.json's per-agent rosterTransfers become flags beside the score in the matrix record", () => {
  const transfers = summarizeRosterTransfers({
    movements: [
      { route: "eth", from: "team-x-a", to: "team-x-b", token: null, amountRaw: 2_000_000_000_000_000_000n, block: 5 },
    ],
    agents,
    pricing,
    thresholdBps: 100,
  });
  const byAgent = flaggedRosterTransfersByAgent(transfers);
  const summary: RunSummary = {
    runDir: "runs/x",
    agents: [
      { id: "team-x-a", participant: "team-x", pnlUsdc: -6_000, rosterTransfers: byAgent["team-x-a"] },
      { id: "team-x-b", participant: "team-x", pnlUsdc: 6_000, rosterTransfers: byAgent["team-x-b"] },
      { id: "solo", pnlUsdc: 1 },
    ],
    violations: [],
  };
  const scores = scoresFromSummary(summary, []);
  const a = scores.find((s) => s.id === "team-x-a");
  const b = scores.find((s) => s.id === "team-x-b");
  assert.equal(a?.flags?.length, 1);
  assert.match(a!.flags![0], /sent 6000\.00 USDC to team-x-b in 1 ETH transfer\(s\) -- same participant unit team-x/);
  assert.match(b!.flags![0], /received 6000\.00 USDC from team-x-a in 1 ETH transfer\(s\)/);
  assert.equal(scores.find((s) => s.id === "solo")?.flags, undefined);
  // The score itself is untouched: P travels as recorded.
  assert.equal(a?.pnlUsdc, -6_000);
  assert.equal(b?.pnlUsdc, 6_000);
});
