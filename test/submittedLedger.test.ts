// Issue #134: the coordinator's record of what the environment submitted is read once, at the
// blocks.csv flush, and must not outlive that read -- a month-long period otherwise grows it by ~1M
// entries a day until the process hits its heap limit.
import test from "node:test";
import assert from "node:assert/strict";
import { SubmittedLedger } from "../core/src/realtime/submittedLedger.js";

test("an attributed transaction is removed on read, whatever the case of the hash", () => {
  const ledger = new SubmittedLedger<string>(10);
  ledger.record("0xABC", "oracle");
  assert.equal(ledger.size, 1);
  assert.equal(ledger.take("0xabc"), "oracle");
  assert.equal(ledger.size, 0);
  assert.equal(ledger.take("0xabc"), undefined);
});

test("a transaction that is never mined is swept once it has sat unread past the bound", () => {
  const ledger = new SubmittedLedger<string>(10);
  ledger.sweep(100);
  ledger.record("0xdropped", "flow");
  assert.equal(ledger.sweep(105), 0, "still inside the bound");
  assert.equal(ledger.sweep(110), 0, "exactly at the bound is kept");
  assert.equal(ledger.sweep(111), 1, "one flushed block past it is gone");
  assert.equal(ledger.size, 0);
});

test("a late-mined transaction inside the bound keeps its attribution", () => {
  const ledger = new SubmittedLedger<string>(10);
  ledger.sweep(50);
  ledger.record("0xslow", "stress");
  ledger.sweep(58);
  assert.equal(ledger.take("0xslow"), "stress");
});

test("the size stays bounded across a long run of flushes (~23 environment txs a block)", () => {
  const retain = 600;
  const ledger = new SubmittedLedger<{ ownerId: string }>(retain);
  let peak = 0;
  for (let block = 1; block <= 20_000; block++) {
    for (let i = 0; i < 23; i++)
      ledger.record(`0x${block.toString(16)}-${i}`, { ownerId: "oracle" });
    // One transaction per block is never mined (dropped or replaced); the rest land next block.
    if (block > 1)
      for (let i = 1; i < 23; i++)
        ledger.take(`0x${(block - 1).toString(16)}-${i}`);
    ledger.sweep(block - 1);
    peak = Math.max(peak, ledger.size);
  }
  // Mined entries leave within a block; only the never-mined ones accumulate, and only up to the
  // retain window. Without the read-removal and the sweep this would be 460,000.
  assert.ok(
    peak <= retain + 2 + 23,
    `peak ${peak} should be bounded by the retain window`,
  );
});

test("the flush position never moves backwards", () => {
  const ledger = new SubmittedLedger<string>(10);
  ledger.sweep(100);
  ledger.sweep(40); // a stale caller does not rewind the stamp
  ledger.record("0xa", "oracle");
  assert.equal(ledger.sweep(110), 0);
  assert.equal(ledger.sweep(111), 1);
});

test("a non-positive bound is refused", () => {
  assert.throws(() => new SubmittedLedger<string>(0), /positive integer/);
});
