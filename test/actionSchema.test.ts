import test from "node:test";
import assert from "node:assert/strict";
import {
  actionJsonSchema,
  agentActionSchema,
  agentActionSchemaFor,
} from "../sdk/src/actionSchema.js";

test("agentActionSchema: accepts a valid swap", () => {
  const r = agentActionSchema.safeParse({
    type: "swap",
    tokenIn: "USDC",
    amountIn: "1000000",
    slippageBps: 50,
    maxPriorityFeePerGasWei: "100000000",
  });
  assert.equal(r.success, true);
});

test("agentActionSchema: accepts noop / rawTx / bundle", () => {
  assert.equal(
    agentActionSchema.safeParse({ type: "noop", reason: "x" }).success,
    true,
  );
  assert.equal(
    agentActionSchema.safeParse({
      type: "rawTx",
      tx: { to: "0xabc0", data: "0x" },
    }).success,
    true,
  );
  assert.equal(
    agentActionSchema.safeParse({
      type: "bundle",
      actions: [
        { type: "swap", tokenIn: "WETH", amountIn: "1" },
        { type: "balancerSwap", tokenIn: "USDC", amountIn: "2" },
      ],
    }).success,
    true,
  );
});

test("agentActionSchema: rejects a fractional amountIn (decimal string contract)", () => {
  const r = agentActionSchema.safeParse({
    type: "swap",
    tokenIn: "USDC",
    amountIn: "1.5",
  });
  assert.equal(r.success, false);
});

test("agentActionSchemaFor: actions for a disabled venue are dropped", () => {
  const uniOnly = agentActionSchemaFor(["uniswap"]);
  assert.equal(
    uniOnly.safeParse({ type: "swap", tokenIn: "USDC", amountIn: "1" }).success,
    true,
  );
  assert.equal(
    uniOnly.safeParse({ type: "balancerSwap", tokenIn: "USDC", amountIn: "1" })
      .success,
    false,
  );
  assert.equal(uniOnly.safeParse({ type: "gmxIncrease" }).success, false);
});

test("aaveWithdraw/aaveRepay accept 'max'", () => {
  assert.equal(
    agentActionSchema.safeParse({
      type: "aaveWithdraw",
      asset: "USDC",
      amount: "max",
    }).success,
    true,
  );
  assert.equal(
    agentActionSchema.safeParse({
      type: "aaveBorrow",
      asset: "USDC",
      amount: "max",
    }).success,
    false,
    "borrow cannot use max",
  );
});

test("actionJsonSchema: generates the JSON Schema for <schema>", () => {
  const schema = actionJsonSchema(["uniswap", "aave"]);
  const text = JSON.stringify(schema);
  assert.equal(typeof schema, "object");
  assert.match(text, /noop/);
  assert.match(text, /aaveSupply/);
  assert.doesNotMatch(text, /balancerSwap/);
});
