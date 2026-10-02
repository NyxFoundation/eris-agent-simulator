// A transaction from an address an agent's wallet funded is the agent's (issue #212).
//
// blocks.csv attributed a mined transaction by its sender, and a sender the run did not know went in
// as `external`, which none of the three post-run checks read. Moving ETH or tokens to a second EOA
// and sending from there therefore stepped out of the fee rule, the gas budget and the unlogged-tx
// reconciliation. The ledger below follows the value from the wallet, the checks accept its map, and
// the matrix carries the flag.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, pad, type Address } from "viem";
import {
  DerivedSenderLedger,
  ERC20_TRANSFER_TOPIC,
} from "../core/src/realtime/derivedSenders.js";
import {
  checkFeeViolations,
  checkGasViolations,
  findUnloggedAgentTxs,
} from "../core/src/postRunCheck.js";
import { BLOCKS_CSV_COLUMNS } from "../core/src/logger.js";
import { scoresFromSummary } from "../core/src/backtest/scenarioScores.js";

const WALLET_A = "0x00000000000000000000000000000000000000a1";
const WALLET_B = "0x00000000000000000000000000000000000000b1";
const FLOW = "0x00000000000000000000000000000000000000f1";
const EOA2 = "0x00000000000000000000000000000000000000e2";
const EOA3 = "0x00000000000000000000000000000000000000e3";
const STRANGER = "0x00000000000000000000000000000000000000ff";
const CONTRACT = "0x00000000000000000000000000000000000000c0";
const POOL = "0x00000000000000000000000000000000000000d0";
const USDC = "0x00000000000000000000000000000000000000cc";
const FAKE_TOKEN = "0x00000000000000000000000000000000000000fa";

function ledger() {
  const wallets = new Map([
    [WALLET_A, "alice"],
    [WALLET_B, "bob"],
  ]);
  return new DerivedSenderLedger({
    agentOf: (a) => wallets.get(a),
    isKnown: (a) => wallets.has(a) || a === FLOW,
    trackedTokens: () => new Set([USDC]),
  });
}

