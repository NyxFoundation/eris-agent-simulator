import test from "node:test";
import assert from "node:assert/strict";
import { rpc, startAnvil, startGateway } from "./helpers/localRpc.js";

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
