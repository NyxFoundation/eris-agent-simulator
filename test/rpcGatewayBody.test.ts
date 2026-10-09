import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, rpc, startGateway } from "./helpers/localRpc.js";

// Issue #216 (3). Two gateway behaviours that need no chain: the request body cap, and sealing an
// unmined transaction read by hash. The upstream is a fake JSON-RPC server that answers from a
// table, so the test pins the gateway's rewrite, not anvil's.

const PENDING = `0x${"a".repeat(64)}`;
const MINED = `0x${"b".repeat(64)}`;
const RAW = "0x02f86c0180843b9aca00843b9aca0082520894000000000000000000000000000000000000dead0180c0";

type Call = { jsonrpc: "2.0"; id: unknown; method: string; params?: unknown[] };

function answer(c: Call): unknown {
  const hash = c.params?.[0];
  switch (c.method) {
    case "eth_chainId":
      return "0x7a69";
    case "eth_blockNumber":
      return "0x1";
    case "eth_getTransactionByHash":
      if (hash === PENDING) return { hash, blockNumber: null, input: "0xdeadbeef" };
      if (hash === MINED) return { hash, blockNumber: "0x1", input: "0xdeadbeef" };
      return null;
    case "eth_getRawTransactionByHash":
      return hash === PENDING || hash === MINED ? RAW : null;
    case "eth_getTransactionReceipt":
      return hash === MINED ? { transactionHash: hash, blockNumber: "0x1", status: "0x1" } : null;
    default:
      return null;
  }
}

