// Where a model-written strategy may send raw calldata (issue #214 item 3; runtime/rawTxGuard.ts).
//
// A revert reason another participant's contract wrote reaches the revision model as text. If the
// model follows it, `rawTx` is the exit. The reference runtime closes it for revised versions only:
// the strategy the participant shipped is theirs and stays unrestricted.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { TOKENS, UNISWAP } from "../sdk/src/constants.js";
import type { AgentObservation } from "../sdk/src/types.js";
import {
  bundledAddresses,
  checkRevisedRawTx,
  rawTxAllowlist,
} from "../example/agents/runtime/rawTxGuard.js";

const erc20 = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function deposit()",
]);
const STRANGER = "0x1111111111111111111111111111111111111111";
const LAUNCH_TOKEN = "0x2222222222222222222222222222222222222222";
const TRAP_MARKET = "0x3333333333333333333333333333333333333333";
const VERIFIED_POOL = "0x4444444444444444444444444444444444444444";
const PRICE_FEED = "0x5555555555555555555555555555555555555555";

const entry = (market: string, kind: string, verified: boolean) => ({
  market,
  kind,
  creator: STRANGER,
  mine: false,
  codehashAtRegistration: "0x",
  verified,
  registeredAtBlock: "1",
});
const observation = {
  registry: {
    address: "0x6666666666666666666666666666666666666666",
    entries: [
      entry(LAUNCH_TOKEN, "erc20", false),
      entry(TRAP_MARKET, "lendingMarket", false),
      entry(VERIFIED_POOL, "uniswapV3Pool", true),
    ],
    allowances: [],
    stranded: [],
  },
} as unknown as AgentObservation;
const allow = rawTxAllowlist({ observation, runContracts: [PRICE_FEED, undefined] });
const rawTx = (tx: { to?: string; data: string; value?: string }) =>
  checkRevisedRawTx({ type: "rawTx", tx }, allow);

test("the bundled address table is the base of the allowlist", () => {
  const known = bundledAddresses();
  assert.ok(known.has(TOKENS.WETH.address.toLowerCase()));
  assert.ok(known.has(UNISWAP.swapRouter.toLowerCase()));
  assert.ok(allow.known.has(PRICE_FEED));
  assert.ok(allow.known.has("0x6666666666666666666666666666666666666666"));
  assert.equal(allow.registry.get(LAUNCH_TOKEN)?.verified, false);
});

test("a call to a venue, a run token or a registry entry passes", () => {
  const deposit = encodeFunctionData({ abi: erc20, functionName: "deposit" });
  assert.deepEqual(rawTx({ to: TOKENS.WETH.address, data: deposit, value: "1" }), { ok: true });
  assert.deepEqual(rawTx({ to: UNISWAP.swapRouter, data: "0x12345678" }), { ok: true });
  // An unverified registry entry is a legitimate destination: touching one is a risk the rules
  // leave to the agent (issue #40). Sending ETH to it is not.
  assert.deepEqual(rawTx({ to: TRAP_MARKET, data: "0x12345678" }), { ok: true });
  const eth = rawTx({ to: TRAP_MARKET, data: "0x", value: "5" });
  assert.ok(!eth.ok && /may not send ETH to a registry entry/.test(eth.reason));
});

test("an address the run does not know is refused, and so is a deployment", () => {
  const stranger = rawTx({ to: STRANGER, data: "0x" });
  assert.ok(!stranger.ok && /not a venue, a token of this run or a registry entry/.test(stranger.reason));
  const deploy = rawTx({ data: "0x6080" });
  assert.ok(!deploy.ok && /may not deploy/.test(deploy.reason));
});

test("transfer and transferFrom are refused wherever they point", () => {
  const transfer = encodeFunctionData({
    abi: erc20,
    functionName: "transfer",
    args: [STRANGER, 1n],
  });
  const usdc = rawTx({ to: TOKENS.USDC.address, data: transfer });
  assert.ok(!usdc.ok && /transfer\(\) to/.test(usdc.reason));
  const transferFrom = encodeFunctionData({
    abi: erc20,
    functionName: "transferFrom",
    args: [STRANGER, STRANGER, 1n],
  });
  assert.ok(!rawTx({ to: LAUNCH_TOKEN, data: transferFrom }).ok);
});

test("approve passes for a venue or a verified entry as spender, and is refused otherwise", () => {
  const approve = (spender: string) =>
    encodeFunctionData({ abi: erc20, functionName: "approve", args: [spender as `0x${string}`, 10n] });
  // The launch-sniper shape: approve the launch token to the environment's router.
  assert.deepEqual(rawTx({ to: LAUNCH_TOKEN, data: approve(UNISWAP.swapRouter) }), { ok: true });
  assert.deepEqual(rawTx({ to: TOKENS.USDC.address, data: approve(VERIFIED_POOL) }), { ok: true });
  const trap = rawTx({ to: TOKENS.USDC.address, data: approve(TRAP_MARKET) });
  assert.ok(!trap.ok && /approve\(\) with spender/.test(trap.reason));
  const stranger = rawTx({ to: TOKENS.USDC.address, data: approve(STRANGER) });
  assert.ok(!stranger.ok);
});

test("a bundle is checked leg by leg and names the leg", () => {
  const approve = encodeFunctionData({
    abi: erc20,
    functionName: "approve",
    args: [UNISWAP.swapRouter, 10n],
  });
  const ok = checkRevisedRawTx(
    { type: "rawBundle", txs: [{ to: LAUNCH_TOKEN, data: approve }, { to: UNISWAP.swapRouter, data: "0x12345678" }] },
    allow,
  );
  assert.deepEqual(ok, { ok: true });
  const bad = checkRevisedRawTx(
    { type: "rawBundle", txs: [{ to: LAUNCH_TOKEN, data: approve }, { to: STRANGER, data: "0x" }] },
    allow,
  );
  assert.ok(!bad.ok && /^rawBundle\[1\]/.test(bad.reason));
});

test("registered actions are not the guard's business", () => {
  assert.deepEqual(
    checkRevisedRawTx({ type: "swap", tokenIn: "USDC", amountIn: "1" } as never, allow),
    { ok: true },
  );
});