function transferLog(token: string, from: string, to: string, amount = 1_000_000n) {
  return {
    address: token,
    topics: [
      ERC20_TRANSFER_TOPIC,
      pad(from as Address, { size: 32 }),
      pad(to as Address, { size: 32 }),
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  };
}

const tx = (
  from: string,
  to: string | null,
  opts: { value?: bigint; logs?: ReturnType<typeof transferLog>[]; contractAddress?: string; block?: number } = {},
) => ({
  from,
  to,
  value: opts.value ?? 0n,
  blockNumber: opts.block ?? 10,
  contractAddress: opts.contractAddress ?? null,
  logs: opts.logs ?? [],
});

test("an address the wallet sent ETH to is the agent's sender from then on, transitively", () => {
  const l = ledger();
  assert.equal(l.senderOf(EOA2), undefined);
  l.observe(tx(WALLET_A, EOA2, { value: 10n ** 18n, block: 10 }), "alice");
  const d = l.senderOf(EOA2);
  assert.ok(d);
  assert.equal(d.ownerId, "alice");
  assert.equal(d.fundedBy, WALLET_A);
  assert.equal(d.via, "eth");
  assert.equal(d.fundedAtBlock, 10);
  assert.equal(d.txCount, 0, "nothing sent yet, so nothing to report yet");

  // EOA2 sends, and hands ETH on to EOA3: a second hop, still alice's.
  l.observe(tx(EOA2, EOA3, { value: 1n, block: 11 }), "alice");
  assert.equal(l.senderOf(EOA2)?.txCount, 1);
  assert.equal(l.senderOf(EOA3)?.fundedBy, EOA2);
  assert.equal(l.ownerOf(EOA3), "alice");

  l.observe(tx(EOA3, POOL, { value: 1n, block: 12 }), "alice");
  assert.deepEqual(
    l.byOwner().alice.map((d) => [d.address, d.txCount]),
    [
      [EOA2, 1],
      [EOA3, 1],
    ],
  );
  // The map for the checks carries every derived address, sender or not.
  assert.equal(l.ownerByAddress().get(POOL), "alice");
});

test("a token transfer out of the wallet, a contract it created, and tokens that contract pays out all derive", () => {
  const l = ledger();
  l.observe(tx(WALLET_A, USDC, { logs: [transferLog(USDC, WALLET_A, EOA2)] }), "alice");
  assert.equal(l.senderOf(EOA2)?.via, "token");
  l.observe(tx(WALLET_A, null, { contractAddress: CONTRACT }), "alice");
  assert.equal(l.senderOf(CONTRACT)?.via, "create");
  // The contract forwards tokens to a fresh EOA inside alice's own transaction.
  l.observe(tx(WALLET_A, CONTRACT, { logs: [transferLog(USDC, CONTRACT, EOA3)] }), "alice");
  assert.equal(l.senderOf(EOA3)?.fundedBy, CONTRACT);
  assert.equal(l.ownerOf(EOA3), "alice");
});

test("a swap's pool leg, somebody else's pull, a fake token and a zero transfer derive nobody", () => {
  const l = ledger();
  // alice swaps: USDC leaves her wallet to the pool, and the pool pays a stranger in the same block
  // in a transaction the stranger sent (a different owner on that row).
  l.observe(tx(WALLET_A, POOL, { logs: [transferLog(USDC, WALLET_A, POOL)] }), "alice");
  assert.equal(l.ownerOf(POOL), "alice", "a recipient, harmless until it sends (a pool never does)");
  // bob swaps against the pool: the pool's leg is not bob's, and alice's recipient is not re-owned.
  l.observe(tx(WALLET_B, POOL, { logs: [transferLog(USDC, POOL, WALLET_B)] }), "bob");
  assert.equal(l.ownerOf(POOL), "alice");
  // A stranger's transaction pulls alice's USDC through an allowance to EOA2: alice did not send it.
  // (The caller never calls observe for an external sender; the Transfer would not count anyway.)
  l.observe(tx(STRANGER, CONTRACT, { logs: [transferLog(USDC, WALLET_A, EOA2)] }), "bob");
  assert.equal(l.senderOf(EOA2), undefined);
  // A token the run does not price can say anything.
  l.observe(tx(WALLET_A, FAKE_TOKEN, { logs: [transferLog(FAKE_TOKEN, WALLET_A, EOA3)] }), "alice");
  assert.equal(l.senderOf(EOA3), undefined);
  // A zero-amount transfer moved nothing.
  l.observe(tx(WALLET_A, USDC, { logs: [transferLog(USDC, WALLET_A, EOA3, 0n)] }), "alice");
  assert.equal(l.senderOf(EOA3), undefined);
  // A known wallet is never derived, and the first funder keeps a recipient.
  l.observe(tx(WALLET_A, WALLET_B, { value: 5n }), "alice");
  l.observe(tx(WALLET_A, FLOW, { value: 5n }), "alice");
  assert.equal(l.senderOf(WALLET_B), undefined);
  assert.equal(l.senderOf(FLOW), undefined);
  l.observe(tx(WALLET_A, EOA2, { value: 5n }), "alice");
  l.observe(tx(WALLET_B, EOA2, { value: 5n }), "bob");
  assert.equal(l.senderOf(EOA2)?.ownerId, "alice");
  assert.deepEqual(l.byOwner(), {}, "nothing derived has sent, so there is nothing to flag");
});

// ---------------------------------------------------------------------------
// The checks read a derived sender's rows as the agent's
// ---------------------------------------------------------------------------

function csv(rows: Array<Record<string, string>>): string {
  const header = BLOCKS_CSV_COLUMNS.join(",");
  return [
    header,
    ...rows.map((r) => BLOCKS_CSV_COLUMNS.map((c) => r[c] ?? "").join(",")),
  ].join("\n");
}

const row = (o: Record<string, string>) => ({
  round: "100",
  blockNumber: "100",
  txIndex: "0",
  hash: "0x1",
  from: WALLET_A,
  priorityFeeWei: "1",
  status: "success",
  ownerId: "alice",
  role: "agent",
  ...o,
});

test("rows a derived sender wrote before its funding was seen are the agent's in every check", () => {
  const derived = new Map([[EOA2, "alice"]]);
  const text = csv([
    // Written as external: EOA2 sent (for free, at tip 0) before the funding landed.
    row({ hash: "0xe1", from: EOA2, ownerId: EOA2, role: "external", gasUsed: "20000000", priorityFeeWei: "9000000000", maxFeePerGasWei: "9000000000" }),
    // Attributed in place once funded: ownerId is already the agent's, derivedFrom says why.
    row({ hash: "0xe2", from: EOA2, txIndex: "1", gasUsed: "11000000", derivedFrom: WALLET_A }),
    // The wallet itself, logged by the runtime.
    row({ hash: "0xa1", txIndex: "2", gasUsed: "1000000" }),
    // An unrelated stranger stays external.
    row({ hash: "0xs1", from: STRANGER, ownerId: STRANGER, role: "external", txIndex: "3", gasUsed: "25000000", priorityFeeWei: "9000000000" }),
  ]);
  const cap = 5_000_000_000n;
  // Fee rule: the pre-funding row is over the cap, under alice's name.
  assert.deepEqual(
    checkFeeViolations(text, cap, derived).map((v) => [v.ownerId, v.hash]),
    [["alice", "0xe1"]],
  );
  assert.deepEqual(checkFeeViolations(text, cap), [], "without the map it was invisible");
  // Gas budget: 20M + 11M + 1M in one block is over 30M for alice; nobody over per tx.
  const gas = checkGasViolations(text, { maxTxGas: 30_000_000n, maxAgentBlockGas: 30_000_000n }, derived);
  assert.deepEqual(gas.map((v) => [v.ownerId, v.kind, v.gasUsed]), [["alice", "per-block", "32000000"]]);
  assert.deepEqual(
    checkGasViolations(text, { maxTxGas: 30_000_000n, maxAgentBlockGas: 30_000_000n }),
    [],
    "the split across two senders used to keep each under the sum",
  );
  // Reconciliation: the runtime logged only the wallet's own send.
  const unlogged = findUnloggedAgentTxs(text, new Map([["alice", new Set(["0xa1"])]]), derived);
  assert.deepEqual(unlogged.map((u) => u.hash), ["0xe1", "0xe2"]);
  // The stranger is still nobody's.
  assert.ok(!unlogged.some((u) => u.ownerId === STRANGER));
});

test("the matrix flag names the mechanism beside the score", () => {
  const scores = scoresFromSummary(
    {
      runDir: "x",
      violations: [],
      agents: [
        { id: "alice", pnlUsdc: 1, derivedSenders: [{ address: EOA2, txCount: 3 }, { address: EOA3, txCount: 1 }] },
        { id: "bob", pnlUsdc: 2 },
      ],
    },
    [],
  );
  assert.deepEqual(scores.find((s) => s.id === "alice")?.flags, [
    "4 on-chain tx(s) sent from 2 address(es) the agent's wallet funded (attributed to the agent; rules §8, for the operator to judge)",
  ]);
  assert.equal(scores.find((s) => s.id === "bob")?.flags, undefined);
});
