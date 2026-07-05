import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Abi, Address, Hex } from "viem";
import { publicClient } from "./clients.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

/** Read abi + bytecode from forge's out/<File>.sol/<Contract>.json */
export function loadForgeArtifact(
  file: string,
  contract: string,
): {
  abi: Abi;
  bytecode: Hex;
} {
  const path = resolve(ROOT, "out", `${file}.sol`, `${contract}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}

/** Read any {abi, bytecode} JSON (an artifact under vendor/) */
export function loadJsonArtifact(absPath: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(absPath, "utf8"));
  const bytecode =
    typeof json.bytecode === "string"
      ? json.bytecode
      : (json.bytecode?.object ?? json.evm?.bytecode?.object);
  return { abi: json.abi as Abi, bytecode: bytecode as Hex };
}

export async function waitTx(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // viem returns a receipt even on revert (it does not throw). Missing a silent revert
  // leads to quiet bugs like "deploy succeeded but the pool is empty", so always check status.
  if (receipt.status !== "success") {
    throw new Error(`tx reverted: ${hash} (block ${receipt.blockNumber})`);
  }
  return receipt;
}

export function ok(label: string, msg = "") {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${msg ? ` ${msg}` : ""}`);
}

export function info(label: string) {
  console.log(`\n\x1b[36m▶ ${label}\x1b[0m`);
}

export function fail(label: string, err: unknown): never {
  console.error(`  \x1b[31m✗ ${label}\x1b[0m`);
  throw err;
}

export function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** Compute Uniswap V3 sqrtPriceX96 from a "token1 / token0" price */
export function encodeSqrtRatioX96(amount1: bigint, amount0: bigint): bigint {
  const numerator = amount1 << 192n;
  const ratioX192 = numerator / amount0;
  return sqrt(ratioX192);
}

function sqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("negative");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

export type Hex32 = `0x${string}`;
export type { Address };
