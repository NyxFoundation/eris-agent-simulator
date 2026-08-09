// Read failures must be reported, not decoded to zero (issue #44).
//
// #41 fixed one door into a silent zero (a holding nothing could price); this covers the other one
// (a read that failed, so the holding is unknown). A zero that reaches summary.json either way is
// indistinguishable from the agent having traded the value away.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { readValueSnapshotAtBlock } from "../core/src/realtime/reconstruct.js";
import { toPriceFeedAnswer } from "@eris/sdk/priceFeed.js";
import { TOKENS, USDC_VARIANTS } from "@eris/sdk/constants.js";
import { aaveAdapter } from "@eris/sdk/protocols/aave.js";
import type { ValuationContext } from "@eris/sdk/protocols/types.js";

const PRICE_FEED = "0x00000000000000000000000000000000feed0001" as Address;
const AGENT = {
  id: "a1",
  address: "0x00000000000000000000000000000000000a0001" as Address,
};
const USDC = USDC_VARIANTS.native;
const FAIR = 2000;

type Call = { address: Address; functionName: string };
// A read that failed comes back as a failure entry, exactly as viem's allowFailure multicall does.
type Reply = bigint | "fail";

// Fake client that answers each read by functionName, so a test can make exactly one read fail.
function clientReturning(reply: (call: Call) => Reply) {
  const calls: Call[][] = [];
  return {
    calls,
    client: {
      multicall: async ({ contracts }: { contracts: Call[] }) => {
        calls.push(contracts);
        return contracts.map((c) => {
          const value = reply(c);
          return value === "fail"
            ? { status: "failure" as const }
            : { status: "success" as const, result: value };
        });
      },
    } as never,
  };
}

// Healthy answers: $2000 fair, 1 ETH, 2 WETH, 500 USDC.
const ETH_WEI = 10n ** 18n;
const WETH_WEI = 2n * 10n ** 18n;
const USDC_UNITS = 500_000_000n;
function healthy(call: Call): Reply {
  if (call.functionName === "latestAnswer") return toPriceFeedAnswer(FAIR);
  if (call.functionName === "getEthBalance") return ETH_WEI;
  if (call.address.toLowerCase() === TOKENS.WETH.address.toLowerCase())
    return WETH_WEI;
  return USDC_UNITS;
}

function snapshot(reply: (call: Call) => Reply) {
  const { client } = clientReturning(reply);
  return readValueSnapshotAtBlock({
    publicClient: client,
    agents: [AGENT],
    enabledIds: [],
    activeStables: [USDC],
    priceFeed: PRICE_FEED,
    blockNumber: 100,
  });
}

test("a healthy cross-section reports nothing excluded", async () => {
  const s = await snapshot(healthy);
  assert.equal(s.failedReads, 0);
  assert.deepEqual(s.unpriced, []);
  // 1 ETH + 2 WETH at $2000, plus 500 USDC.
  assert.ok(Math.abs(s.values[0].valueUsdc - (3 * FAIR + 500)) < 1e-6);
});

test("an unreadable token balance names the holding it hid", async () => {
  const s = await snapshot((c) =>
    c.functionName === "balanceOf" &&
    c.address.toLowerCase() === TOKENS.WETH.address.toLowerCase()
      ? "fail"
      : healthy(c),
  );
  assert.equal(s.failedReads, 1);
  assert.deepEqual(s.unpriced, [
    {
      agentId: "a1",
      source: "spot-WETH",
      token: TOKENS.WETH.address,
      amountRaw: "",
      reason: "read-failed",
      read: "ERC20.balanceOf",
    },
  ]);
  // The value still has to be a number, and the WETH is simply missing from it — which is exactly
  // why the exclusion above has to be reported.
  assert.ok(Math.abs(s.values[0].valueUsdc - (FAIR + 500)) < 1e-6);
});

test("an unreadable ETH balance is reported without a token", async () => {
  const s = await snapshot((c) =>
    c.functionName === "getEthBalance" ? "fail" : healthy(c),
  );
  assert.deepEqual(s.unpriced, [
    {
      agentId: "a1",
      source: "spot-eth",
      amountRaw: "",
      reason: "read-failed",
      read: "Multicall3.getEthBalance",
    },
  ]);
});

test("failed reads are attributed to a contract and function", async () => {
  const s = await snapshot((c) =>
    c.functionName === "balanceOf" ? "fail" : healthy(c),
  );
  // Both the WETH and the USDC balance failed, and they are separate targets.
  assert.equal(s.failedReads, 2);
  assert.deepEqual(
    s.failedReadTargets.map((t) => `${t.address}|${t.functionName}|${t.count}`),
    [`${TOKENS.WETH.address}|balanceOf|1`, `${USDC}|balanceOf|1`],
  );
});

test("an unreadable fair price fails the block instead of zeroing every holding", async () => {
  await assert.rejects(
    snapshot((c) => (c.functionName === "latestAnswer" ? "fail" : healthy(c))),
    /fair price unusable at block 100.*read failed/s,
  );
});

test("a zero fair price fails the block too", async () => {
  await assert.rejects(
    snapshot((c) => (c.functionName === "latestAnswer" ? 0n : healthy(c))),
    /fair price unusable at block 100.*returned 0/s,
  );
});

// ---------------------------------------------------------------------------
// Adapters report their own failed reads through the same channel.
// ---------------------------------------------------------------------------

function valuationCtx(): ValuationContext {
  return {
    publicClient: {} as never,
    blockNumber: 100,
    horizonBlock: 100,
    agents: [AGENT],
    activeStables: [USDC],
    fairByBase: () => ({ WETH: FAIR }),
  };
}

test("aave reports an unreadable account instead of scoring it as closed", async () => {
  const run = aaveAdapter.valueAtBlock?.(valuationCtx());
  assert.ok(run);
  const reads = await run.next();
  assert.equal((reads.value as unknown[]).length, 1);
  // The one read failed.
  const done = await run.next([undefined]);
  assert.ok(done.done);
  const value = done.value[AGENT.id];
  assert.equal(value.valueUsdc, 0);
  assert.deepEqual(value.unpriced, [
    {
      source: "aave-account",
      amountRaw: "",
      reason: "read-failed",
      read: "AavePool.getUserAccountData",
    },
  ]);
});

test("aave stays silent when the account simply holds nothing", async () => {
  const run = aaveAdapter.valueAtBlock?.(valuationCtx());
  assert.ok(run);
  await run.next();
  const done = await run.next([[0n, 0n, 0n, 0n, 0n, 0n]]);
  assert.ok(done.done);
  assert.deepEqual(done.value[AGENT.id].unpriced, []);
});
