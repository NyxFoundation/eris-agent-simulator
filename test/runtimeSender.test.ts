import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rng } from "@eris/sdk/rng.js";
import { loadConfig } from "@eris/sdk/config.js";
import { makeClients } from "@eris/sdk/chain.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { AgentObservation, BalanceSnapshot } from "@eris/sdk/types.js";
import { Sender } from "../example/agents/runtime/send.js";
import { StrategyRunner } from "../example/agents/runtime/strategyRunner.js";
import { PyBridge } from "../example/agents/runtime/pyBridge.js";
import { rpc, startAnvil, startGateway } from "./helpers/localRpc.js";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail("sender did not finish");
}

for (const language of ["typescript", "python"] as const) test(
  `${language}: ctx.submit and returned actions share pending nonces and one submitted record per transaction`,
  { timeout: 20_000 },
  async (t) => {
    const upstream = await startAnvil(t);
    const rpcUrl = await startGateway(t, upstream);
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    await rpc(upstream, "anvil_setBalance", [
      account.address,
      "0x3635c9adc5dea00000",
    ]);
    const config = { ...loadConfig(), chainId: 31337 };
    const clients = makeClients(rpcUrl, config.chainId);
    // A transaction already pending when Sender starts must be respected by nonce seeding.
    await clients.walletClient.sendTransaction({
      account,
      chain: clients.chain,
      to: account.address,
      value: 0n,
      gas: 21_000n,
      nonce: 0,
      // maxFeePerGas = tip: this goes through the gateway, which refuses maxFeePerGas above the tip.
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
    const events: Record<string, unknown>[] = [];
    const simContext: SimContext = {
      ...clients,
      config,
      rng: new Rng(config.seed),
      adminPk: privateKey,
      keeperPk: privateKey,
      oracle: { aaveAggregators: {} },
      gmx: { market: account.address },
      pendingGmxOrders: [],
      flowWallet() {
        throw new Error("flow wallets are not used by the sender test");
      },
      flowWalletByKey() {
        throw new Error("flow wallets are not used by the sender test");
      },
    };
    const sender = new Sender({
      ctx: simContext,
      adapters: [],
      privateKey,
      logMempool: (event) => events.push(event),
    });
    const observation = {
      round: 1,
      runId: "test",
      limits: {
        defaultPriorityFeePerGasWei: "1",
        maxPriorityFeePerGasWei: "1000",
      },
    } as AgentObservation;
    const balances = {} as BalanceSnapshot;
    const dir = mkdtempSync(join(tmpdir(), "eris-sender-"));
    const path = join(dir, language === "python" ? "strategy.py" : "agent.ts");
    writeFileSync(
      path,
      language === "python" ? `import json, sys
for line in sys.stdin:
    r = json.loads(line)
    action = {"type": "rawTx", "tx": {"to": r["address"], "data": "0x"}}
    print(json.dumps({"id": r["id"], "submit": action}), flush=True)
    print(json.dumps({"id": r["id"], "action": action}), flush=True)
` : `export async function decide(obs, ctx) {
    if ('walletClient' in ctx) throw new Error('second sender exposed');
    if (await ctx.publicClient.getChainId() !== 31337) throw new Error('read RPC failed');
    for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign']) {
      let blocked = false;
      try { await ctx.publicClient.request({ method, params: [] }); }
      catch (error) { blocked = error.message.includes('read-only'); }
      if (!blocked) throw new Error('write RPC bypass: ' + method);
    }
    ctx.submit({ type: 'rawTx', tx: { to: ctx.address, data: '0x' } });
    return { type: 'rawTx', tx: { to: ctx.address, data: '0x' } };
  }`,
    );
    const Runner = language === "python" ? PyBridge : StrategyRunner;
    const runner = new Runner(
      { kind: language === "python" ? "python" : "module", path },
      {
        agentId: "test",
        address: account.address,
        config,
        rpcUrl,
      },
      () => {},
    );
    t.after(async () => {
      await runner.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const result = await runner.decide(observation);
    for (const action of [...result.submitted, result.action]) {
      if (action) sender.submit(action, observation, balances, new Map());
    }
    await until(() => events.length >= 2);
    assert.deepEqual(
      events.map((e) => e.event),
      ["submitted", "submitted"],
    );
    assert.deepEqual(
      events.map((e) => e.nonce),
      [1, 2],
    );
    assert.equal(new Set(events.map((e) => e.hash)).size, 2);
    assert.ok(events.every((e) => e.blockSeen === 1));
    assert.equal(
      await clients.publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
      3,
    );
    await rpc(upstream, "evm_mine");
    const block = await clients.publicClient.getBlock({
      includeTransactions: true,
    });
    assert.equal(block.transactions.length, 3);
    for (const event of events)
      assert.ok(block.transactions.some((tx) => tx.hash === event.hash));
  },
);

test("local gas rejection and an RPC failure do not consume the next successful transaction's nonce", async () => {
  const events: Record<string, unknown>[] = [];
  const nonces: number[] = [];
  let gas = 40_000_000n;
  let failSend = false;
  const config = loadConfig();
  const ctx = {
    config,
    publicClient: {
      getBlock: async () => ({ baseFeePerGas: 1n }),
      getTransactionCount: async () => 7,
      estimateGas: async () => gas,
    },
    walletClient: {
      sendTransaction: async ({ nonce }: { nonce: number }) => {
        if (failSend) throw new Error("connection reset");
        nonces.push(nonce);
        return `0x${"1".repeat(64)}`;
      },
    },
  } as unknown as SimContext;
  const sender = new Sender({
    ctx,
    adapters: [],
    privateKey: generatePrivateKey(),
    logMempool: (e) => events.push(e),
  });
  const observation = {
    round: 1,
    limits: { defaultPriorityFeePerGasWei: "1", maxPriorityFeePerGasWei: "2" },
  } as AgentObservation;
  const submit = () =>
    sender.submit(
      { type: "rawTx", tx: { to: sender.address, data: "0x" } },
      observation,
      {} as BalanceSnapshot,
      new Map(),
    );
  submit();
  await until(() => events.length === 1);
  assert.equal(events[0].event, "rejected");
  gas = 21_000n;
  failSend = true;
  submit();
  await until(() => events.length === 2);
  assert.equal(events[1].event, "submit_failed");
  failSend = false;
  submit();
  await until(() => events.length === 3);
  assert.equal(events[2].event, "submitted");
  assert.deepEqual(nonces, [7]);
});

// The fee rule (sdk/src/feeRule.ts): the node orders on maxFeePerGas and the tx pays
// min(maxFeePerGas, baseFee + tip), so the runtime must never sign maxFeePerGas above the tip. It
// used to sign baseFee * 2 + tip -- equal to the tip at base fee 0, a free position boost anywhere else.
test("the runtime signs maxFeePerGas equal to the tip, and no action field can raise it", async () => {
  const signed: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }[] = [];
  let baseFee = 0n;
  const config = { ...loadConfig(), economicGas: false, maxPriorityFeeWei: 5_000_000_000n };
  const ctx = {
    config,
    publicClient: {
      getBlock: async () => ({ baseFeePerGas: baseFee }),
      getTransactionCount: async () => 0,
      estimateGas: async () => 21_000n,
    },
    walletClient: {
      sendTransaction: async (tx: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) => {
        signed.push({ maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
        return `0x${String(signed.length).padStart(64, "0")}`;
      },
    },
  } as unknown as SimContext;
  const events: Record<string, unknown>[] = [];
  const sender = new Sender({
    ctx,
    adapters: [],
    privateKey: generatePrivateKey(),
    logMempool: (e) => events.push(e),
  });
  const observation = {
    round: 1,
    limits: {
      defaultPriorityFeePerGasWei: "100000000",
      maxPriorityFeePerGasWei: "5000000000",
    },
  } as AgentObservation;
  const submit = (raw: Record<string, unknown>) =>
    sender.submit(raw as never, observation, {} as BalanceSnapshot, new Map());

  // Base fee 0 (the competition chain): both fields are the bid, and a maxFeePerGas smuggled into
  // the action or its tx object is not an action field -- it never reaches the signer.
  submit({
    type: "rawTx",
    tx: { to: sender.address, data: "0x", maxFeePerGas: "7000000000" },
    maxPriorityFeePerGasWei: "1000000000",
    maxFeePerGasWei: "7000000000",
  });
  await until(() => events.length === 1);
  assert.deepEqual(signed[0], {
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });

  // Base fee 1 gwei: both fields baseFee + bid, so the priority paid is still the bid.
  baseFee = 1_000_000_000n;
  submit({ type: "rawTx", tx: { to: sender.address, data: "0x" }, maxPriorityFeePerGasWei: "2000000000" });
  await until(() => events.length === 2);
  assert.deepEqual(signed[1], {
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 3_000_000_000n,
  });

  // A bid at the cap on a chain with a base fee: clamped to the cap rather than signed above it.
  submit({ type: "rawTx", tx: { to: sender.address, data: "0x" }, maxPriorityFeePerGasWei: "5000000000" });
  await until(() => events.length === 3);
  assert.deepEqual(signed[2], {
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 5_000_000_000n,
  });
  assert.deepEqual(
    events.map((e) => e.event),
    ["submitted", "submitted", "submitted"],
  );
});
