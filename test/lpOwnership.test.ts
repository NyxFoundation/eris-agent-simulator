// Which Uniswap V3 positions count for an agent (sdk protocols/uniswapLpOwnership.ts).
//
// The scorer used to value the first LP_POSITIONS_LIMIT NFTs the holder enumeration returned. Anyone
// can mint a position with `recipient = <rival>`, and the position manager keeps a holder's tokens in
// insertion order, so 128 dust mints sent to a rival early in the epoch pushed every position the
// rival opened afterwards past the bound -- worth 0 at the bell -- while the rival's own observation
// (which enumerated without a bound) showed nothing wrong. Now only positions an agent obtained in a
// transaction it sent are valued and listed; the rest are reported as received.
//
// Every read is answered by a small fake of the position manager below: Transfer logs, blocks with
// their transactions, and the ERC-721 holder enumeration with OpenZeppelin's swap-and-pop order.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex, PublicClient } from "viem";
import { TOKENS, UNISWAP } from "@eris/sdk/constants.js";
import { marketsFor } from "@eris/sdk/markets.js";
import { PAR_STABLE_PRICES } from "@eris/sdk/stables.js";
import { getSqrtRatioAtTick } from "@eris/sdk/tickMath.js";
import { toPriceFeedAnswer } from "@eris/sdk/priceFeed.js";
import { setEnabledProtocolIds } from "@eris/sdk/protocols/enabled.js";
import {
  LP_POSITIONS_LIMIT,
  liquidityToTokenAmounts,
  lpOwnershipExclusions,
  uniswapAdapter,
} from "@eris/sdk/protocols/uniswap.js";
import {
  enumerateLpPositions,
  LP_OWN_TRACK_LIMIT,
  LpOwnershipLedger,
  LpOwnershipTracker,
  type LpTransfer,
} from "@eris/sdk/protocols/uniswapLpOwnership.js";
import type {
  SimContext,
  ValuationContext,
  ValuationRead,
} from "@eris/sdk/protocols/types.js";
import type { UniswapObservation } from "@eris/sdk/types.js";
import { driveValuation } from "./helpers/valuationRun.js";
import { LiveScorer } from "../core/src/realtime/liveScoring.js";
import { reconstructValueSeries } from "../core/src/realtime/reconstruct.js";
import { compareIntervalSeries } from "../core/src/realtime/coordinator.js";
import { RunLogger } from "../core/src/logger.js";

const AGENT = "0x00000000000000000000000000000000000a0001" as Address;
const ATTACKER = "0x00000000000000000000000000000000000b0002" as Address;
const BOB = "0x00000000000000000000000000000000000c0003" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const NPM = UNISWAP.nonfungiblePositionManager;
const lc = (a: string) => a.toLowerCase();

const FAIR = 2000;
const WETH = TOKENS.WETH.address;
const USDC = TOKENS.USDC.address;
const UNI_WETH = marketsFor("uniswap").find((m) => m.base === "WETH")!.uniswap!;
// Ticks written for WETH as token0 (about $2,000 at -200,311), mirrored when USDC sorts first.
const WETH_IS_TOKEN0 = WETH.toLowerCase() < USDC.toLowerCase();
const orient = (tick: number) => (WETH_IS_TOKEN0 ? tick : -tick);
const [TOKEN0, TOKEN1] = WETH_IS_TOKEN0 ? [WETH, USDC] : [USDC, WETH];
const TICK = orient(-200300);
const TICK_LOWER = Math.min(orient(-201000), orient(-199000));
const TICK_UPPER = Math.max(orient(-201000), orient(-199000));
const L = 700_000_000_000_000n;

// What one position of `liquidity` is worth at TICK and FAIR.
function lpValue(liquidity: bigint): number {
  const { amount0, amount1 } = liquidityToTokenAmounts({
    liquidity,
    sqrtPriceX96: getSqrtRatioAtTick(TICK),
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
  });
  const [weth, usdc] = WETH_IS_TOKEN0 ? [amount0, amount1] : [amount1, amount0];
  return (Number(weth) / 1e18) * FAIR + Number(usdc) / 1e6;
}

