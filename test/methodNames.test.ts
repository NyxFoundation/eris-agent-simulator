// ADR 0021 §4: the explorer names a transaction from its own calldata, not from the sender's account
// of what they did. That join only ever worked while the coordinator was the thing starting the
// agents; on the practice devnet the agents belong to other people and none of their logs arrive.
//
// The table is generated (sdk/src/methodSelectors.ts) so the dashboard can decode in the browser
// without shipping an ABI parser. Generated code drifts, so the first test here is the one that
// matters: recompute it from the ABIs and compare.
import test from "node:test";
import assert from "node:assert/strict";
import { buildMethodSelectors } from "@eris/sdk/methodNames.js";
import {
  METHOD_SELECTORS,
  methodNameForCalldata,
} from "@eris/sdk/methodSelectors.js";

test("the generated selector table matches the ABIs it was generated from", () => {
  // If this fails, an ABI changed and nobody re-ran the generator: a method the environment can
  // name would silently show up unnamed in the explorer.
  assert.deepEqual(
    METHOD_SELECTORS,
    buildMethodSelectors(),
    "run `npm run gen:method-selectors`",
  );
});

test("the venue entry points every run produces are named", () => {
  // Not an exhaustive list -- a spot check on the calls a participant's transactions actually
  // consist of, so a missing ABI shows up here rather than as a column of hex in the explorer.
  const names = new Set(Object.values(METHOD_SELECTORS));
  for (const name of [
    "approve",
    "transfer",
    "deposit", // WETH wrap, and the LST vault's stake
    "exactInputSingle", // uniswap
    "swap", // balancer
    "exchange", // curve
    "supply",
    "borrow",
    "repay",
    "liquidationCall", // built as a raw tx by the liquidator, not by an adapter
    "openTrove",
    "redeemCollateral",
    "provideToSP",
    "createOrder", // gmx
    "setAnswer", // the environment's own oracle writes
  ])
    assert.ok(names.has(name), `${name} has no selector in the table`);
});

test("an unknown selector resolves to nothing, never to a guess", () => {
  assert.equal(methodNameForCalldata("0xdeadbeef"), undefined);
  assert.equal(methodNameForCalldata(undefined), undefined);
  assert.equal(methodNameForCalldata(""), undefined);
  // A bare transfer of value carries no calldata at all. That is a real transaction with no method,
  // not a failure to decode one.
  assert.equal(methodNameForCalldata("0x"), undefined);
});

test("decoding reads the selector, not the arguments", () => {
  const approve = `0x095ea7b3${"0".repeat(128)}`;
  assert.equal(methodNameForCalldata(approve), "approve");
  // Case is normalised: a client that upper-cases hex still resolves.
  assert.equal(
    methodNameForCalldata(approve.toUpperCase().replace("0X", "0x")),
    "approve",
  );
});
