import test from "node:test";
import assert from "node:assert/strict";
import { LATCH_CODE, rpc, startAnvil, startGateway } from "./helpers/localRpc.js";
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

// ---------------------------------------------------------------------------
// The allowlist names methods; the pending tag is refused wherever it appears
// ---------------------------------------------------------------------------
//
// The allowlist used to be the prefix ^(eth_|net_|web3_), so every eth_ method the node has passed
// unless the deny regex named it. anvil accepts eth_sendUnsignedTransaction from any `from` without a
// signature or impersonation, and eth_sendRawTransactionSync skipped the gas cap and the fee rule
// (both read only eth_sendRawTransaction). The pending tag was refused only as params[0] of five
// block-enumeration methods, while a state read at "pending" executes against the pool.

test(
  "gateway refuses methods outside the explicit list and the pending tag in any position",
  { timeout: 20_000 },
  async (t) => {
    const upstream = await startAnvil(t);
    const gateway = await startGateway(t, upstream);
    const someone = "0x00000000000000000000000000000000DeaDBeef";
    await rpc(upstream, "anvil_setBalance", [someone, "0xde0b6b3a7640000"]);
    const dest = "0x0000000000000000000000000000000000001234";

    const denied: [string, unknown[]][] = [
      [
        "eth_sendUnsignedTransaction",
        [{ from: someone, to: dest, value: "0x1", gas: "0x5208", gasPrice: "0x1" }],
      ],
      ["eth_sendRawTransactionSync", ["0x00"]],
      ["eth_fillTransaction", [{ from: someone, to: dest }]],
      ["eth_simulateV1", [{ blockStateCalls: [] }, "latest"]],
      ["eth_call", [{ to: dest, data: "0x" }, "pending"]],
      ["eth_call", [{ to: dest, data: "0x" }, "Pending"]],
      ["eth_getBalance", [dest, "pending"]],
      ["eth_getStorageAt", [dest, "0x0", "pending"]],
      ["eth_getCode", [dest, "pending"]],
      ["eth_estimateGas", [{ to: dest }, "pending"]],
      ["eth_getLogs", [{ fromBlock: "latest", toBlock: "pending" }]],
      ["eth_newFilter", [{ fromBlock: "pending" }]],
    ];
    for (const [method, params] of denied) {
      const reply = await rpc(gateway, method, params);
      assert.equal(reply.status, 403, `${method} ${JSON.stringify(params)}`);
      assert.equal(reply.body.error?.code, -32601, method);
    }
    // Nothing reached the pool: the unsigned send was refused before anvil saw it.
    assert.equal(
      (await rpc(upstream, "eth_getTransactionCount", [someone, "pending"])).body.result,
      "0x0",
    );

    // The reads participants rely on still pass, at latest and at a number.
    for (const [method, params] of [
      ["eth_getBalance", [dest, "latest"]],
      ["eth_call", [{ to: dest, data: "0x" }, "latest"]],
      ["eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest" }]],
      ["eth_getTransactionCount", [someone, "pending"]],
      ["eth_feeHistory", ["0x1", "latest", []]],
    ] as [string, unknown[]][]) {
      const reply = await rpc(gateway, method, params);
      assert.equal(reply.status, 200, `${method} ${JSON.stringify(params)}`);
    }

    // An operator-supplied regex still replaces the list.
    const wide = await startGateway(t, upstream, { RPC_METHOD_ALLOW: "^(eth_|net_|web3_)" });
    assert.equal(
      (await rpc(wide, "eth_simulateV1", [{ blockStateCalls: [] }, "latest"])).status,
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// A request cannot end the process; an omitted block tag is not a pending read
// ---------------------------------------------------------------------------
//
// The pending check recursed, and ~6,000 nested arrays (12KB) ran the stack out inside the request
// handler, uncaught: one request killed the shared gateway. And anvil runs eth_estimateGas without a
// block parameter against the pool, which the string check could not see.

test(
  "gateway refuses a deeply nested body without dying, and estimates gas at latest when the tag is omitted",
  { timeout: 20_000 },
  async (t) => {
    const upstream = await startAnvil(t);
    const gateway = await startGateway(t, upstream);

    const depth = 6_000;
    const nested = "[".repeat(depth) + "]".repeat(depth);
    const deep = await fetch(gateway, {
      method: "POST",
      body: `{"jsonrpc":"2.0","id":1,"method":"eth_call","params":${nested}}`,
    });
    assert.equal(deep.status, 400);
    assert.equal(((await deep.json()) as { error?: { code: number } }).error?.code, -32600);
    // Also inside a batch, and on a method the pending check exempts.
    const deepBatch = await fetch(gateway, {
      method: "POST",
      body: `[{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionCount","params":${nested}}]`,
    });
    assert.equal(deepBatch.status, 400);
    // Still serving.
    assert.equal((await rpc(gateway, "eth_chainId")).status, 200);
    const metrics = await (await fetch(`${gateway}/metrics`)).text();
    assert.match(metrics, /rpc_params_denied_total\{[^}]+\} 2/);
    // A realistic shape (eth_getLogs topics) is far inside the limits.
    assert.equal(
      (await rpc(gateway, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", topics: [[null]] }])).status,
      200,
    );

    // The pool holds the call that opens the latch; latest does not.
    const LATCH = "0x0000000000000000000000000000000000001a7c";
    await rpc(upstream, "anvil_setCode", [LATCH, LATCH_CODE]);
    const accounts = (await rpc(upstream, "eth_accounts")).body.result as string[];
    await rpc(upstream, "eth_sendTransaction", [
      { from: accounts[0], to: LATCH, data: "0x01", gas: "0x186a0" },
    ]);
    const probe = { from: accounts[1], to: LATCH, data: "0x" };
    // Direct to anvil: the omitted tag reads the pool (this is what the gateway closes).
    assert.equal(typeof (await rpc(upstream, "eth_estimateGas", [probe])).body.result, "string");
    // Through the gateway: the same call is evaluated at latest, where the latch is shut.
    for (const params of [[probe], [probe, null]]) {
      const reply = await rpc(gateway, "eth_estimateGas", params);
      assert.equal(reply.status, 200);
      assert.match(reply.body.error?.message ?? "", /revert/i, JSON.stringify(params));
    }
    assert.match(
      (await rpc(gateway, "eth_estimateGas", [probe, "latest"])).body.error?.message ?? "",
      /revert/i,
    );
    await rpc(upstream, "evm_mine");
    assert.equal(typeof (await rpc(gateway, "eth_estimateGas", [probe])).body.result, "string");
  },
);
