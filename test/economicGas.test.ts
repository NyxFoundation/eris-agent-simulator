import test from "node:test";
import assert from "node:assert/strict";
import { bigintToStorageWord } from "@eris/sdk/chain.js";
import { toPriceFeedAnswer } from "../core/src/realtime/priceFeed.js";
import { loadConfig } from "../core/src/config.js";

// ADR 0011 §1: the 32-byte word encoding used when moving price settlement from a mempool tx to a
// direct storage write. Pins slot-value correctness (int256 two's complement / width) in isolation, off-chain.

test("bigintToStorageWord: zero-pads to a 32-byte width", () => {
  assert.equal(bigintToStorageWord(0n), `0x${"0".repeat(64)}`);
  assert.equal(bigintToStorageWord(1n), `0x${"0".repeat(63)}1`);
  // hex string is always 0x + 64 digits
  assert.match(bigintToStorageWord(123456789n), /^0x[0-9a-f]{64}$/);
});

test("bigintToStorageWord: stores a positive price answer as-is", () => {
  // $3000 (8-decimal fixed point) = 3000_00000000
  const answer = toPriceFeedAnswer(3000);
  assert.equal(answer, 300000000000n);
  const word = bigintToStorageWord(answer);
  // 300000000000 goes in the low bytes, high bytes are zero
  assert.equal(BigInt(word), answer);
});

test("bigintToStorageWord: represents negative int256 values in two's complement", () => {
  assert.equal(bigintToStorageWord(-1n), `0x${"f".repeat(64)}`);
  // -2^255 (int256 minimum) also fits in 32 bytes
  const min = -(1n << 255n);
  const word = bigintToStorageWord(min);
  assert.equal(BigInt(word), (1n << 256n) + min);
  assert.match(word, /^0x[0-9a-f]{64}$/);
});

test("config: ERIS_ECONOMIC_GAS=1 sets economicGas (default false)", () => {
  assert.equal(loadConfig({}).economicGas, false);
  assert.equal(loadConfig({ ERIS_ECONOMIC_GAS: "1" }).economicGas, true);
  assert.equal(loadConfig({ ERIS_ECONOMIC_GAS: "0" }).economicGas, false);
});

test("config: economicGas shrinks the endowment to a modest placeholder (ADR 0011 §2)", () => {
  // default (0010) stays at 100 ETH
  assert.equal(loadConfig({}).initialEthWei, 100_000_000_000_000_000_000n);
  // economic mode uses a placeholder (3 ETH), smaller than 0010 to make gas a real cost
  const eco = loadConfig({ ERIS_ECONOMIC_GAS: "1" }).initialEthWei;
  assert.equal(eco, 3_000_000_000_000_000_000n);
  assert.ok(eco < 100_000_000_000_000_000_000n);
  // an explicit INITIAL_ETH_WEI takes precedence even in economic mode (overrides the calibrated value)
  assert.equal(
    loadConfig({
      ERIS_ECONOMIC_GAS: "1",
      INITIAL_ETH_WEI: "7000000000000000000",
    }).initialEthWei,
    7_000_000_000_000_000_000n,
  );
});
