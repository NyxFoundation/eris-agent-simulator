// Regression tests for infra/submission/scan-submission.py (PR #200 review). The scanner is the
// only gate between a participant's ZIP and a networked image build, so each hole it was found to
// have gets a fixture here: symlinks the two zip readers disagree on, npm-shrinkwrap.json (which
// `npm ci` prefers over the scanned package-lock.json), v1 locks and lock entries with no
// registry `resolved` / `integrity`, and dependency specs the registry regex missed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const PY = process.env.ERIS_PYTHON || "python3";
const SCAN = "infra/submission/scan-submission.py";
const AGENT = "agents/team-x"; // not the bundle root: a package.json there is a team manifest

interface Finding { severity: string; path: string; message: string }
interface Report { accept: boolean; blocks: number; findings: Finding[] }

function scan(target: string): Report {
  const r = spawnSync(PY, [SCAN, target, "--json"], { encoding: "utf8" });
  assert.ok(r.status === 0 || r.status === 1, `scanner crashed: ${r.stderr}`);
  const report = JSON.parse(r.stdout) as Report;
  assert.equal(r.status, report.accept ? 0 : 1);
  return report;
}

function blocks(report: Report): string[] {
  return report.findings.filter((f) => f.severity === "BLOCK").map((f) => `${f.path}: ${f.message}`);
}

function fixtureDir(t: { after(fn: () => void): void }, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

/** Write a zip with Python's zipfile so symlink entries carry real S_IFLNK mode bits. */
function fixtureZip(t: { after(fn: () => void): void },
  entries: Array<{ name: string; body?: string; symlink?: string; dir?: boolean }>): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-scanzip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "bundle.zip");
  const py = `
import json, sys, zipfile, stat
out, entries = sys.argv[1], json.loads(sys.argv[2])
with zipfile.ZipFile(out, "w") as zf:
    for e in entries:
        zi = zipfile.ZipInfo(e["name"])
        if e.get("symlink") is not None:
            zi.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(zi, e["symlink"])
        elif e.get("dir"):
            zi.external_attr = (stat.S_IFDIR | 0o755) << 16
            zf.writestr(zi, "")
        else:
            zi.external_attr = (stat.S_IFREG | 0o644) << 16
            zf.writestr(zi, e.get("body", ""))
`;
  const r = spawnSync(PY, ["-c", py, out, JSON.stringify(entries)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

const AGENT_TS = "export function decide() { return []; }\n";
const PKG = JSON.stringify({ name: "team-x", private: true, dependencies: { lodash: "4.17.21" } });
const lock = (packages: Record<string, unknown>, lockfileVersion: number = 3) =>
  JSON.stringify({ name: "team-x", lockfileVersion, requires: true, packages: { "": { name: "team-x" }, ...packages } });
const LODASH = {
  version: "4.17.21",
  resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  integrity: "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==",
};

test("clean agent with registry-pinned lock and hashed requirements is accepted", (t) => {
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    [`${AGENT}/package.json`]: PKG,
    [`${AGENT}/package-lock.json`]: lock({ "node_modules/lodash": LODASH }),
    [`${AGENT}/requirements.txt`]: `six==1.16.0 --hash=sha256:${"a".repeat(64)}\n`,
  });
  const report = scan(dir);
  assert.deepEqual(blocks(report), []);
  assert.equal(report.accept, true);
});

test("the same clean agent is accepted as a zip", (t) => {
  const zip = fixtureZip(t, [
    { name: `${AGENT}/`, dir: true },
    { name: `${AGENT}/agent.ts`, body: AGENT_TS },
    { name: `${AGENT}/package.json`, body: PKG },
    { name: `${AGENT}/package-lock.json`, body: lock({ "node_modules/lodash": LODASH }) },
  ]);
  assert.deepEqual(blocks(scan(zip)), []);
});

test("symlink entries in a zip (file and directory) are blocked", (t) => {
  const zip = fixtureZip(t, [
    { name: `${AGENT}/agent.ts`, body: AGENT_TS },
    { name: `${AGENT}/stolen`, symlink: "../team-victim" },
    { name: `${AGENT}/peek.ts`, symlink: "/etc/passwd" },
  ]);
  const b = blocks(scan(zip));
  assert.ok(b.some((m) => m.startsWith(`${AGENT}/stolen:`) && m.includes("symlink")), b.join("\n"));
  assert.ok(b.some((m) => m.startsWith(`${AGENT}/peek.ts:`) && m.includes("symlink")), b.join("\n"));
});

