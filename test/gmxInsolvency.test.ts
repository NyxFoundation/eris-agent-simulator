// GMX insolvent closes charged cross-margin per account and market (sdk protocols/gmxInsolvency.ts).
// A 19.5x long + short straddle through a 32% gap lost at most the losing leg's collateral (the GM
// pool absorbed the rest) while the winning leg kept its PnL: P = +51,411 against noop's +6,799 on
// spike#101. The losing leg's shortfall is now charged to the winning leg.
import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  decodeGmxEventLog,
  gmxEventEmitterAbi,
  gmxPositionKey,
  GmxInsolvencyLedger,
  type GmxLedgerLog,
  type GmxOpenPositionPnl,
} from "@eris/sdk/protocols/gmxInsolvency.js";
import { GmxShortfallTracker } from "../core/src/realtime/gmxShortfall.js";
import {
  GMX_MAX_LEVERAGE,
  GMX_MIN_COLLATERAL_FACTOR,
  gmxMaxLeverageFromFactor,
  gmxMinCollateralFactorKey,
} from "@eris/sdk/protocols/gmxKeys.js";
import { GMX_MARKETS, TOKENS } from "@eris/sdk/constants.js";

const MARKET = GMX_MARKETS.ETH_USD;
const USDC = TOKENS.USDC.address;
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const USD = 10n ** 30n;
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 24n;

type Items = {
  address?: Record<string, Address>;
  uint?: Record<string, bigint>;
  int?: Record<string, bigint>;
  bool?: Record<string, boolean>;
  bytes32?: Record<string, Hex>;
  string?: Record<string, string>;
};

const group = <T>(rec: Record<string, T> | undefined) => ({
  items: Object.entries(rec ?? {}).map(([key, value]) => ({ key, value })),
  arrayItems: [] as Array<{ key: string; value: T[] }>,
});

let logIndex = 0;
function emitterLog(
  name: string,
  items: Items,
  at: { block: number; tx: string },
  topic1?: Hex,
): GmxLedgerLog {
  const event = gmxEventEmitterAbi.find(
    (e) => e.name === (topic1 ? "EventLog1" : "EventLog"),
  )!;
  const topics = encodeEventTopics({
    abi: [event],
    eventName: event.name,
    args: topic1
      ? ({ eventNameHash: name, topic1 } as never)
      : ({ eventNameHash: name } as never),
  } as never) as Hex[];
  const nonIndexed = event.inputs.filter(
    (i) => !("indexed" in i) || !i.indexed,
  );
  const data = encodeAbiParameters(nonIndexed as never, [
    "0x000000000000000000000000000000000000c0de",
    name,
    {
      addressItems: group(items.address),
      uintItems: group(items.uint),
      intItems: group(items.int),
      boolItems: group(items.bool),
      bytes32Items: group(items.bytes32),
      bytesItems: group<Hex>(undefined),
      stringItems: group(items.string),
    },
  ] as never);
  return {
    topics,
    data,
    blockNumber: at.block,
    logIndex: logIndex++,
    transactionHash: keccak256(toBytes(at.tx)),
  };
}

