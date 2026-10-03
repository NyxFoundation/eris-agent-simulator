// The box side of a registration: the same four steps register.sh runs over SSH, run in place.
//
//   1. read config/registrations.yaml (what is already registered)
//   2. back it up and append the entry (the coordinator re-reads the file about once a minute)
//   3. watch the current segment's events.jsonl, from where it ended before the write, for the
//      coordinator's verdict on this id
//   4. read the address's ETH / WETH / WBTC / USDC from the chain
import { appendFileSync, copyFileSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { formatUnits, tokenAddressFromConstants } from "./lib.mjs";

export function registrationsFile(repoDir) {
  return join(repoDir, "config/registrations.yaml");
}

export function readRegistrations(repoDir) {
  const doc = parseYaml(readFileSync(registrationsFile(repoDir), "utf8"));
  if (doc == null) return [];
  if (!Array.isArray(doc)) throw new Error("config/registrations.yaml is not a list");
  return doc;
}

/** The segment being written now: infra/monitoring/.env names the period, the period names the segment. */
export function currentSegmentDir(repoDir) {
  const env = readFileSync(join(repoDir, "infra/monitoring/.env"), "utf8");
  const m = /^ERIS_DASHBOARD_COMPETITIONS=(.*)$/m.exec(env);
  const period = m?.[1].split(",")[0].trim();
  if (!period) throw new Error("cannot find the running period (ERIS_DASHBOARD_COMPETITIONS is empty)");
  const pointer = join(repoDir, "runs", period, "current-segment");
  return { period, segmentDir: resolve(repoDir, readFileSync(pointer, "utf8").trim()) };
}

/**
 * Append one entry, keeping the previous file as ~/registrations.yaml.before-<id> like register.sh.
 * If the result no longer parses, the backup goes back before anyone reads it: a malformed file is
 * not just this entry lost, the coordinator stops picking up every later one too.
 */
export function appendRegistration(repoDir, agentId, entry, backupDir = homedir()) {
  const file = registrationsFile(repoDir);
  const backup = join(backupDir, `registrations.yaml.before-${agentId}`);
  copyFileSync(file, backup);
  appendFileSync(file, entry);
  try {
    const n = readRegistrations(repoDir).length;
    return { backup, entries: n };
  } catch (error) {
    copyFileSync(backup, file);
    throw new Error(`the file stopped parsing after the append and was restored: ${error.message}`);
  }
}

export function eventsOffset(segmentDir) {
  try {
    return statSync(join(segmentDir, "events.jsonl")).size;
  } catch {
    return 0;
  }
}

function readFrom(file, offset) {
  const size = statSync(file).size;
  if (size <= offset) return { text: "", end: offset };
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.toString("utf8"), end: size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Wait for the coordinator's verdict on `agentId`, reading only what was appended after `offset`.
 * Resolves { kind: "registered" | "ignored" | "failed" | "reload-failed" | "timeout", detail? }.
 */
export async function waitForVerdict(segmentDir, offset, agentId, { timeoutMs = 180_000, pollMs = 4_000 } = {}) {
  const file = join(segmentDir, "events.jsonl");
  const deadline = Date.now() + timeoutMs;
  let pos = offset;
  let carry = "";
  while (Date.now() < deadline) {
    const { text, end } = readFrom(file, pos);
    pos = end;
    const lines = (carry + text).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.includes(agentId) && !line.includes("registrations_reload_failed")) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "agent_external_registered" && e.agentId === agentId) return { kind: "registered" };
      if (e.type === "registration_ignored" && e.id === agentId) return { kind: "ignored", detail: e.reason };
      if (e.type === "registration_failed" && e.id === agentId) return { kind: "failed", detail: e.error };
      if (e.type === "registrations_reload_failed") return { kind: "reload-failed", detail: e.error };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { kind: "timeout" };
}

async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const pad = (address) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** "ETH 1 / WETH 8 / WBTC 0.4 / USDC 25000", read from the chain the way register.sh reads it. */
export async function balancesLine(repoDir, rpcUrl, address) {
  const constants = readFileSync(join(repoDir, "sdk/src/constants.local.ts"), "utf8");
  const parts = [`ETH ${formatUnits(await rpc(rpcUrl, "eth_getBalance", [address, "latest"]), 18)}`];
  for (const symbol of ["WETH", "WBTC", "USDC"]) {
    const token = tokenAddressFromConstants(constants, symbol);
    if (!token) continue;
    const decimals = Number(await rpc(rpcUrl, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]));
    const balance = await rpc(rpcUrl, "eth_call", [{ to: token, data: `0x70a08231${pad(address)}` }, "latest"]);
    parts.push(`${symbol} ${formatUnits(balance, decimals)}`);
  }
  return parts.join(" / ");
}