test("symlinked file and directory in a directory submission are blocked, not followed", (t) => {
  const victim = fixtureDir(t, { "agent.ts": "// victim strategy\n" });
  const dir = fixtureDir(t, { [`${AGENT}/agent.ts`]: AGENT_TS });
  symlinkSync(victim, join(dir, AGENT, "stolen"));
  symlinkSync(join(victim, "agent.ts"), join(dir, AGENT, "copy.ts"));
  const b = blocks(scan(dir));
  assert.ok(b.some((m) => m.startsWith(`${AGENT}/stolen:`)), b.join("\n"));
  assert.ok(b.some((m) => m.startsWith(`${AGENT}/copy.ts:`)), b.join("\n"));
});

test("npm-shrinkwrap.json is blocked even beside a clean package-lock.json", (t) => {
  const evil = lock({ "node_modules/lodash": { version: "1.0.0", resolved: "http://10.0.0.5/x.tgz" } });
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    [`${AGENT}/package.json`]: PKG,
    [`${AGENT}/package-lock.json`]: lock({ "node_modules/lodash": LODASH }),
    [`${AGENT}/npm-shrinkwrap.json`]: evil,
  });
  const b = blocks(scan(dir));
  assert.equal(b.length, 1, b.join("\n"));
  assert.match(b[0], /npm-shrinkwrap\.json/);
});

test("a v1 lock (dependencies tree, no packages map) is blocked", (t) => {
  const v1 = JSON.stringify({
    name: "team-x", lockfileVersion: 1, requires: true,
    dependencies: { evil: { version: "git+https://example.com/evil.git#abc", from: "git+https://example.com/evil.git" } },
  });
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    [`${AGENT}/package.json`]: PKG,
    [`${AGENT}/package-lock.json`]: v1,
  });
  const b = blocks(scan(dir));
  assert.ok(b.some((m) => /lockfileVersion 1/.test(m)), b.join("\n"));
});

test("lock entries without resolved, without integrity, or resolving to git/URL are blocked", (t) => {
  const { integrity: _i, ...noIntegrity } = LODASH;
  const { resolved: _r, ...noResolved } = LODASH;
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    [`${AGENT}/package.json`]: PKG,
    [`${AGENT}/package-lock.json`]: lock({
      "node_modules/a": noResolved,
      "node_modules/b": noIntegrity,
      "node_modules/c": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/c.git#deadbeef", integrity: "sha512-x" },
      "node_modules/d": { version: "1.0.0", resolved: "http://10.0.0.5/d.tgz", integrity: "sha512-x" },
      "node_modules/e": { ...LODASH, inBundle: true },
      "node_modules/f": { resolved: "../f", link: true },
    }),
  });
  const b = blocks(scan(dir));
  const about = (n: string) => b.filter((m) => m.includes(`'node_modules/${n}'`));
  assert.equal(about("a").length, 1, "missing resolved");
  assert.match(about("b")[0] ?? "", /integrity/);
  assert.equal(about("c").length, 1, "git resolved");
  assert.equal(about("d").length, 1, "URL resolved");
  assert.equal(about("e").length, 0, "inBundle ships inside an integrity-checked parent");
  assert.match(about("f")[0] ?? "", /local link/);
});

test("non-registry dependency specs in a team package.json are blocked (incl. bitbucket:)", (t) => {
  const specs = ["bitbucket:user/repo", "gist:abc123", "github:user/repo", "git+https://x/y.git", "user/repo", "file:../x"];
  for (const spec of specs) {
    const dir = fixtureDir(t, {
      [`${AGENT}/agent.ts`]: AGENT_TS,
      [`${AGENT}/package.json`]: JSON.stringify({ name: "team-x", dependencies: { dep: spec } }),
      [`${AGENT}/package-lock.json`]: lock({}),
    });
    const b = blocks(scan(dir));
    assert.ok(b.some((m) => m.includes(`non-registry dependency 'dep': ${spec}`)), `${spec}: ${b.join("\n")}`);
  }
});

test("requirements.txt accepts only hash-pinned registry lines", (t) => {
  const ok = `six==1.16.0 --hash=sha256:${"a".repeat(64)}`;
  for (const [line, accepted] of [
    [ok, true],
    ["six==1.16.0", false],
    ["six>=1.0 --hash=sha256:" + "a".repeat(64), false],
    ["--index-url http://10.0.0.5/simple", false],
    ["git+https://example.com/x.git", false],
  ] as const) {
    const dir = fixtureDir(t, { [`${AGENT}/agent.ts`]: AGENT_TS, [`${AGENT}/requirements.txt`]: line + "\n" });
    assert.equal(blocks(scan(dir)).length === 0, accepted, line);
  }
});