async function startFakeUpstream(t: TestContext) {
  const seen: Call[] = [];
  let bytes = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      bytes += body.length;
      const parsed = JSON.parse(body.toString("utf8")) as Call | Call[];
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      seen.push(...calls);
      const replies = calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: answer(c) }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  const port = await freePort();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}`, seen, bytes: () => bytes };
}

test("an unmined transaction read by hash is null; a mined one passes through", { timeout: 20_000 }, async (t) => {
  const upstream = await startFakeUpstream(t);
  const gateway = await startGateway(t, upstream.url);

  assert.equal((await rpc(gateway, "eth_getTransactionByHash", [PENDING])).body.result, null);
  const mined = (await rpc(gateway, "eth_getTransactionByHash", [MINED])).body.result as { blockNumber: string; input: string };
  assert.equal(mined.blockNumber, "0x1");
  assert.equal(mined.input, "0xdeadbeef");
  assert.equal((await rpc(gateway, "eth_getTransactionByHash", [`0x${"c".repeat(64)}`])).body.result, null);

  // The raw form carries no block field: the gateway asks the upstream for the receipt.
  const receiptsBefore = upstream.seen.filter((c) => c.method === "eth_getTransactionReceipt").length;
  assert.equal((await rpc(gateway, "eth_getRawTransactionByHash", [PENDING])).body.result, null);
  assert.equal((await rpc(gateway, "eth_getRawTransactionByHash", [MINED])).body.result, RAW);
  assert.equal(upstream.seen.filter((c) => c.method === "eth_getTransactionReceipt").length, receiptsBefore + 2);

  // The reference runtime polls receipts (example/agents/runtime/send.ts): unchanged, null while pending.
  assert.equal((await rpc(gateway, "eth_getTransactionReceipt", [PENDING])).body.result, null);
  assert.equal(((await rpc(gateway, "eth_getTransactionReceipt", [MINED])).body.result as { status: string }).status, "0x1");

  // A batch is sealed member by member, matched by id, with the other members untouched.
  const batch = await fetch(gateway, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 7, method: "eth_getTransactionByHash", params: [PENDING] },
      { jsonrpc: "2.0", id: "eight", method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 9, method: "eth_getRawTransactionByHash", params: [MINED] },
      { jsonrpc: "2.0", id: 10, method: "eth_getRawTransactionByHash", params: [PENDING] },
    ]),
  });
  assert.equal(batch.status, 200);
  const replies = (await batch.json()) as Array<{ id: unknown; result: unknown }>;
  assert.deepEqual(
    replies.map((r) => [r.id, r.result]),
    [[7, null], ["eight", "0x1"], [9, RAW], [10, null]],
  );
  const metrics = await (await fetch(`${gateway}/metrics`)).text();
  assert.match(metrics, /rpc_pending_sealed_total\{[^}]+\} 4\n/);
});

test("a batch where a read by hash shares its id is refused before the upstream", { timeout: 20_000 }, async (t) => {
  const upstream = await startFakeUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const post = (batch: unknown[]) =>
    fetch(gateway, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });

  // The seal matched replies to calls by id: under a shared id it judged one reply by the other call.
  const shapes: unknown[][] = [
    [
      { jsonrpc: "2.0", id: 1, method: "eth_getRawTransactionByHash", params: [PENDING] },
      { jsonrpc: "2.0", id: 1, method: "eth_getRawTransactionByHash", params: [MINED] },
    ],
    [
      { jsonrpc: "2.0", id: 1, method: "eth_getRawTransactionByHash", params: [PENDING] },
      { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [PENDING] },
    ],
    [
      { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [PENDING] },
      { jsonrpc: "2.0", id: "1", method: "eth_getRawTransactionByHash", params: [MINED] },
    ],
    [
      { jsonrpc: "2.0", id: 5, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 5, method: "eth_getTransactionByHash", params: [PENDING] },
    ],
    [
      { jsonrpc: "2.0", method: "eth_getTransactionByHash", params: [PENDING] },
      { jsonrpc: "2.0", id: null, method: "eth_getRawTransactionByHash", params: [MINED] },
    ],
  ];
  const before = upstream.seen.length;
  for (const batch of shapes) {
    const response = await post(batch);
    assert.equal(response.status, 400, JSON.stringify(batch));
    const body = (await response.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32600);
  }
  assert.equal(upstream.seen.length, before, "a refused batch never reaches the upstream");

  // Other calls under one id are the client's own business: forwarded and answered as before.
  const shared = await post([
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  ]);
  assert.equal(shared.status, 200);
  assert.deepEqual(((await shared.json()) as Array<{ result: unknown }>).map((r) => r.result), ["0x7a69", "0x1"]);

  // Distinct ids still seal member by member.
  const distinct = await post([
    { jsonrpc: "2.0", id: 1, method: "eth_getRawTransactionByHash", params: [PENDING] },
    { jsonrpc: "2.0", id: 2, method: "eth_getRawTransactionByHash", params: [MINED] },
  ]);
  assert.equal(distinct.status, 200);
  assert.deepEqual(((await distinct.json()) as Array<{ result: unknown }>).map((r) => r.result), [null, RAW]);

  const metrics = await (await fetch(`${gateway}/metrics`)).text();
  assert.match(metrics, new RegExp(`rpc_dup_id_denied_total\\{[^}]+\\} ${shapes.length}\\n`));
});

test("a request body over the cap is refused with 413 and never reaches the upstream", { timeout: 20_000 }, async (t) => {
  const upstream = await startFakeUpstream(t);
  const gateway = await startGateway(t, upstream.url, { RPC_MAX_BODY_BYTES: "1024" });
  const padded = (n: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: ["x".repeat(n)] });

  // Under the cap: forwarded as before.
  const small = padded(500);
  assert.ok(Buffer.byteLength(small) < 1024);
  const ok = await fetch(gateway, { method: "POST", headers: { "content-type": "application/json" }, body: small });
  assert.equal(ok.status, 200);
  const bytesAfterSmall = upstream.bytes();

  // Declared over the cap: refused before the body is read.
  const big = padded(4000);
  const declared = await fetch(gateway, { method: "POST", headers: { "content-type": "application/json" }, body: big });
  assert.equal(declared.status, 413);
  assert.equal(((await declared.json()) as { error: { code: number } }).error.code, -32600);

  // Not declared (chunked) and over the cap: refused when the bytes arrive.
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(gateway, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.write(big.slice(0, 900));
    setTimeout(() => {
      // The gateway may have closed the socket already; a write error after the 413 is fine.
      req.on("error", () => {});
      req.write(big.slice(900));
      req.end();
    }, 50);
  });
  assert.equal(status, 413);

  assert.equal(upstream.bytes(), bytesAfterSmall, "oversized bodies were not forwarded");
  const metrics = await (await fetch(`${gateway}/metrics`)).text();
  assert.match(metrics, /rpc_body_denied_total\{[^}]+\} 2\n/);
});

// 2026-10-08: the disk filled and the first failed write to the request log killed the gateway, and
// every participant's RPC with it. A log file that cannot be written (here: a path that is a
// directory, which fails the same way on every platform) must cost log lines, not service.
test("a request log that cannot be written drops lines and keeps serving", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eris-gw-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = await startFakeUpstream(t);
  const gateway = await startGateway(t, upstream.url, { LOG_FILE: dir });

  for (let i = 0; i < 5; i++) {
    assert.equal((await rpc(gateway, "eth_blockNumber")).body.result, "0x1");
    await new Promise((r) => setTimeout(r, 50));
  }
  const metrics = await (await fetch(`${gateway}/metrics`)).text();
  const dropped = Number(/rpc_log_lines_dropped_total\{[^}]+\} (\d+)\n/.exec(metrics)?.[1]);
  assert.ok(dropped >= 1, `dropped lines are counted (got ${dropped})`);
});
