import { spawn, type ChildProcess } from "node:child_process";
import { RPC_URL, RPC_PORT } from "./config.js";

let proc: ChildProcess | null = null;

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "web3_clientVersion",
        params: [],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilUp(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUp()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`anvil did not start at ${RPC_URL}`);
}

/**
 * Start anvil. If one is already running, reuse it.
 * - --code-size-limit: required for large contracts like Uniswap V3
 * - --base-fee 0: simplifies gas accounting
 * - --gas-limit: large, to accommodate heavy txs like GMX
 *
 * Note: the poc backtest CLI (core/src/cli/backtest.ts) starts a state-dump replay
 * anvil with the same calibration as here. When changing flags, keep that in sync (ADR 0016).
 */
export async function startAnvil(): Promise<void> {
  if (await isUp()) {
    console.log(`anvil is already running (${RPC_URL}) — reusing it`);
    return;
  }
  console.log(`Starting anvil (port ${RPC_PORT})...`);
  proc = spawn(
    "anvil",
    [
      "--port",
      String(RPC_PORT),
      "--code-size-limit",
      "50000",
      "--base-fee",
      "0",
      "--gas-limit",
      "3000000000",
      "--accounts",
      "10",
      "--balance",
      "1000000",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  proc.on("exit", (code) => {
    if (code && code !== 0) console.error(`anvil exited (code ${code})`);
  });
  await waitUntilUp();
  console.log("anvil started");
}

export function stopAnvil() {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    proc = null;
  }
}

export function anvilManagedHere(): boolean {
  return proc !== null;
}