type Transfer = {
  block: number;
  logIndex: number;
  hash: Hex;
  sender: Address;
  from: Address;
  to: Address;
  tokenId: bigint;
};

// The position manager as far as these tests need it. Transfers are recorded in chain order.
class FakeNpm {
  head = 0;
  readonly transfers: Transfer[] = [];
  readonly liquidity = new Map<bigint, bigint>();
  readonly calls = { getBlock: 0, getLogs: 0, reads: new Map<string, number>() };
  private txs = 0;

  send(block: number, sender: Address, from: Address, to: Address, tokenId: bigint): void {
    const last = this.transfers.at(-1);
    assert.ok(!last || last.block <= block, "record transfers in chain order");
    const logIndex = this.transfers.filter((t) => t.block === block).length;
    const hash = `0x${(++this.txs).toString(16).padStart(64, "0")}` as Hex;
    this.transfers.push({ block, logIndex, hash, sender, from, to, tokenId });
    if (block > this.head) this.head = block;
  }

  mint(block: number, sender: Address, to: Address, tokenId: bigint, liquidity = L): void {
    this.liquidity.set(tokenId, liquidity);
    this.send(block, sender, ZERO, to, tokenId);
  }

  // OZ ERC721Enumerable: appended on receipt, the last one moved into the hole on removal.
  holdingsAt(owner: Address, block: number): bigint[] {
    const list: bigint[] = [];
    for (const t of this.transfers) {
      if (t.block > block) break;
      if (lc(t.from) === lc(owner)) {
        const i = list.indexOf(t.tokenId);
        const lastId = list.pop() as bigint;
        if (i >= 0 && i < list.length) list[i] = lastId;
      }
      if (lc(t.to) === lc(owner)) list.push(t.tokenId);
    }
    return list;
  }

  ownerAt(tokenId: bigint, block: number): Address | undefined {
    let owner: Address | undefined;
    for (const t of this.transfers) {
      if (t.block > block) break;
      if (t.tokenId === tokenId) owner = t.to;
    }
    return owner === undefined || owner === ZERO ? undefined : owner;
  }

  answer(read: { address: string; functionName: string; args?: readonly unknown[] }, block: number): unknown {
    this.calls.reads.set(read.functionName, (this.calls.reads.get(read.functionName) ?? 0) + 1);
    const npm = lc(read.address) === lc(NPM);
    switch (read.functionName) {
      case "latestAnswer":
        return toPriceFeedAnswer(FAIR);
      case "answerOf":
      case "getEthBalance":
        return 0n;
      case "balanceOf":
        return npm ? BigInt(this.holdingsAt(read.args?.[0] as Address, block).length) : 0n;
      case "tokenOfOwnerByIndex":
        return this.holdingsAt(read.args?.[0] as Address, block)[Number(read.args?.[1])];
      case "ownerOf":
        return this.ownerAt(read.args?.[0] as bigint, block);
      case "positions": {
        const tokenId = read.args?.[0] as bigint;
        if (this.ownerAt(tokenId, block) === undefined) return undefined;
        return [0n, ZERO, TOKEN0, TOKEN1, UNI_WETH.fee, TICK_LOWER, TICK_UPPER,
          this.liquidity.get(tokenId) ?? 0n, 0n, 0n, 0n, 0n] as const;
      }
      case "slot0":
        return [getSqrtRatioAtTick(TICK), TICK, 0, 0, 0, 0, true];
      case "feeGrowthGlobal0X128":
      case "feeGrowthGlobal1X128":
        return 0n;
      case "ticks":
        return [0n, 0n, 0n, 0n, 0n, 0n, 0, true];
      default:
        return undefined;
    }
  }

