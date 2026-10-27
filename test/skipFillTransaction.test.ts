// The RPC gateway refuses eth_fillTransaction with HTTP 403; viem retried that on every send
// (~450 ms each). makeClients excludes the method so viem never sends it (sdk/src/chain.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeClients } from "../sdk/src/chain.js";

test("eth_fillTransaction is refused locally, without a request to the node", async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const calls = [JSON.parse(body)].flat() as Array<{ id: number; method: string }>;
      for (const c of calls) seen.push(c.method);
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: calls[0]?.id ?? null, error: { code: -32601, message: "method not permitted" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const { publicClient } = makeClients(`http://127.0.0.1:${port}`, 31337);
  const started = Date.now();
  await assert.rejects(
    publicClient.request({ method: "eth_fillTransaction" as never, params: [{}] as never }),
    (e: Error) => e.name === "MethodNotSupportedRpcError",
  );
  assert.deepEqual(seen, [], "nothing reached the node");
  assert.ok(Date.now() - started < 100, "no retry delay");
});
