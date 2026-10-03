import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRequest,
  formatUnits,
  nextSegmentStart,
  normalizeUsername,
  registrationEntry,
  sheetUsernames,
  tokenAddressFromConstants,
  tokyoDate,
} from "../src/lib.mjs";

const A = "0x2633DdCB442B0Ef8a782f3b8CdF4B226a39626bB";

test("usernames typed into the form resolve to the Discord handle", () => {
  assert.equal(normalizeUsername("tomoki_adachi"), "tomoki_adachi");
  assert.equal(normalizeUsername("  @Tomoki_Adachi "), "tomoki_adachi");
  assert.equal(normalizeUsername("＠tomoki_adachi"), "tomoki_adachi");
  assert.equal(normalizeUsername("masa.ascon#0"), "masa.ascon");
  assert.equal(normalizeUsername("old#1234"), "old");
  assert.equal(normalizeUsername("Display Name"), null);
  assert.equal(normalizeUsername(""), null);
  assert.equal(normalizeUsername(undefined), null);
});

test("the sheet admits the username column, optionally only approved rows", () => {
  const values = [
    ["タイムスタンプ", "Discord ユーザー名 / Discord username", "確認"],
    ["t1", "@Alice", "TRUE"],
    ["t2", "bob", "FALSE"],
    ["t3", "Carol Smith", "TRUE"],
    ["t4", "", "TRUE"],
  ];
  const all = sheetUsernames(values, { usernameHeader: "Discord ユーザー名 / Discord username" });
  assert.deepEqual([...all.admitted].sort(), ["alice", "bob"]);
  assert.deepEqual(all.unreadable, ["Carol Smith"]);

  const approved = sheetUsernames(values, {
    usernameHeader: "Discord ユーザー名 / Discord username",
    approvedHeader: "確認",
    approvedValue: "TRUE",
  });
  assert.deepEqual([...approved.admitted], ["alice"]);
});

test("a sheet without the configured column is an error, not an empty allowlist", () => {
  assert.throws(
    () => sheetUsernames([["name"]], { usernameHeader: "Discord ユーザー名 / Discord username" }),
    /no column/,
  );
  assert.throws(() => sheetUsernames([], { usernameHeader: "x" }), /no rows/);
});

test("one agent per Discord account, and no id or address twice", () => {
  const registered = [{ id: "taken", address: A }];
  const base = { userId: "u1", agentId: "mine", address: "0x" + "1".repeat(40), registered, claims: {} };
  assert.deepEqual(checkRequest(base), { ok: true });
  assert.equal(checkRequest({ ...base, claims: { u1: { agentId: "x" } } }).reason, "already-claimed");
  assert.equal(checkRequest({ ...base, agentId: "taken" }).reason, "agent-id-taken");
  assert.equal(checkRequest({ ...base, address: A.toLowerCase() }).reason, "address-taken");
  assert.equal(checkRequest({ ...base, agentId: "-bad" }).reason, "bad-agent-id");
  assert.equal(checkRequest({ ...base, agentId: "a b" }).reason, "bad-agent-id");
  assert.equal(checkRequest({ ...base, address: "0x123" }).reason, "bad-address");
  assert.equal(checkRequest({ ...base, address: "0x" + "0".repeat(40) }).reason, "bad-address");
});

test("the registration entry has register.sh's shape and no Discord name", () => {
  assert.equal(
    registrationEntry({ agentId: "shoheyhey53", address: A, date: "2026-10-03" }),
    `\n- id: shoheyhey53\n  address: "${A}"\n  description: registered 2026-10-03 via the faucet bot\n`,
  );
  assert.throws(() => registrationEntry({ agentId: "x\n- id: y", address: A, date: "d" }));
});

test("dates are Japan time, as register.sh stamps them", () => {
  assert.equal(tokyoDate(new Date("2026-10-02T15:30:00Z")), "2026-10-03");
});

test("token addresses come from constants.local.ts the way register.sh reads them", () => {
  const src = `type T = {\n    WETH: { address: Address; decimals: number };\n    USDC: { address: Address; decimals: number };\n    WBTC?: { address: Address; decimals: number };\n  };\nexport const TOKENS = {\n  WETH: {\n    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",\n  },\n  USDC: {\n    symbol: "USDC",\n    address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",\n  },\n};`;
  assert.equal(tokenAddressFromConstants(src, "WETH"), "0x5FbDB2315678afecb367f032d93F642f64180aa3");
  assert.equal(tokenAddressFromConstants(src, "USDC"), "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
  assert.equal(tokenAddressFromConstants(src, "WBTC"), null);
});

test("balances print the way register.sh prints them", () => {
  assert.equal(formatUnits(8n * 10n ** 18n, 18), "8");
  assert.equal(formatUnits(40_000_000n, 8), "0.4");
  assert.equal(formatUnits(25_000_000_000n, 6), "25000");
});

test("the next segment starts on the period's daily grid", () => {
  const period = "2026-09-28T09-13-09-294Z";
  // 2026-10-03 11:17 JST: the 10/2 segment is running, the next starts 10/3 09:13:09.294Z (18:13 JST).
  assert.equal(
    nextSegmentStart(period, 24, Date.parse("2026-10-03T02:17:00Z")).toISOString(),
    "2026-10-03T09:13:09.294Z",
  );
  assert.equal(nextSegmentStart("not-a-period", 24), null);
});