const accountTopic = (a: Address) =>
  `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

function increase(
  account: Address,
  isLong: boolean,
  block: number,
  sizeUsd: number,
  sizeAfterUsd = sizeUsd,
): GmxLedgerLog {
  return emitterLog(
    "PositionIncrease",
    {
      address: { account, market: MARKET, collateralToken: USDC },
      uint: { sizeInUsd: usd(sizeAfterUsd), sizeDeltaUsd: usd(sizeUsd) },
      bool: { isLong },
      bytes32: {
        orderKey: keccak256(toBytes(`inc-${account}-${isLong}-${block}`)),
        positionKey: gmxPositionKey(account, MARKET, USDC, isLong),
      },
    },
    { block, tx: `inc-${account}-${isLong}-${block}` },
    accountTopic(account),
  );
}

function decrease(
  account: Address,
  isLong: boolean,
  block: number,
  basePnlUsd: number,
  sizeAfterUsd = 0,
  tx = `dec-${account}-${isLong}-${block}`,
): GmxLedgerLog {
  return emitterLog(
    "PositionDecrease",
    {
      address: { account, market: MARKET, collateralToken: USDC },
      uint: { sizeInUsd: usd(sizeAfterUsd) },
      int: { basePnlUsd: usd(basePnlUsd) },
      bool: { isLong },
      bytes32: {
        orderKey: keccak256(toBytes(tx)),
        positionKey: gmxPositionKey(account, MARKET, USDC, isLong),
      },
    },
    { block, tx },
    accountTopic(account),
  );
}

// A liquidation: InsolventClose (no account) then PositionDecrease of the same order in the same tx.
function insolventLiquidation(
  account: Address,
  isLong: boolean,
  block: number,
  shortfallUsd: number,
  basePnlUsd: number,
): GmxLedgerLog[] {
  const tx = `liq-${account}-${isLong}-${block}`;
  return [
    emitterLog(
      "InsolventClose",
      {
        bytes32: { orderKey: keccak256(toBytes(tx)) },
        uint: {
          positionCollateralAmount: 12_000n * 10n ** 6n,
          remainingCostUsd: usd(shortfallUsd),
        },
        int: { basePnlUsd: usd(basePnlUsd) },
        string: { step: "pnl" },
      },
      { block, tx },
    ),
    decrease(account, isLong, block, basePnlUsd, 0, tx),
  ];
}

const openPnl = (
  account: Address,
  isLong: boolean,
  basePnlUsd: number,
): GmxOpenPositionPnl => ({
  account,
  market: MARKET,
  collateralToken: USDC,
  isLong,
  basePnlUsd,
});

test("decodes an EventEmitter log into its items", () => {
  const [insolvent] = insolventLiquidation(ALICE, true, 10, 1234.5, -13_234.5);
  const decoded = decodeGmxEventLog(insolvent);
  assert.equal(decoded?.name, "InsolventClose");
  assert.equal(decoded?.uint.remainingCostUsd, usd(1234.5));
  assert.equal(decoded?.int.basePnlUsd, usd(-13_234.5));
  assert.equal(decoded?.string.step, "pnl");
  const inc = decodeGmxEventLog(increase(ALICE, false, 3, 234_000));
  assert.equal(inc?.name, "PositionIncrease");
  assert.equal(inc?.address.account.toLowerCase(), ALICE.toLowerCase());
  assert.equal(inc?.bool.isLong, false);
  assert.equal(inc?.uint.sizeInUsd, usd(234_000));
  // Not an EventEmitter log.
  assert.equal(decodeGmxEventLog({ topics: [keccak256("0x01")], data: "0x" }), null);
  assert.ok(USD > 0n);
});

test("a straddle's insolvent leg is charged to its winning leg", () => {
  const ledger = new GmxInsolvencyLedger(new Set([ALICE.toLowerCase()]));
  const closes = ledger.ingest([
    increase(ALICE, true, 5, 234_000),
    increase(ALICE, false, 5, 234_000),
    ...insolventLiquidation(ALICE, false, 20, 50_000, -62_000),
  ]);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].shortfallUsd, 50_000);
  assert.equal(closes[0].openedAt, 5);
  assert.equal(closes[0].account.toLowerCase(), ALICE.toLowerCase());
  // Before the liquidation there is nothing to charge.
  assert.equal(ledger.chargesAt(19, [openPnl(ALICE, true, 60_000)]).size, 0);
  // After: min(shortfall 50k, winner's PnL 70k).
  const c = ledger.chargesAt(20, [openPnl(ALICE, true, 70_000)]).get(ALICE.toLowerCase());
  assert.equal(c?.chargedUsd, 50_000);
  assert.equal(c?.coverUsd, 70_000);
  // Capped by the winner's PnL when it is smaller.
  assert.equal(
    ledger.chargesAt(25, [openPnl(ALICE, true, 30_000)]).get(ALICE.toLowerCase())?.chargedUsd,
    30_000,
  );
});

test("a one-sided position keeps its limited liability", () => {
  const ledger = new GmxInsolvencyLedger(new Set([ALICE.toLowerCase()]));
  ledger.ingest([
    increase(ALICE, false, 5, 36_000),
    ...insolventLiquidation(ALICE, false, 20, 500, -12_500),
  ]);
  assert.equal(ledger.insolventCloses().length, 1);
  assert.equal(ledger.chargesAt(30, []).get(ALICE.toLowerCase())?.chargedUsd, 0);
  // A long opened after the liquidation is a new trade, not the other leg of a straddle.
  ledger.ingest([increase(ALICE, true, 25, 30_000)]);
  const c = ledger.chargesAt(30, [openPnl(ALICE, true, 5_000)]).get(ALICE.toLowerCase());
  assert.equal(c?.chargedUsd, 0);
  assert.equal(c?.shortfallUsd, 500);
});

test("closing the winner does not reopen the hole", () => {
  for (const closeAt of [15, 30]) {
    // Closed after the gap but before the keeper's liquidation landed, or after it.
    const ledger = new GmxInsolvencyLedger(new Set([ALICE.toLowerCase()]));
    ledger.ingest([
      increase(ALICE, true, 5, 234_000),
      increase(ALICE, false, 5, 234_000),
      decrease(ALICE, true, closeAt, 70_000),
      ...insolventLiquidation(ALICE, false, 20, 50_000, -62_000),
    ]);
    const at40 = ledger.chargesAt(40, []).get(ALICE.toLowerCase());
    assert.equal(at40?.chargedUsd, 50_000, `winner closed at ${closeAt}`);
    // Between the liquidation and a later close, the winner is still open: charged off its PnL.
    if (closeAt === 30)
      assert.equal(
        ledger.chargesAt(25, [openPnl(ALICE, true, 65_000)]).get(ALICE.toLowerCase())?.chargedUsd,
        50_000,
      );
  }
});

test("other accounts and untracked accounts are not charged", () => {
  const ledger = new GmxInsolvencyLedger(new Set([ALICE.toLowerCase()]));
  ledger.ingest([
    increase(BOB, true, 5, 234_000),
    increase(BOB, false, 5, 234_000),
    ...insolventLiquidation(BOB, false, 20, 50_000, -62_000),
    increase(ALICE, true, 5, 234_000),
  ]);
  assert.equal(ledger.insolventCloses().length, 0);
  assert.equal(ledger.chargesAt(30, [openPnl(ALICE, true, 70_000)]).size, 0);
});

test("prune keeps what a charge needs and survives a snapshot round trip", () => {
  const ledger = new GmxInsolvencyLedger(new Set([ALICE.toLowerCase()]));
  ledger.ingest([
    // An unrelated round trip, long before: prunable.
    increase(ALICE, true, 1, 10_000),
    decrease(ALICE, true, 2, 100),
    increase(ALICE, true, 5, 234_000),
    increase(ALICE, false, 5, 234_000),
    decrease(ALICE, true, 15, 70_000),
    ...insolventLiquidation(ALICE, false, 20, 50_000, -62_000),
  ]);
  const before = ledger.chargesAt(40, []).get(ALICE.toLowerCase());
  ledger.prune(40);
  const restored = new GmxInsolvencyLedger(new Set([ALICE.toLowerCase()]));
  restored.restore(JSON.parse(JSON.stringify(ledger.snapshot())));
  assert.deepEqual(restored.chargesAt(40, []).get(ALICE.toLowerCase()), before);
  assert.equal(before?.chargedUsd, 50_000);
  // The 1->2 life and the liquidated leg's own life are gone (the shortfall record carries what it
  // needs); the winning leg's life is kept.
  const lives = ledger.snapshot().lives;
  assert.equal(lives.length, 1);
  assert.equal(lives[0].isLong, true);
  assert.equal(lives[0].open, 5);
});

// The live scorer syncs every block and asks at the boundary; the sweep syncs once to the run's end
// and asks at each boundary. Both must charge the same at the same boundary.
test("live (per-block sync) and sweep (one sync) agree at every boundary", async () => {
  const logs = [
    increase(ALICE, true, 101, 234_000),
    increase(ALICE, false, 101, 234_000),
    ...insolventLiquidation(ALICE, false, 120, 50_000, -62_000),
    decrease(ALICE, true, 130, 66_000),
  ].map((l) => ({
    ...l,
    blockNumber: `0x${Number(l.blockNumber).toString(16)}`,
    logIndex: `0x${(l.logIndex ?? 0).toString(16)}`,
  }));
  const client = {
    request: async ({ params }: { params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
      const from = Number(params[0].fromBlock);
      const to = Number(params[0].toBlock);
      return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
    },
  } as unknown as PublicClient;
  const seen: string[] = [];
  const live = new GmxShortfallTracker({
    publicClient: client,
    fromBlock: 100,
    accounts: [ALICE],
    onInsolventClose: (c) => seen.push(c.transactionHash),
  });
  const sweep = new GmxShortfallTracker({ publicClient: client, fromBlock: 100, accounts: [ALICE] });
  await sweep.syncTo(160);
  const open = (b: number) => (b < 130 ? [openPnl(ALICE, true, 60_000 + b)] : []);
  for (let b = 100; b <= 160; b++) {
    await live.syncTo(b + 1); // the live tracker is a block ahead of the boundary it reads
    if (b % 12 !== 4) continue;
    assert.deepEqual(
      live.ledger.chargesAt(b, open(b)),
      sweep.ledger.chargesAt(b, open(b)),
      `boundary ${b}`,
    );
  }
  assert.equal(seen.length, 1);
  assert.equal(sweep.ledger.chargesAt(160, []).get(ALICE.toLowerCase())?.chargedUsd, 50_000);
});

// A practice period resumed from a checkpoint written before the ledger existed: the node still
// has the period's logs, and reading them from its first block would charge weeks of insolvent
// closes at the restart's first boundary.
test("startAfter: a pre-ledger checkpoint charges from the resume point, not the period start", async () => {
  const logs = [
    increase(ALICE, true, 101, 234_000),
    increase(ALICE, false, 101, 234_000),
    ...insolventLiquidation(ALICE, false, 120, 50_000, -62_000),
  ].map((l) => ({
    ...l,
    blockNumber: `0x${Number(l.blockNumber).toString(16)}`,
    logIndex: `0x${(l.logIndex ?? 0).toString(16)}`,
  }));
  const asked: number[] = [];
  const client = {
    request: async ({ params }: { params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
      const from = Number(params[0].fromBlock);
      const to = Number(params[0].toBlock);
      asked.push(from);
      return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
    },
  } as unknown as PublicClient;
  const tracker = new GmxShortfallTracker({ publicClient: client, fromBlock: 100, accounts: [ALICE] });
  tracker.startAfter(150);
  await tracker.syncTo(160);
  assert.deepEqual(asked, [151]);
  assert.equal(tracker.ledger.chargesAt(160, [openPnl(ALICE, true, 70_000)]).size, 0);
  // Never moves the cursor back.
  tracker.startAfter(120);
  await tracker.syncTo(160);
  assert.deepEqual(asked, [151]);
});

test("leverage cap: the factor is 0.198 (5.05x) and the key is Keys.minCollateralFactorKey", () => {
  assert.equal(GMX_MIN_COLLATERAL_FACTOR, 198n * 10n ** 27n);
  assert.equal(gmxMaxLeverageFromFactor(GMX_MIN_COLLATERAL_FACTOR), 5.05);
  assert.equal(gmxMaxLeverageFromFactor(0n), undefined);
  assert.ok(Math.abs(GMX_MAX_LEVERAGE - 5.0505) < 1e-3);
  // A losing leg is not liquidatable after the first of three ramp steps of the largest official gap
  // (spike 32% / 3), so it cannot be liquidated before the last step and leave the other leg naked.
  assert.ok(1 / GMX_MAX_LEVERAGE - 0.011 > 0.32 / 3);
  // keccak256(abi.encode(keccak256(abi.encode("MIN_COLLATERAL_FACTOR")), market))
  const base = keccak256(
    encodeAbiParameters([{ type: "string" }], ["MIN_COLLATERAL_FACTOR"]),
  );
  assert.equal(
    gmxMinCollateralFactorKey(MARKET),
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }],
        [base, MARKET],
      ),
    ),
  );
});
