import { spawn, type ChildProcess } from "node:child_process";
import { getAddress } from "viem";
import { accounts } from "./clients.js";
import { RPC_URL, RPC_PORT, MNEMONIC, MNEMONIC_IS_DEFAULT } from "./config.js";

let proc: ChildProcess | null = null;

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function isUp(): Promise<boolean> {
  try {
    await rpc("web3_clientVersion");
    return true;
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
 * The anvil command line, in one place.
 *
 * - --code-size-limit: required for large contracts like Uniswap V3
 * - --base-fee 0: simplifies gas accounting
 * - --gas-limit: large, to accommodate heavy txs like GMX
 * - --mnemonic: which keys own the chain. Passed always, even for the public default, so that the
 *   flag cannot be present on one path and absent on another -- the anvil this process starts and
 *   the one `npm run anvil` starts have to be the same chain (issue #74).
 *
 * Note: the poc backtest CLI (core/src/cli/backtest.ts) starts a state-dump replay anvil with the
 * same calibration as here. When changing flags, keep that in sync (ADR 0016).
 */
export function anvilArgs(
  opts: { port?: number; mnemonic?: string } = {},
): string[] {
  return [
    "--port",
    String(opts.port ?? RPC_PORT),
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
    "--mnemonic",
    opts.mnemonic ?? MNEMONIC,
  ];
}

/**
 * A running anvil is only reusable if it holds the same keys.
 *
 * Every venue's privileged role -- Aave's POOL_ADMIN, GMX's CONFIG_KEEPER, the owner of the seeded
 * LP positions -- goes to whichever account index 0 this process derives, and every contract
 * address is CREATE(deployer, nonce). Deploy against an anvil that was started with a different
 * mnemonic and the deployer has no balance at all; deploy the *other* way round -- a secret-
 * mnemonic chain reused by a default-mnemonic deploy -- and the chain quietly ends up owned by a
 * key that is printed in anvil's banner, which is the whole of issue #74.
 */
async function assertSameKeys(): Promise<void> {
  let unlocked: string[];
  try {
    unlocked = await rpc<string[]>("eth_accounts");
  } catch {
    return; // node did not answer; nothing to compare against
  }
  // An external node (issue #33) unlocks nothing. There is no claim to check, so make none.
  if (!unlocked || unlocked.length === 0) return;
  const want = accounts.deployer.address;
  const got = getAddress(unlocked[0]);
  if (got === want) return;
  throw new Error(
    `the anvil already running at ${RPC_URL} was started from a different mnemonic: its first ` +
      `account is ${got}, but MNEMONIC here derives ${want}. Deploying now would sign with keys ` +
      `that chain has never funded, and the venues would end up owned by whichever mnemonic ` +
      `anvil holds. Stop that anvil and let this process start one (or start it with ` +
      `\`npm run anvil\`, which reads the same MNEMONIC).`,
  );
}

/** Start anvil. If one is already running with the same keys, reuse it. */
export async function startAnvil(): Promise<void> {
  if (await isUp()) {
    await assertSameKeys();
    console.log(`anvil is already running (${RPC_URL}) — reusing it`);
    return;
  }
  console.log(
    `Starting anvil (port ${RPC_PORT}${MNEMONIC_IS_DEFAULT ? "" : ", custom mnemonic"})...`,
  );
  proc = spawn("anvil", anvilArgs(), {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.on("exit", (code) => {
    if (code && code !== 0) console.error(`anvil exited (code ${code})`);
  });
  await waitUntilUp();
  console.log(`anvil started (deployer ${accounts.deployer.address})`);
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
