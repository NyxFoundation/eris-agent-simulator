// The box side against a temporary directory shaped like the repository on the box, and a fake RPC.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRegistration,
  balancesLine,
  currentSegmentDir,
  eventsOffset,
  readRegistrations,
  waitForVerdict,
} from "../src/devnet.mjs";
import { registrationEntry } from "../src/lib.mjs";

const PERIOD = "2026-09-28T09-13-09-294Z";
const A = "0x2633DdCB442B0Ef8a782f3b8CdF4B226a39626bB";
const WETH = "0x4806ddDB48da9285EED230C907075861a50A75f4";
const USDC = "0x04370d7F67549867eB93427B453FF5F6ceb0A27A";

function fakeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "faucet-repo-"));
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, "config/registrations.yaml"), `- id: alice\n  address: "0x${"1".repeat(40)}"\n`);
  mkdirSync(join(repo, "infra/monitoring"), { recursive: true });
  writeFileSync(join(repo, "infra/monitoring/.env"), `FOO=1\nERIS_DASHBOARD_COMPETITIONS=${PERIOD},other\n`);
  const seg = join(repo, "runs", PERIOD, "2026-10-02-s04");
  mkdirSync(seg, { recursive: true });
  writeFileSync(join(repo, "runs", PERIOD, "current-segment"), `runs/${PERIOD}/2026-10-02-s04\n`);
  writeFileSync(join(seg, "events.jsonl"), "");
  mkdirSync(join(repo, "sdk/src"), { recursive: true });
  writeFileSync(
    join(repo, "sdk/src/constants.local.ts"),
    `    WETH: { address: Address; decimals: number };\n    WETH: { address: "${WETH}" as Address, decimals: 18 },\n    USDC: { address: "${USDC}" as Address, decimals: 6 },\n`,
  );
  return { repo, seg };
}

test("the current segment is found the way register.sh finds it", () => {
  const { repo, seg } = fakeRepo();
  assert.deepEqual(currentSegmentDir(repo), { period: PERIOD, segmentDir: seg });
});

test("an entry is appended after a backup, and parses", () => {
  const { repo } = fakeRepo();
  const { entries } = appendRegistration(repo, "bob", registrationEntry({ agentId: "bob", address: A, date: "2026-10-03" }), repo);
  assert.equal(entries, 2);
  assert.deepEqual(readRegistrations(repo).map((e) => e.id), ["alice", "bob"]);
});

test("an append that breaks the file is rolled back", () => {
  const { repo } = fakeRepo();
  const before = readFileSync(join(repo, "config/registrations.yaml"), "utf8");
  assert.throws(() => appendRegistration(repo, "bad", "\n- id: [unclosed\n", repo), /restored/);
  assert.equal(readFileSync(join(repo, "config/registrations.yaml"), "utf8"), before);
});

test("the verdict is read only from what was written after the append", async () => {
  const { seg } = fakeRepo();
  const events = join(seg, "events.jsonl");
  // An older registration of the same id must not count.
  appendFileSync(events, JSON.stringify({ type: "agent_external_registered", agentId: "bob" }) + "\n");
  const offset = eventsOffset(seg);
  setTimeout(() => {
    appendFileSync(events, JSON.stringify({ type: "block", n: 1 }) + "\n");
    appendFileSync(events, JSON.stringify({ type: "registration_ignored", id: "bob", reason: "taken" }) + "\n");
  }, 50);
  const v = await waitForVerdict(seg, offset, "bob", { timeoutMs: 2_000, pollMs: 20 });
  assert.deepEqual(v, { kind: "ignored", detail: "taken" });
});

test("a reload failure is reported, and silence is a timeout", async () => {
  const { seg } = fakeRepo();
  const offset = eventsOffset(seg);
  assert.deepEqual(await waitForVerdict(seg, offset, "bob", { timeoutMs: 100, pollMs: 20 }), { kind: "timeout" });
  appendFileSync(join(seg, "events.jsonl"), JSON.stringify({ type: "registrations_reload_failed", error: "bad yaml" }) + "\n");
  assert.deepEqual(await waitForVerdict(seg, offset, "bob", { timeoutMs: 1_000, pollMs: 20 }), {
    kind: "reload-failed",
    detail: "bad yaml",
  });
});

test("balances are read from the chain in register.sh's format", async () => {
  const { repo } = fakeRepo();
  const hex = (n) => "0x" + BigInt(n).toString(16);
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      let result;
      if (method === "eth_getBalance") result = hex(10n ** 18n);
      else if (params[0].data === "0x313ce567") result = hex(params[0].to === WETH ? 18 : 6);
      else result = hex(params[0].to === WETH ? 8n * 10n ** 18n : 25_000_000_000n);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const line = await balancesLine(repo, `http://127.0.0.1:${server.address().port}`, A);
    assert.equal(line, "ETH 1 / WETH 8 / USDC 25000");
  } finally {
    server.close();
  }
});