  client(): PublicClient {
    const self = this;
    const list = (v: unknown): string[] | undefined =>
      v === undefined || v === null ? undefined : (Array.isArray(v) ? v : [v]).map((a) => lc(String(a)));
    return {
      async getBlockNumber() {
        return BigInt(self.head);
      },
      async getLogs(q: { address?: string; args?: { from?: unknown; to?: unknown }; fromBlock: bigint; toBlock: bigint }) {
        // Only the position manager's Transfer is modelled; every other log query sees nothing.
        if (!q.address || lc(q.address) !== lc(NPM)) return [];
        self.calls.getLogs++;
        const tos = list(q.args?.to);
        const froms = list(q.args?.from);
        return self.transfers
          .filter(
            (t) =>
              t.block >= Number(q.fromBlock) &&
              t.block <= Number(q.toBlock) &&
              (!tos || tos.includes(lc(t.to))) &&
              (!froms || froms.includes(lc(t.from))),
          )
          .map((t) => ({
            args: { from: t.from, to: t.to, tokenId: t.tokenId },
            blockNumber: BigInt(t.block),
            logIndex: t.logIndex,
            transactionHash: t.hash,
            removed: false,
          }));
      },
      async getBlock({ blockNumber }: { blockNumber: bigint }) {
        self.calls.getBlock++;
        const seen = new Map<string, { hash: Hex; from: Address }>();
        for (const t of self.transfers)
          if (t.block === Number(blockNumber)) seen.set(t.hash, { hash: t.hash, from: t.sender });
        return { number: blockNumber, transactions: [...seen.values()] };
      },
      async readContract(c: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) {
        const r = self.answer(c, Number(c.blockNumber ?? BigInt(self.head)));
        if (r === undefined) throw new Error(`${c.functionName} reverted`);
        return r;
      },
      async multicall({ contracts, blockNumber }: { contracts: ValuationRead[]; blockNumber: bigint }) {
        return contracts.map((c) => {
          const result = self.answer(c, Number(blockNumber));
          return result === undefined
            ? { status: "failure" as const }
            : { status: "success" as const, result };
        });
      },
    } as unknown as PublicClient;
  }
}

function spam(npm: FakeNpm, block: number, count: number, firstId: bigint): void {
  for (let i = 0n; i < BigInt(count); i++)
    npm.mint(block, ATTACKER, AGENT, firstId + i);
}

