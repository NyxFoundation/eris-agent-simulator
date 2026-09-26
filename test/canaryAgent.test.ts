// The practice devnet's canary (example/agents/canary): one beat per window, alternating direction,
// and never a trade it cannot pay for. infra/devnet/CHECKLIST.md reads "at least one row an hour" off
// its blocks.csv rows, so a canary that beat every block or stopped beating would break the check.
import test from "node:test";
import assert from "node:assert/strict";
import { canaryAction } from "../example/agents/canary/agent.js";
import type { AgentObservation } from "../sdk/src/types.js";

function obs(
  block: number,
  usdcUnits = "25000000000",
  wethWei = "8000000000000000000",
) {
  return {
    blockNumber: String(block),
    fairPriceUsdcPerWeth: 3000,
    balances: { usdcUnits, wethWei },
    limits: { defaultPriorityFeePerGasWei: "1000000000" },
  } as unknown as AgentObservation;
}

test("canary beats once per window", () => {
  const first = canaryAction(obs(300), -1, 150);
  assert.equal(first.window, 2);
  assert.equal(first.action.type, "swap");
  const again = canaryAction(obs(449), first.window, 150);
  assert.equal(again.action.type, "noop");
});

test("canary alternates: even windows buy WETH with 1 USDC, odd windows sell about $1 of WETH", () => {
  const buy = canaryAction(obs(300), -1, 150).action as Record<string, unknown>;
  assert.equal(buy.tokenIn, "USDC");
  assert.equal(buy.amountIn, "1000000");
  const sell = canaryAction(obs(450), 2, 150).action as Record<string, unknown>;
  assert.equal(sell.tokenIn, "WETH");
  assert.equal(sell.amountIn, String(Math.floor(1e18 / 3000)));
});

test("canary does not send what it cannot pay for", () => {
  const broke = canaryAction(obs(300, "999999"), -1, 150);
  assert.equal(broke.action.type, "noop");
  assert.equal(broke.window, 2);
});
