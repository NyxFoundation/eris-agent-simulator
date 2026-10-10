import test from "node:test";
import assert from "node:assert/strict";
import { capCallGas } from "../infra/rpc-gateway/txGas.mjs";

// The gateway's read gas cap (txGas.mjs capCallGas), without a gateway: what it writes into
// eth_call / eth_estimateGas / eth_createAccessList, and what it leaves alone.

const CAP = 10_000_000n;
const CAP_HEX = "0x989680";
const TO = "0x000000000000000000000000000000000000dead";
const call = (method: string, tx: unknown, ...rest: unknown[]) => ({ jsonrpc: "2.0", id: 1, method, params: [tx, ...rest] });

test("a read with no gas, or more than the cap, runs at the cap", () => {
  for (const method of ["eth_call", "eth_estimateGas", "eth_createAccessList"]) {
    const absent = call(method, { to: TO, data: "0x" }, "latest");
    const over = call(method, { to: TO, gas: "0x1312d00" /* 20M */ }, "latest");
    const huge = call(method, { to: TO, gas: "0xffffffffffffffffffff" });
    assert.equal(capCallGas([absent, over, huge], CAP), 3, method);
    for (const c of [absent, over, huge]) assert.equal((c.params[0] as { gas: string }).gas, CAP_HEX, method);
    // Nothing else in the call changes.
    assert.deepEqual(absent.params, [{ to: TO, data: "0x", gas: CAP_HEX }, "latest"]);
  }
});

test("a read at or under the cap passes untouched", () => {
  const under = call("eth_call", { to: TO, gas: "0x5208" }, "latest");
  const at = call("eth_estimateGas", { to: TO, gas: CAP_HEX });
  const numeric = call("eth_call", { to: TO, gas: 21000 });
  const before = JSON.stringify([under, at, numeric]);
  assert.equal(capCallGas([under, at, numeric], CAP), 0);
  assert.equal(JSON.stringify([under, at, numeric]), before);
});

test("an unreadable gas is replaced, and gasLimit is dropped rather than trusted", () => {
  const junk = call("eth_call", { to: TO, gas: "lots" });
  const negative = call("eth_call", { to: TO, gas: -1 });
  const fraction = call("eth_call", { to: TO, gas: 1.5 });
  const obj = call("eth_call", { to: TO, gas: { hex: "0x1" } });
  assert.equal(capCallGas([junk, negative, fraction, obj], CAP), 4);
  for (const c of [junk, negative, fraction, obj]) assert.equal((c.params[0] as { gas: unknown }).gas, CAP_HEX);

  // A node that reads gasLimit as an alias of gas would run the call on it.
  const alias = call("eth_call", { to: TO, gasLimit: "0x1312d00" });
  const both = call("eth_call", { to: TO, gas: "0x5208", gasLimit: "0x1312d00" });
  assert.equal(capCallGas([alias, both], CAP), 2);
  assert.deepEqual(alias.params[0], { to: TO, gas: CAP_HEX });
  assert.deepEqual(both.params[0], { to: TO, gas: "0x5208" });
});

test("a batch is capped member by member; other methods and malformed calls are left alone", () => {
  const batch = [
    call("eth_call", { to: TO }),
    { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
    call("eth_getBalance", TO, "latest"),
    call("eth_sendRawTransaction", "0x02"),
    call("eth_call", { to: TO, gas: "0x1" }),
    { jsonrpc: "2.0", id: 3, method: "eth_call" },
    call("eth_call", null),
    call("eth_call", [TO]),
    null,
    call("eth_estimateGas", { to: TO, gas: "0x1312d00" }),
  ];
  const before = JSON.parse(JSON.stringify(batch));
  assert.equal(capCallGas(batch, CAP), 2);
  before[0].params[0].gas = CAP_HEX;
  before[9].params[0].gas = CAP_HEX;
  assert.deepEqual(batch, before);
});

test("cap 0 disables", () => {
  const c = call("eth_call", { to: TO });
  assert.equal(capCallGas([c], 0n), 0);
  assert.deepEqual(c.params[0], { to: TO });
});