function valuationCtx(ledger: LpOwnershipLedger, block: number): ValuationContext {
  return {
    publicClient: {} as never,
    blockNumber: block,
    horizonBlock: block,
    agents: [{ id: "a", address: AGENT }],
    activeStables: [USDC],
    fairByBase: () => ({ WETH: FAIR }),
    stablePrices: () => PAR_STABLE_PRICES,
    uniswapLp: ledger,
  };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("positions minted to an agent by another address neither join nor displace its own", async () => {
  const npm = new FakeNpm();
  spam(npm, 101, LP_POSITIONS_LIMIT + 2, 1n); // early in the epoch, valuable even
  npm.mint(102, AGENT, AGENT, 500n);
  const tracker = new LpOwnershipTracker({ publicClient: npm.client(), accounts: [AGENT], fromBlock: 100 });
  await tracker.syncTo(102);

  const held = tracker.ledger.heldAt(AGENT, 102);
  assert.deepEqual(held?.tokenIds, [500n]);
  assert.equal(held?.heldOwn, 1);
  // What the old rule read: the holder enumeration's first LP_POSITIONS_LIMIT are all spam.
  const enumerated = await enumerateLpPositions(npm.client(), AGENT, 102);
  assert.equal(enumerated.tokenIds.length, LP_POSITIONS_LIMIT);
  assert.ok(!enumerated.tokenIds.includes(500n), "the attack the ledger closes");
  // Received positions are said, not silent; nothing of the agent's own is cut.
  assert.deepEqual(lpOwnershipExclusions(held!, enumerated.balance), [
    { source: "uniswap-lp-received", amountRaw: String(LP_POSITIONS_LIMIT + 2), reason: "received" },
  ]);
  // Sender resolution is one block read per block with an arrival, however many arrived in it.
  assert.equal(npm.calls.getBlock, 2);
});

test("a position the agent sends away stops counting; one sent back by someone else is received", async () => {
  const npm = new FakeNpm();
  npm.mint(102, AGENT, AGENT, 500n);
  npm.send(104, AGENT, AGENT, BOB, 500n);
  npm.send(106, BOB, BOB, AGENT, 500n); // BOB's transaction
  npm.mint(107, BOB, BOB, 600n);
  npm.send(108, AGENT, BOB, AGENT, 600n); // the agent pulls it as an approved operator: its own act
  const tracker = new LpOwnershipTracker({ publicClient: npm.client(), accounts: [AGENT], fromBlock: 100 });
  await tracker.syncTo(110);
  const at = (b: number) => tracker.ledger.heldAt(AGENT, b)?.tokenIds;
  assert.deepEqual(at(103), [500n]);
  assert.deepEqual(at(105), []);
  assert.deepEqual(at(107), []);
  assert.deepEqual(at(108), [600n]);
  assert.deepEqual(
    lpOwnershipExclusions(tracker.ledger.heldAt(AGENT, 108)!, 2n).map((e) => [e.source, e.amountRaw]),
    [["uniswap-lp-received", "1"]],
  );
});

test("own positions past the bound are the agent's own doing: reported unscanned, and move up when it closes some", () => {
  const ledger = new LpOwnershipLedger([AGENT]);
  const own = (block: number, id: number): LpTransfer => ({
    from: ZERO, to: AGENT, tokenId: BigInt(id), blockNumber: block, logIndex: 0, txFrom: AGENT,
  });
  ledger.ingest(Array.from({ length: LP_POSITIONS_LIMIT + 3 }, (_, i) => own(100 + i, i + 1)));
  const end = 100 + LP_POSITIONS_LIMIT + 3;
  const held = ledger.heldAt(AGENT, end)!;
  assert.equal(held.tokenIds.length, LP_POSITIONS_LIMIT);
  assert.equal(held.tokenIds[0], 1n);
  assert.deepEqual(
    lpOwnershipExclusions(held, BigInt(LP_POSITIONS_LIMIT + 3)).map((e) => [e.source, e.amountRaw, e.reason]),
    [["uniswap-lp-unscanned", "3", "read-failed"]],
  );
  // Burn the first three: the three past the bound are valued now.
  ledger.ingest([1, 2, 3].map((id, i) => ({
    from: AGENT, to: ZERO, tokenId: BigInt(id), blockNumber: end + 1, logIndex: i, txFrom: AGENT,
  })));
  const after = ledger.heldAt(AGENT, end + 1)!;
  assert.equal(after.tokenIds.length, LP_POSITIONS_LIMIT);
  assert.ok(after.tokenIds.includes(BigInt(LP_POSITIONS_LIMIT + 3)));
  assert.deepEqual(lpOwnershipExclusions(after, BigInt(LP_POSITIONS_LIMIT)), []);
});

test("past LP_OWN_TRACK_LIMIT own acquisitions are counted, so the ledger stays bounded", () => {
  const ledger = new LpOwnershipLedger([AGENT]);
  ledger.ingest(Array.from({ length: LP_OWN_TRACK_LIMIT + 2 }, (_, i) => ({
    from: ZERO, to: AGENT, tokenId: BigInt(i + 1), blockNumber: 100, logIndex: i, txFrom: AGENT,
  })));
  const held = ledger.heldAt(AGENT, 100)!;
  assert.equal(held.heldOwn, LP_OWN_TRACK_LIMIT);
  assert.equal(held.ownOverflow, 2);
  assert.equal(ledger.snapshot().accounts[lc(AGENT)].own.length, LP_OWN_TRACK_LIMIT);
  assert.deepEqual(
    lpOwnershipExclusions(held, BigInt(LP_OWN_TRACK_LIMIT + 2)).map((e) => [e.source, e.amountRaw]),
    [["uniswap-lp-unscanned", String(LP_OWN_TRACK_LIMIT + 2 - LP_POSITIONS_LIMIT)]],
  );
});

// The live scorer syncs every block (a block ahead of the boundary it reads) and prunes after each
// boundary; the sweep syncs once to the run's end. Both must hold the same positions at each
// boundary, also across a checkpoint written and restored in the middle.
test("live (per-block sync, pruned, restored mid-way) and sweep (one sync) agree at every boundary", async () => {
  const npm = new FakeNpm();
  spam(npm, 99, 40, 1n); // before the ledger's first block: in the holder enumeration it seeds from
  npm.mint(101, AGENT, AGENT, 500n);
  spam(npm, 103, 10, 100n);
  npm.mint(105, AGENT, AGENT, 501n, 2n * L);
  npm.send(109, AGENT, AGENT, BOB, 500n);
  npm.send(113, BOB, BOB, AGENT, 500n);
  npm.mint(117, AGENT, AGENT, 502n);
  npm.send(121, AGENT, AGENT, ZERO, 501n); // burned
  npm.head = 130;
  const client = npm.client();
  const sweep = new LpOwnershipTracker({ publicClient: client, accounts: [AGENT], fromBlock: 100 });
  await sweep.syncTo(130);
  let live = new LpOwnershipTracker({ publicClient: client, accounts: [AGENT], fromBlock: 100 });
  for (let b = 100; b <= 129; b++) {
    await live.syncTo(b + 1);
    if (b === 118) {
      const restored = new LpOwnershipTracker({ publicClient: client, accounts: [AGENT], fromBlock: 100 });
      restored.restore(JSON.parse(JSON.stringify(live.snapshot())));
      live = restored;
    }
    if (b % 4 !== 0) continue;
    assert.deepEqual(live.ledger.heldAt(AGENT, b), sweep.ledger.heldAt(AGENT, b), `boundary ${b}`);
    live.ledger.prune(b);
  }
  // The 40 sent before the ledger began were seeded (provenance unknown, at most the bound), and
  // never displace the agent's own: those come first.
  const at104 = sweep.ledger.heldAt(AGENT, 104)!;
  assert.equal(at104.tokenIds[0], 500n);
  assert.equal(at104.heldSeeded, 40);
  // A pruned ledger keeps only what is still held.
  assert.deepEqual(
    live.snapshot().ledger.accounts[lc(AGENT)].own.map((h) => h.tokenId),
    ["502"],
  );
});

// ---------------------------------------------------------------------------
// The adapter's valuation with the ledger
// ---------------------------------------------------------------------------

test("valueAtBlock: spam does not change the agent's value, is reported, and does not grow the reads", async () => {
  const run = async (withSpam: boolean) => {
    const npm = new FakeNpm();
    if (withSpam) spam(npm, 101, LP_POSITIONS_LIMIT + 2, 1n);
    npm.mint(102, AGENT, AGENT, 500n);
    if (withSpam) spam(npm, 103, 50, 1000n);
    npm.mint(103, AGENT, AGENT, 501n, 2n * L);
    const tracker = new LpOwnershipTracker({ publicClient: npm.client(), accounts: [AGENT], fromBlock: 100 });
    await tracker.syncTo(104);
    return driveValuation(
      uniswapAdapter.valueAtBlock!(valuationCtx(tracker.ledger, 104)),
      (read) => npm.answer(read, 104),
    );
  };
  const clean = await run(false);
  const spammed = await run(true);
  const expected = lpValue(L) + lpValue(2n * L);
  assert.ok(Math.abs(clean.values.a.valueUsdc - expected) < 1e-6);
  assert.equal(spammed.values.a.valueUsdc, clean.values.a.valueUsdc);
  assert.equal(spammed.values.a.liquidatableValueUsdc, clean.values.a.liquidatableValueUsdc);
  assert.deepEqual(clean.values.a.unpriced, []);
  assert.deepEqual(spammed.values.a.unpriced, [
    { source: "uniswap-lp-received", amountRaw: String(LP_POSITIONS_LIMIT + 52), reason: "received" },
  ]);
  // The same reads, stage for stage: 180 NFTs sent to the agent cost the scorer nothing.
  assert.deepEqual(
    spammed.stages.map((s) => s.length),
    clean.stages.map((s) => s.length),
  );
  assert.ok(!spammed.stages.flat().some((r) => r.functionName === "tokenOfOwnerByIndex"));
});

test("valueAtBlock: a position the ledger holds but the chain does not is not valued, and says why", async () => {
  const npm = new FakeNpm();
  npm.mint(102, AGENT, AGENT, 500n);
  const ledger = new LpOwnershipLedger([AGENT]);
  ledger.ingest([{ from: ZERO, to: AGENT, tokenId: 500n, blockNumber: 102, logIndex: 0, txFrom: AGENT }]);
  // The chain moved it on in a block the ledger never saw.
  npm.send(103, AGENT, AGENT, BOB, 500n);
  const { values } = await driveValuation(
    uniswapAdapter.valueAtBlock!(valuationCtx(ledger, 104)),
    (read) => npm.answer(read, 104),
  );
  assert.equal(values.a.valueUsdc, 0);
  assert.equal(values.a.unpriced[0]?.source, "uniswap-lp:500");
  assert.match(values.a.unpriced[0]?.read ?? "", /ownerOf is .*not this agent/);
});

// ---------------------------------------------------------------------------
// The live scorer and the post-run sweep, end to end
// ---------------------------------------------------------------------------

function scoringChain() {
  const npm = new FakeNpm();
  npm.mint(99, AGENT, AGENT, 400n); // before the bell, in a transaction the agent sent
  spam(npm, 100, LP_POSITIONS_LIMIT, 1n); // fills the holder enumeration on the first block
  npm.mint(102, AGENT, AGENT, 500n);
  spam(npm, 106, 20, 1000n);
  npm.mint(107, AGENT, AGENT, 501n, 2n * L);
  npm.send(110, AGENT, AGENT, BOB, 400n);
  npm.head = 112;
  return npm;
}

const common = (publicClient: PublicClient) => ({
  publicClient,
  agents: [{ id: "a", address: AGENT }],
  enabledIds: ["uniswap" as const],
  activeStables: [USDC],
  priceFeed: "0x00000000000000000000000000000000feed0001" as Address,
  markMedianBlocks: 5,
});

const tmp = () => mkdtempSync(join(tmpdir(), "eris-lp-ownership-"));

test("live and swept boundaries value the same own positions, with spam all around them", async () => {
  setEnabledProtocolIds(["uniswap"]);
  try {
    const npm = scoringChain();
    const client = npm.client();
    const live = new LiveScorer({
      ...common(client),
      logger: new RunLogger(tmp(), "live"),
      runStartBlock: 100,
      intervalBlocks: 4,
      sampleMarket: false,
      lpLedgerFromBlock: 98,
    });
    for (let b = 100; b <= 112; b++) await live.onBlock(b);
    const swept = await reconstructValueSeries({
      ...common(client),
      logger: new RunLogger(tmp(), "swept"),
      fromBlock: 100,
      toBlock: 112,
      intervalBlocks: 4,
      lpLedgerFromBlock: 98,
    });
    const liveSeries = live.series();
    assert.ok(liveSeries && swept.intervalSeries);
    assert.deepEqual(liveSeries.boundaryBlocks, [100, 104, 108, 112]);
    const agreement = compareIntervalSeries(liveSeries, swept.intervalSeries);
    assert.equal(agreement.compared, 4);
    assert.equal(agreement.maxAbsDiffUsdc, 0);
    const expected = [
      lpValue(L), // 400
      2 * lpValue(L), // 400 + 500
      2 * lpValue(L) + lpValue(2n * L), // + 501
      lpValue(L) + lpValue(2n * L), // 400 sent away
    ];
    liveSeries.valuesByAgent.a.forEach((v, i) =>
      assert.ok(Math.abs((v ?? 0) - expected[i]) < 1e-6, `boundary ${i}: ${v} vs ${expected[i]}`),
    );
    // The received ones are on the record, under their own source.
    const received = swept.unpricedHoldings.find((h) => h.source === "uniswap-lp-received");
    assert.equal(received?.reason, "received");
    assert.equal(received?.amountRaw, String(LP_POSITIONS_LIMIT + 20));
  } finally {
    setEnabledProtocolIds([]);
  }
});

// A practice period's checkpoint carries the ledger (periodResume.ts), so a restart continues it; a
// checkpoint from before the ledger existed is rebuilt from what each agent holds at the restart.
test("a restored scorer continues the ledger, and a pre-ledger checkpoint is rebuilt", async () => {
  setEnabledProtocolIds(["uniswap"]);
  try {
    const npm = scoringChain();
    const client = npm.client();
    const scorer = () =>
      new LiveScorer({
        ...common(client),
        logger: new RunLogger(tmp(), "run"),
        runStartBlock: 100,
        intervalBlocks: 4,
        sampleMarket: false,
        lpLedgerFromBlock: 98,
      });
    const straight = scorer();
    for (let b = 100; b <= 112; b++) await straight.onBlock(b);

    const first = scorer();
    for (let b = 100; b <= 105; b++) await first.onBlock(b);
    const saved = JSON.parse(JSON.stringify(first.snapshot()));
    assert.ok(saved.lpOwnership, "the checkpoint carries the ledger");
    const lines = first
      .series()!
      .boundaryBlocks.map((blockNumber, i) => ({ blockNumber, values: { a: first.series()!.valuesByAgent.a[i] } }));

    const resumed = scorer();
    resumed.restore(saved, lines);
    for (let b = 106; b <= 112; b++) await resumed.onBlock(b);
    assert.deepEqual(resumed.series(), straight.series());

    // Before the ledger: seeded from the holder enumeration at the first block after the restart
    // (106). Bounded and of unknown provenance -- here the agent's 400 and then the spam fill it --
    // and the agent's own positions from after the restart (501) are vouched for by the logs again,
    // ahead of every seeded one.
    const { lpOwnership: _dropped, ...preLedger } = saved;
    const rebuilt = scorer();
    rebuilt.restore(preLedger, lines);
    for (let b = 106; b <= 108; b++) await rebuilt.onBlock(b);
    const tracker = rebuilt.uniswapLpOwnership!;
    const at108 = tracker.ledger.heldAt(AGENT, 108)!;
    assert.equal(at108.heldSeeded, LP_POSITIONS_LIMIT);
    assert.deepEqual(at108.tokenIds.slice(0, 2), [501n, 400n]);
    // The seeded 400 leaves with the agent's transfer at 110, like any holding.
    for (let b = 109; b <= 112; b++) await rebuilt.onBlock(b);
    assert.equal(tracker.ledger.heldAt(AGENT, 112)?.heldSeeded, LP_POSITIONS_LIMIT - 1);
    assert.equal(tracker.ledger.heldAt(AGENT, 112)?.tokenIds[0], 501n);
  } finally {
    setEnabledProtocolIds([]);
  }
});

// ---------------------------------------------------------------------------
// The agent runtime's observation
// ---------------------------------------------------------------------------

test("observe lists exactly the positions the agent obtained itself, and spam does not grow its reads", async () => {
  const npm = new FakeNpm();
  npm.head = 100;
  const client = npm.client();
  const market = marketsFor("uniswap").find((m) => m.base === "WETH")!;
  const sqrtPriceX96 = getSqrtRatioAtTick(TICK);
  const state = {
    priceUsdcPerWeth: FAIR,
    tick: TICK,
    tickSpacing: UNI_WETH.tickSpacing,
    liquidity: 0n,
    markets: [{ market, priceUsdcPerWeth: FAIR, tick: TICK, sqrtPriceX96, tickSpacing: UNI_WETH.tickSpacing, liquidity: 0n }],
  };
  const ctx = { publicClient: client, fairPrices: { WETH: FAIR } } as unknown as SimContext;
  const observe = () => uniswapAdapter.observe(ctx, state, AGENT, FAIR) as Promise<UniswapObservation>;

  // The runtime's first observation, before anything is held: the ledger begins here.
  assert.deepEqual((await observe()).positions, []);
  spam(npm, 101, 300, 1n);
  npm.mint(102, AGENT, AGENT, 500n);
  const before = npm.calls.reads.get("positions") ?? 0;
  const obs = await observe();
  assert.deepEqual(obs.positions.map((p) => p.tokenId), ["500"]);
  assert.ok(Math.abs(obs.positions[0].valueUsdc - lpValue(L)) < 1e-6);
  assert.equal(obs.unlistedPositionCount, 300);
  assert.equal((npm.calls.reads.get("positions") ?? 0) - before, 1, "one position read, not 301");
  assert.equal(npm.calls.reads.get("tokenOfOwnerByIndex") ?? 0, 0);
  // What validate() accepts: the agent can manage its own position, and nothing it was sent.
  assert.equal(
    uniswapAdapter.validate({ type: "collectFees", tokenId: "500" }, { protocols: { uniswap: obs } } as never, {} as never).ok,
    true,
  );
  assert.equal(
    uniswapAdapter.validate({ type: "collectFees", tokenId: "1" }, { protocols: { uniswap: obs } } as never, {} as never).ok,
    false,
  );
  // And the end-of-run value counts the same set.
  assert.ok(Math.abs((await uniswapAdapter.valueUsdc(ctx, AGENT, state, FAIR)) - lpValue(L)) < 1e-6);
});

// The reference runtime pins a fresh client to every block (runtime/pinnedClient.ts), so the ledger
// cannot hang off the client: read.ts keeps one tracker for the process on the shared ctx and says
// which block the observation is read at.
test("observe with the runtime's tracker: a fresh client per block, answered for the observation's block", async () => {
  const npm = new FakeNpm();
  npm.head = 100;
  const market = marketsFor("uniswap").find((m) => m.base === "WETH")!;
  const state = {
    priceUsdcPerWeth: FAIR,
    tick: TICK,
    tickSpacing: UNI_WETH.tickSpacing,
    liquidity: 0n,
    markets: [{ market, priceUsdcPerWeth: FAIR, tick: TICK, sqrtPriceX96: getSqrtRatioAtTick(TICK), tickSpacing: UNI_WETH.tickSpacing, liquidity: 0n }],
  };
  const tracker = new LpOwnershipTracker({ publicClient: npm.client(), accounts: [AGENT] });
  const observeAt = (block: number) =>
    uniswapAdapter.observe(
      { publicClient: npm.client(), fairPrices: { WETH: FAIR }, uniswapLpOwnership: tracker, observationBlock: block } as unknown as SimContext,
      state,
      AGENT,
      FAIR,
    ) as Promise<UniswapObservation>;
  await observeAt(100);
  spam(npm, 101, LP_POSITIONS_LIMIT, 1n);
  npm.mint(102, AGENT, AGENT, 500n);
  npm.mint(104, AGENT, AGENT, 501n); // the head has moved on past the observation's block
  const obs = await observeAt(103);
  assert.deepEqual(obs.positions.map((p) => p.tokenId), ["500"]);
  assert.equal(tracker.syncedThrough, 103);
  assert.deepEqual((await observeAt(104)).positions.map((p) => p.tokenId), ["500", "501"]);
});
