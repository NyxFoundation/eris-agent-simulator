import test from "node:test";
import assert from "node:assert/strict";
import { rpc, startAnvil, startGateway } from "./helpers/localRpc.js";
import { feeRuleViolation, txFees } from "../infra/rpc-gateway/txGas.mjs";

test(
  "gateway seals pending transactions while preserving nonce seeding and mined reads",
  { timeout: 20_000 },
  async (t) => {
    const upstream = await startAnvil(t);
    const gateway = await startGateway(t, upstream);
    const accounts = (await rpc(upstream, "eth_accounts")).body
      .result as string[];
    // Even a filter created through another gateway/operator must not be readable here.
    const filter = (await rpc(upstream, "eth_newPendingTransactionFilter")).body
      .result;
    const sent = await rpc(upstream, "eth_sendTransaction", [
      {
        from: accounts[0],
        to: accounts[1],
        value: "0x1",
        gas: "0x5208",
      },
    ]);
    assert.equal(typeof sent.body.result, "string");
    assert.equal((await rpc(upstream, "eth_blockNumber")).body.result, "0x0");
    const pending = (
      await rpc(upstream, "eth_getBlockByNumber", ["pending", true])
    ).body.result as { transactions: { hash: string }[] };
    assert.equal(pending.transactions[0].hash, sent.body.result);

    const denied: [string, unknown[]][] = [
      ["eth_pendingTransactions", []],
      ["eth_newPendingTransactionFilter", []],
      ["eth_getFilterChanges", [filter]],
      ["eth_getFilterLogs", [filter]],
      ["eth_subscribe", ["newPendingTransactions"]],
      ["eth_getBlockByNumber", ["pending", true]],
      ["eth_getBlockByNumber", ["pending", false]],
      ["eth_getBlockTransactionCountByNumber", ["pending"]],
      ["eth_getTransactionByBlockNumberAndIndex", ["pending", "0x0"]],
      ["eth_getRawTransactionByBlockNumberAndIndex", ["pending", "0x0"]],
      ["eth_getBlockReceipts", ["pending"]],
    ];
    for (const [method, params] of denied) {
      const reply = await rpc(gateway, method, params);
      assert.equal(reply.status, 403, method);
      assert.equal(reply.body.error?.code, -32601, method);
      assert.equal(reply.body.id, 0, "preserve JSON-RPC id zero");
    }
    const mixed = await fetch(gateway, {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "eth_getBlockByNumber",
          params: ["pending", true],
        },
      ]),
    });
    assert.equal(
      mixed.status,
      403,
      "reject the entire mixed batch before forwarding",
    );
    assert.equal(
      (await rpc(gateway, "eth_getTransactionCount", [accounts[0], "pending"]))
        .body.result,
      "0x1",
    );
    assert.equal(
      (await rpc(gateway, "eth_getTransactionCount", [accounts[0], "latest"]))
        .body.result,
      "0x0",
    );
    assert.equal(
      (await rpc(gateway, "eth_getBlockTransactionCountByNumber", ["latest"]))
        .body.result,
      "0x0",
    );
    assert.equal(
      (
        await rpc(gateway, "eth_call", [
          { to: accounts[1], data: "0x" },
          "latest",
        ])
      ).body.result,
      "0x",
    );
    await rpc(upstream, "evm_mine");
    const mined = (await rpc(gateway, "eth_getBlockByNumber", ["0x1", true]))
      .body.result as { transactions: { hash: string }[] };
    assert.equal(mined.transactions[0].hash, sent.body.result);
    const metrics = await (await fetch(`${gateway}/metrics`)).text();
    assert.match(
      metrics,
      new RegExp(`rpc_method_denied_total\\{[^}]+\\} ${denied.length + 1}`),
    );

    const internal = await startGateway(t, upstream, { RPC_FILTER: "0" });
    assert.equal(
      (await rpc(internal, "eth_getBlockByNumber", ["pending", true])).status,
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// The fee rule: the field anvil orders by must be the price that is paid
// ---------------------------------------------------------------------------
//
// anvil `--order fees` sorts on maxFeePerGas, and at base fee 0 a tx pays min(maxFeePerGas, tip).
// Measured 2026-09-27 (anvil 1.7.1): tip 0.1 gwei + maxFeePerGas 7 gwei landed at txIndex 0 ahead
// of a 6/6 gwei tx shaped like the oracle update, paying 0.1 gwei/gas. The gateway only read the
// gas limit, so such a transaction passed it.

const GWEI = 1_000_000_000n;
const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

async function signed(tx: Record<string, unknown>): Promise<`0x${string}`> {
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(KEY).signTransaction({
    to: "0x0000000000000000000000000000000000000001",
    value: 0n,
    gas: 21_000n,
    chainId: 31337,
    ...tx,
  } as never);
}

test("txFees reads the fee fields of every envelope the gas reader knows, and nothing else", async () => {
  assert.deepEqual(
    txFees(await signed({ type: "eip1559", nonce: 0, maxFeePerGas: 7n * GWEI, maxPriorityFeePerGas: GWEI / 10n })),
    { type: 2, maxPriorityFeePerGas: GWEI / 10n, maxFeePerGas: 7n * GWEI },
  );
  assert.deepEqual(
    txFees(await signed({ type: "eip7702", nonce: 0, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI, authorizationList: [] })),
    { type: 4, maxPriorityFeePerGas: GWEI, maxFeePerGas: 3n * GWEI },
  );
  assert.deepEqual(
    txFees(await signed({ type: "legacy", nonce: 0, gasPrice: 6n * GWEI })),
    { type: 0, gasPrice: 6n * GWEI },
  );
  assert.deepEqual(
    txFees(await signed({ type: "eip2930", nonce: 0, gasPrice: 2n * GWEI, accessList: [] })),
    { type: 1, gasPrice: 2n * GWEI },
  );
  // Unknown envelope / empty: unreadable, which the gateway refuses (fail closed, like the gas cap).
  assert.equal(txFees("0x7fdeadbeef"), null);
  assert.equal(txFees("0x"), null);
});

test("feeRuleViolation: maxFeePerGas above the tip is refused even with the cap disabled", () => {
  const CAP = 5n * GWEI;
  assert.equal(
    feeRuleViolation({ type: 2, maxPriorityFeePerGas: GWEI / 10n, maxFeePerGas: 7n * GWEI }, CAP)?.kind,
    "max_fee_above_tip",
  );
  assert.equal(
    feeRuleViolation({ type: 2, maxPriorityFeePerGas: GWEI, maxFeePerGas: 3n * GWEI }, 0n)?.kind,
    "max_fee_above_tip",
  );
  assert.equal(feeRuleViolation({ type: 2, maxPriorityFeePerGas: CAP, maxFeePerGas: CAP }, CAP), null);
  assert.equal(
    feeRuleViolation({ type: 2, maxPriorityFeePerGas: CAP + 1n, maxFeePerGas: CAP + 1n }, CAP)?.kind,
    "over_cap",
  );
  assert.equal(feeRuleViolation({ type: 0, gasPrice: CAP + 1n }, CAP)?.kind, "over_cap");
  assert.equal(feeRuleViolation({ type: 0, gasPrice: CAP + 1n }, 0n), null);
});

test(
  "gateway refuses a raw tx whose maxFeePerGas exceeds its tip or the cap, and forwards the rest",
  { timeout: 20_000 },
  async (t) => {
    const upstream = await startAnvil(t);
    const gateway = await startGateway(t, upstream);
    const { privateKeyToAccount } = await import("viem/accounts");
    await rpc(upstream, "anvil_setBalance", [
      privateKeyToAccount(KEY).address,
      "0x3635c9adc5dea00000",
    ]);
    const send = (url: string, raw: string) =>
      rpc(url, "eth_sendRawTransaction", [raw]);

    // The front-run shape: tip 1 gwei, maxFeePerGas 3 gwei.
    const overbid = await send(
      gateway,
      await signed({ type: "eip1559", nonce: 0, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI }),
    );
    assert.equal(overbid.status, 403);
    assert.equal(overbid.body.error?.code, -32003);
    assert.match(overbid.body.error?.message ?? "", /maxFeePerGas 3000000000 exceeds maxPriorityFeePerGas 1000000000/);
    assert.equal(overbid.body.id, 0, "preserve JSON-RPC id zero");

    // maxFeePerGas = tip: forwarded (the refusals above consumed no nonce).
    const honest = await send(
      gateway,
      await signed({ type: "eip1559", nonce: 0, maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 2n * GWEI }),
    );
    assert.equal(honest.status, 200);
    assert.equal(typeof honest.body.result, "string");

    // Over the 5 gwei default cap: 6/6 gwei (the oracle update's own fee) and a legacy 6 gwei.
    for (const tx of [
      { type: "eip1559", nonce: 1, maxFeePerGas: 6n * GWEI, maxPriorityFeePerGas: 6n * GWEI },
      { type: "legacy", nonce: 1, gasPrice: 6n * GWEI },
    ]) {
      const reply = await send(gateway, await signed(tx));
      assert.equal(reply.status, 403, tx.type);
      assert.match(reply.body.error?.message ?? "", /exceeds the priority-fee cap 5000000000/);
    }
    const legacy = await send(gateway, await signed({ type: "legacy", nonce: 1, gasPrice: 2n * GWEI }));
    assert.equal(legacy.status, 200);

    // A batch is refused whole when any member breaks the rule.
    const batch = await fetch(gateway, {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "eth_sendRawTransaction",
          params: [await signed({ type: "eip1559", nonce: 2, maxFeePerGas: 7n * GWEI, maxPriorityFeePerGas: GWEI / 10n })],
        },
      ]),
    });
    assert.equal(batch.status, 403);

    const metrics = await (await fetch(`${gateway}/metrics`)).text();
    assert.match(metrics, /rpc_fee_denied_total\{[^}]+\} 4/);

    // RPC_MAX_PRIORITY_FEE_WEI=0 retires the cap (economic gas), not the maxFeePerGas half.
    const uncapped = await startGateway(t, upstream, { RPC_MAX_PRIORITY_FEE_WEI: "0" });
    assert.equal(
      (await send(uncapped, await signed({ type: "eip1559", nonce: 2, maxFeePerGas: 6n * GWEI, maxPriorityFeePerGas: 6n * GWEI }))).status,
      200,
    );
    assert.equal(
      (await send(uncapped, await signed({ type: "eip1559", nonce: 3, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI }))).status,
      403,
    );

    await rpc(upstream, "evm_mine");
    const block = (await rpc(upstream, "eth_getBlockByNumber", ["latest", false])).body
      .result as { transactions: string[] };
    assert.deepEqual(block.transactions.length, 3);
  },
);
