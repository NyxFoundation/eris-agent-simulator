// ADR 0021 §2 / rules §2.7: registrations that arrive while the period is running. The file is
// re-read by the coordinator; what is pinned here is the pure half -- what the file may say, and
// which of its entries are new against a field that already exists. A restart is what this
// replaces, and a restart splits the standings, so the parser has to refuse loudly and the diff has
// to be idempotent (the same file is read again and again).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import {
  diffRegistrations,
  parseRegistrations,
  RegistrationsWatcher,
} from "../core/src/realtime/registrations.js";

const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";
const C: Address = "0x3333333333333333333333333333333333333333";

test("parses a bare YAML list, a roster-shaped mapping and JSON alike", () => {
  const yamlList = parseRegistrations(
    `- id: alice\n  address: "${A}"\n  participant: team-a\n- id: bob\n  address: "${B}"\n  description: late joiner\n`,
    "reg.yaml",
  );
  assert.deepEqual(yamlList, [
    { id: "alice", address: A, participant: "team-a" },
    { id: "bob", address: B, description: "late joiner" },
  ]);
  // A roster file can be reused verbatim: `external: true` is accepted, `agents:` is the list.
  const rosterShaped = parseRegistrations(
    `agents:\n  - id: alice\n    external: true\n    address: "${A}"\n`,
    "reg.yaml",
  );
  assert.deepEqual(rosterShaped, [{ id: "alice", address: A }]);
  const json = parseRegistrations(
    JSON.stringify({ registrations: [{ id: "c", address: C }] }),
    "reg.json",
  );
  assert.deepEqual(json, [{ id: "c", address: C }]);
  // The operator creates the file before the first participant: empty is an empty list.
  assert.deepEqual(parseRegistrations("", "reg.yaml"), []);
  assert.deepEqual(parseRegistrations("# nobody yet\n", "reg.yaml"), []);
});

test("refuses what a registration cannot say", () => {
  const cases: Array<[string, RegExp]> = [
    [`- id: ""\n  address: "${A}"`, /id must be a non-empty string/],
    [`- id: a\n  address: not-an-address`, /20-byte hex address/],
    [`- id: a`, /20-byte hex address/],
    // The environment never signs for a registration, so a wallet binding is a contradiction --
    // and so is anything that describes how to start a process (same refusal as the roster's).
    [
      `- id: a\n  address: "${A}"\n  wallet: AUTO`,
      /no meaning for a registration/,
    ],
    [
      `- id: a\n  address: "${A}"\n  command: node`,
      /no meaning for a registration/,
    ],
    [
      `- id: a\n  address: "${A}"\n  env: { K: v }`,
      /no meaning for a registration/,
    ],
    [`- id: a\n  address: "${A}"\n  external: false`, /external must be true/],
    [
      `- id: a\n  address: "${A}"\n  participant: ""`,
      /participant must be a non-empty string/,
    ],
    [
      `- id: a\n  address: "${A}"\n  description: 3`,
      /description must be a string/,
    ],
    [`registrations: 3`, /must be a list/],
    [`foo: bar`, /list of registrations/],
    [`42`, /list of registrations/],
  ];
  for (const [text, re] of cases)
    assert.throws(() => parseRegistrations(text, "reg.yaml"), re, text);
});

test("diff: new entries are added, known ones are a silent no-op, conflicts are named", () => {
  const known = {
    ids: new Set(["noop", "alice"]),
    // lowercase address -> owner id, the way the coordinator attributes txs
    addresses: new Map([
      ["0x9999999999999999999999999999999999999999", "noop"],
      [A.toLowerCase(), "alice"],
      ["0x8888888888888888888888888888888888888888", "oracle"],
    ]),
  };
  const { added, ignored } = diffRegistrations(
    [
      { id: "alice", address: B }, // same id, different address: not how an agent moves keys
      { id: "carol", address: A }, // address is alice's
      { id: "dave", address: "0x8888888888888888888888888888888888888888" }, // the oracle's
      { id: "erin", address: C }, // new
      { id: "erin", address: "0x4444444444444444444444444444444444444444" }, // dup id in file
      { id: "frank", address: C.toUpperCase().replace("0X", "0x") as Address }, // dup address in file
    ],
    known,
  );
  assert.deepEqual(added, [{ id: "erin", address: C }]);
  assert.deepEqual(
    ignored.map((i) => [i.id, i.reason]),
    [
      ["alice", 'id "alice" is already registered to a different address'],
      ["carol", 'address already belongs to "alice"'],
      ["dave", 'address already belongs to "oracle"'],
      ["erin", "duplicate within the registrations file"],
      ["frank", "duplicate within the registrations file"],
    ],
  );
});

test("diff is idempotent: once registered, the same file adds nothing", () => {
  const entries = [{ id: "erin", address: C }];
  const first = diffRegistrations(entries, {
    ids: new Set(),
    addresses: new Map(),
  });
  assert.equal(first.added.length, 1);
  const second = diffRegistrations(entries, {
    ids: new Set(["erin"]),
    addresses: new Map([[C.toLowerCase(), "erin"]]),
  });
  assert.deepEqual(second, { added: [], ignored: [] });
});

test("the watcher re-reads only when the file changed, and says when it is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "registrations-"));
  try {
    const path = join(dir, "registrations.yaml");
    const watcher = new RegistrationsWatcher(path);
    assert.deepEqual(watcher.read(), { kind: "missing" });

    writeFileSync(path, `- id: erin\n  address: "${C}"\n`);
    assert.deepEqual(watcher.read(), {
      kind: "changed",
      entries: [{ id: "erin", address: C }],
    });
    // Polled every few dozen blocks for weeks: the common case must be a stat and nothing else.
    assert.deepEqual(watcher.read(), { kind: "unchanged" });

    // An edit (mtime bumped, so a same-second rewrite is not mistaken for no change).
    writeFileSync(
      path,
      `- id: erin\n  address: "${C}"\n- id: bob\n  address: "${B}"\n`,
    );
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    const read = watcher.read();
    assert.equal(read.kind, "changed");
    if (read.kind === "changed") assert.equal(read.entries.length, 2);

    // A malformed file throws once per edit: the mtime is taken before the parse, so the next
    // poll sees "unchanged" rather than throwing the same error every thirty blocks.
    writeFileSync(path, `- id: a\n  wallet: AUTO\n`);
    const broken = new Date(Date.now() + 10_000);
    utimesSync(path, broken, broken);
    assert.throws(() => watcher.read(), /20-byte hex address|no meaning/);
    assert.deepEqual(watcher.read(), { kind: "unchanged" });

    rmSync(path);
    assert.deepEqual(watcher.read(), { kind: "missing" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run.registrationsFile reaches SimConfig from YAML", async () => {
  const { buildSource } = await import("../core/src/runConfig.js");
  const { loadConfig } = await import("../core/src/config.js");
  const source = buildSource({
    run: { registrationsFile: "config/registrations.yaml" },
  });
  assert.equal(source.ERIS_REGISTRATIONS_FILE, "config/registrations.yaml");
  assert.equal(
    loadConfig(source).registrationsFile,
    "config/registrations.yaml",
  );
  // Unset (or blank) is "the roster is the whole field", not an empty path to poll.
  assert.equal(
    loadConfig(buildSource({ run: { seed: 1 } })).registrationsFile,
    undefined,
  );
  assert.equal(
    loadConfig(buildSource({ run: { registrationsFile: "" } }))
      .registrationsFile,
    undefined,
  );
});
