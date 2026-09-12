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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { MULTICALL3 } from "@eris/sdk/constants.js";
import { applyManifestEnv } from "../example/agents/runtime/manifestEnv.js";
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

// A self-hosted participant (ADR 0021) is pointed at the chain by the manifest and has never heard
// of ANVIL_RPC_URL or gen:local-constants. Both failures used to answer them in the operator's
// vocabulary, which is a dead end for the one reader who cannot act on it (issue #84 X3).
test("a chain-id mismatch is explained to whoever pointed the agent", async () => {
  const { client } = fakeClient({ chainId: 42161 });
  const operator = await run(client);
  assert.match(operator!.message, /ANVIL_RPC_URL/);

  // The walk-through's own failure: the manifest says 31337, the node is 31337, and something in
  // the shell or the config file has the agent signing for 42161.
  const { client: local } = fakeClient({ chainId: 31337 });
  const overridden = await run(local, {
    expectedChainId: 42161,
    via: "manifest",
    manifestChainId: 31337,
  });
  assert.equal(overridden?.kind, "chain-id");
  assert.match(overridden!.message, /manifest says chainId 31337/);
  assert.match(overridden!.message, /overrides it with 42161/);
  assert.ok(
    !overridden!.message.includes("ANVIL_RPC_URL"),
    "no operator settings in a participant's error",
  );

  // The manifest agrees with the config and the node does not: the file names another chain.
  const disagreeing = await run(client, {
    via: "manifest",
    manifestChainId: LOCAL_CHAIN_ID,
  });
  assert.match(disagreeing!.message, /Use the manifest the operator issued/);
});

test("a missing deployment is explained to whoever pointed the agent", async () => {
  const { client } = fakeClient({ code: () => "0x" });
  const operator = await run(client);
  assert.match(operator!.message, /gen:local-constants/);
  assert.match(operator!.message, /run\.localDeploy/);

  const participant = await run(client, { via: "manifest" });
  assert.equal(participant?.kind, "deployment");
  assert.match(participant!.message, /hold no code/);
  assert.match(participant!.message, /manifest/);
  assert.ok(
    !participant!.message.includes("ANVIL_RPC_URL"),
    "the participant sets no such variable",
  );
});

test("the manifest supplies the chain id and the address overlay, and env still wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-manifest-"));
  const path = join(dir, "manifest.json");
  writeFileSync(
    path,
    JSON.stringify({ chain: { chainId: 31337, localDeploy: true } }),
  );
  try {
    // The guide's command: ERIS_MANIFEST alone. Both settings come from the file, which is what
    // makes the difference between an agent that trades and one that fails preflight twice.
    const fresh: NodeJS.ProcessEnv = {};
    applyManifestEnv(path, fresh);
    assert.equal(fresh.CHAIN_ID, "31337");
    assert.equal(fresh.ERIS_LOCAL_DEPLOY, "1");

    // A coordinator-spawned run is unchanged: what the environment set stays set.
    const spawned: NodeJS.ProcessEnv = {
      CHAIN_ID: "42161",
      ERIS_LOCAL_DEPLOY: "0",
    };
    applyManifestEnv(path, spawned);
    assert.equal(spawned.CHAIN_ID, "42161");
    assert.equal(spawned.ERIS_LOCAL_DEPLOY, "0");

    // A fork manifest turns the overlay off rather than leaving it to whatever was inherited.
    writeFileSync(
      path,
      JSON.stringify({ chain: { chainId: 42161, localDeploy: false } }),
    );
    const fork: NodeJS.ProcessEnv = {};
    applyManifestEnv(path, fork);
    assert.equal(fork.ERIS_LOCAL_DEPLOY, "0");

    // A file that is not there, or not JSON, is left to the runtime to refuse with its own message.
    const untouched: NodeJS.ProcessEnv = {};
    applyManifestEnv(join(dir, "absent.json"), untouched);
    writeFileSync(join(dir, "torn.json"), "{ not json");
    applyManifestEnv(join(dir, "torn.json"), untouched);
    applyManifestEnv(undefined, untouched);
    assert.deepEqual(untouched, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
