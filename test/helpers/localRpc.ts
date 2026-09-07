import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no TCP address");
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  return address.port;
}

export async function rpc(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method, params }),
    signal: AbortSignal.timeout(2000),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      id: number | null;
      result?: unknown;
      error?: { code: number; message: string };
    },
  };
}

async function start(
  t: TestContext,
  command: string,
  args: string[],
  url: string,
  env = process.env,
) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let error: Error | undefined;
  let output = "";
  child.on("error", (e) => {
    error = e;
  });
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  t.after(() => stop(child));
  for (let i = 0; i < 100; i++) {
    if (error) throw error;
    if (child.exitCode !== null)
      throw new Error(`${command} exited: ${output}`);
    try {
      const reply = await rpc(url, "eth_chainId");
      if (reply.status === 200 && reply.body.result) return child;
    } catch (e) {
      if (!(e instanceof TypeError) && !(e instanceof DOMException)) throw e;
    }
    await delay(25);
  }
  throw new Error(`${command} failed to start: ${output}`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

export async function startAnvil(t: TestContext) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  await start(
    t,
    "anvil",
    ["--port", String(port), "--no-mining", "--silent"],
    url,
  );
  return url;
}

export async function startGateway(
  t: TestContext,
  upstream: string,
  overrides: NodeJS.ProcessEnv = {},
) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  await start(t, process.execPath, ["infra/rpc-gateway/gateway.mjs"], url, {
    ...process.env,
    PORT: String(port),
    UPSTREAM: upstream,
    RPC_FILTER: "1",
    RPC_RATE_REFILL: "0",
    RPC_METHOD_ALLOW: "^(eth_|net_|web3_)",
    // Use the production default deny policy, regardless of the developer's shell.
    RPC_METHOD_DENY: undefined,
    LOG_FILE: "",
    METRICS_FILE: "",
    ...overrides,
  });
  return url;
}
