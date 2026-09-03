// An agent that cannot use the chain has to say so by exiting, because the alternative is silence
// that scores. `includedTxCount: 0` / `netPnlUsdc: 0` / `violations: []` is what a broken agent and
// a deliberately idle agent both leave in summary.json, so the only place the two can still be told
// apart is here, before the loop starts.
//
// The client is faked rather than pointed at anvil: the three questions are about what the runtime
// does with the answers, and a real node can only be made to give one of the three wrong answers
// without a lot of setup.
import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { MULTICALL3 } from "@eris/sdk/constants.js";
import { preflightChain } from "../example/agents/runtime/preflight.js";

const LOCAL_CHAIN_ID = 31337;

// getChainId / getCode are the only two methods preflight uses.
function fakeClient(opts: {
  chainId?: number | (() => number);
  code?: (address: string) => string;
  failFirst?: number;
}): { client: PublicClient; chainIdCalls: () => number } {
  let calls = 0;
  const client = {
    async getChainId(): Promise<number> {
      calls++;
      if (opts.failFirst !== undefined && calls <= opts.failFirst)
        throw new Error("HTTP request failed.\n  URL: http://127.0.0.1:8545");
      if (typeof opts.chainId === "function") return opts.chainId();
      return opts.chainId ?? LOCAL_CHAIN_ID;
    },
    async getCode({ address }: { address: string }): Promise<string> {
      return opts.code ? opts.code(address) : "0x60006000";
    },
  } as unknown as PublicClient;
  return { client, chainIdCalls: () => calls };
}

const run = (client: PublicClient, extra: Record<string, unknown> = {}) =>
  preflightChain({
    publicClient: client,
    rpcUrl: "http://127.0.0.1:8545",
    expectedChainId: LOCAL_CHAIN_ID,
    enabledIds: ["uniswap"],
    delayMs: 0,
    sleep: async () => {},
    ...extra,
  });

test("a usable chain passes and the agent goes on to trade", async () => {
  const { client } = fakeClient({});
  assert.equal(await run(client), null);
});

test("an unreachable RPC is a failure, not a quiet start", async () => {
  // The case measured in a container: the process is fine, the chain is not there, and every read
  // and send fails for the whole run without a single line saying so.
  const { client } = fakeClient({ failFirst: 99 });
  const failure = await run(client, { attempts: 3 });
  assert.equal(failure?.kind, "unreachable");
  assert.match(
    failure!.message,
    /cannot reach the chain at http:\/\/127\.0\.0\.1:8545/,
  );
  // The container case is the one a participant will hit and the one hardest to guess at.
  assert.match(failure!.message, /127\.0\.0\.1 is the container, not the host/);
});

test("a node that comes up late is waited for rather than failed", async () => {
  // A self-hosted agent (ADR 0021) is started by hand or by a supervisor, so it can beat its node to
  // the socket by a moment. Failing that start would turn a race into a restart loop.
  const { client, chainIdCalls } = fakeClient({ failFirst: 2 });
  assert.equal(await run(client, { attempts: 5 }), null);
  assert.equal(chainIdCalls(), 3);
});

test("a chain id the agent does not sign for is refused", async () => {
  // Reads would keep working and every send would be rejected: alive, and placing nothing.
  const { client } = fakeClient({ chainId: 42161 });
  const failure = await run(client);
  assert.equal(failure?.kind, "chain-id");
  assert.match(failure!.message, /reports 42161/);
  assert.match(failure!.message, /configured for 31337/);
});

test("addresses that hold no code are refused, naming what is missing", async () => {
  // The shape of pointing a local run at the wrong deployment: the chain answers, and every
  // contract the run names is empty.
  const { client } = fakeClient({ code: () => "0x" });
  const failure = await run(client);
  assert.equal(failure?.kind, "deployment");
  assert.match(failure!.message, /hold no code/);
});

test("one missing contract is enough — a partial deployment is not a usable chain", async () => {
  const { client } = fakeClient({
    code: (a) =>
      a.toLowerCase() === MULTICALL3.toLowerCase() ? "0x" : "0x6000",
  });
  const failure = await run(client);
  assert.equal(failure?.kind, "deployment");
  assert.match(failure!.message, /Multicall3/);
});
