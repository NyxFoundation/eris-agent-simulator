// Issue #33 / ADR 0021 §7: on an external chain the cheatcodes are gone, and the failure mode this
// guards against is silence. An unknown RPC method returns an error object, and most of the ~30 call
// sites that reach for one either swallow it or log and continue -- so a run would fund nobody, mine
// nothing, and still write a summary.json describing a completed competition. Every test here is
// about the refusal being *loud*.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chainMode,
  sendBatch,
  dealErc20,
  increaseTime,
  isExternalChain,
  mine,
  resetFork,
  setAutomine,
  setChainMode,
  setEthBalance,
  setIntervalMining,
  setStorageAt,
} from "@eris/sdk/chain.js";
import { loadConfig } from "@eris/sdk/config.js";

// None of these reach the network: the guard throws before the request is built, which is the point.
// biome-ignore lint/suspicious/noExplicitAny: a stub client that is never called
const client = {} as any;
const ADDRESS = "0x0000000000000000000000000000000000000001";

test.afterEach(() => setChainMode("anvil"));

test("chain mode defaults to anvil, which keeps every cheatcode available", () => {
  setChainMode("anvil");
  assert.equal(chainMode(), "anvil");
  assert.equal(isExternalChain(), false);
});

test("external mode refuses every cheatcode, naming the replacement", async () => {
  setChainMode("external", `0x${"11".repeat(32)}`);
  assert.equal(isExternalChain(), true);
  const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
    ["setEthBalance", () => setEthBalance(client, ADDRESS, 1n), /treasury/],
    ["dealErc20", () => dealErc20(client, ADDRESS, ADDRESS, 1n), /treasury/],
    ["mine", () => mine(client), /sequencer/],
    ["setIntervalMining", () => setIntervalMining(client, 2), /sequencer/],
    ["setAutomine", () => setAutomine(client, false), /setIntervalMining/],
    ["increaseTime", () => increaseTime(client, 60), /wall time/],
    ["resetFork", () => resetFork(client, {}), /cannot be rewound/],
    [
      "setStorageAt",
      () => setStorageAt(client, ADDRESS, `0x${"0".repeat(64)}`, `0x00`),
      /economicGas/,
    ],
  ];
  for (const [name, call, replacement] of cases) {
    await assert.rejects(
      call,
      (err: Error) => {
        assert.match(err.message, /external chain/, `${name}: says which mode`);
        assert.match(
          err.message,
          replacement,
          `${name}: names what replaces it`,
        );
        assert.match(err.message, /#33/, `${name}: cites the work item`);
        return true;
      },
      `${name} must refuse on an external chain`,
    );
  }
});

test("a run without a treasury key cannot grant anything on an external chain", async () => {
  setChainMode("external"); // registered, but no funding account
  const { grantErc20 } = await import("@eris/sdk/chain.js");
  await assert.rejects(
    () => grantErc20(client, client, client, ADDRESS, ADDRESS, 1n),
    /TREASURY_PRIVATE_KEY/,
  );
});

test("run.chainMode parses to the two modes and rejects anything else", () => {
  assert.equal(loadConfig({}).chainMode, "anvil");
  assert.equal(loadConfig({ ERIS_CHAIN_MODE: "" }).chainMode, "anvil");
  assert.equal(
    loadConfig({ ERIS_CHAIN_MODE: "external" }).chainMode,
    "external",
  );
  // A typo silently falling back to "anvil" would put a run on a real chain reaching for cheatcodes,
  // which is the exact failure this axis exists to make impossible.
  assert.throws(
    () => loadConfig({ ERIS_CHAIN_MODE: "extenal" }),
    /must be "anvil" or "external"/,
  );
});

test("reads can be pointed at a replica without moving writes (issue #36)", () => {
  const same = loadConfig({ ANVIL_RPC_URL: "http://seq:8545" });
  assert.equal(same.readRpcUrl, same.rpcUrl, "defaults to the write endpoint");
  const split = loadConfig({
    ANVIL_RPC_URL: "http://seq:8545",
    ERIS_READ_RPC_URL: "http://replica:8545",
  });
  assert.equal(split.rpcUrl, "http://seq:8545");
  assert.equal(split.readRpcUrl, "http://replica:8545");
});

test("a batch assigns sequential nonces and waits only for the last", async () => {
  // Funding on a chain the environment does not mine costs one block per transaction, and there
  // were eighteen per wallet: the first external run sat in the funding loop for six minutes with
  // four events written. Batching is what fixes that, and it is only correct because the
  // transactions share a sender and take consecutive nonces — the last cannot be included before the
  // earlier ones, so one wait is a wait for all of them.
  //
  // Nonces are assigned here rather than by viem, which re-reads the pending count per send; two
  // overlapping sends would take the same one and the second would silently replace the first.
  setChainMode("external", `0x${"11".repeat(32)}`);
  const sent: Array<{ nonce?: number; to: string }> = [];
  let waitedFor: string | undefined;
  const fake = {
    getBlock: async () => ({ baseFeePerGas: 0n }),
    getTransactionCount: async () => 7,
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
      waitedFor = hash;
      return {};
    },
    // biome-ignore lint/suspicious/noExplicitAny: a stub client
  } as any;
  // biome-ignore lint/suspicious/noExplicitAny: a stub client
  const wallet = {
    sendTransaction: async (tx: { nonce?: number; to: string }) => {
      sent.push({ nonce: tx.nonce, to: tx.to });
      return `0x${String(tx.nonce).padStart(64, "0")}`;
    },
    // biome-ignore lint/suspicious/noExplicitAny: a stub client
  } as any;

  const targets = [ADDRESS, ADDRESS, ADDRESS] as const;
  const hashes = await sendBatch(
    fake,
    wallet,
    // biome-ignore lint/suspicious/noExplicitAny: a stub chain
    {} as any,
    `0x${"22".repeat(32)}`,
    targets.map((to) => ({ to })),
  );
  assert.deepEqual(
    sent.map((t) => t.nonce),
    [7, 8, 9],
    "consecutive, starting from the pending count",
  );
  assert.equal(hashes.length, 3);
  assert.equal(waitedFor, hashes[2], "waits for the last, which implies the rest");
});

test("an empty batch sends nothing and waits for nothing", async () => {
  setChainMode("external", `0x${"11".repeat(32)}`);
  // biome-ignore lint/suspicious/noExplicitAny: the stub must never be called
  const explode = new Proxy({} as any, {
    get() {
      throw new Error("a batch of no transactions must not touch the chain");
    },
  });
  assert.deepEqual(
    await sendBatch(explode, explode, explode, `0x${"22".repeat(32)}`, []),
    [],
  );
});
