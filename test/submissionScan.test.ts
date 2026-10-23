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

function scan(target: string, repo?: string): Report {
  const r = spawnSync(PY, [SCAN, target, "--json"], { encoding: "utf8", env: { ...process.env, ...(repo ? { ERIS_REPO: repo } : {}) } });
  assert.ok(r.status === 0 || r.status === 1, `scanner crashed: ${r.stderr}`);
  const report = JSON.parse(r.stdout) as Report;
  assert.equal(r.status, report.accept ? 0 : 1);
  return report;
}

function blocks(report: Report): string[] {
  return report.findings.filter((f) => f.severity === "BLOCK").map((f) => `${f.path}: ${f.message}`);
}

function fixtureDir(t: { after(fn: () => void): void }, files: Record<string, string | Buffer>): string {
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

test("a GitHub shorthand with a ref is a non-registry dependency", (t) => {
  // "user/repo" ended at $, so a ref after it matched nothing and the spec passed as if it named a
  // registry version. npm resolves these by talking to the host in the spec, which is an outbound
  // connection from the operator's builder to an address the participant chose.
  for (const spec of [
    "isaacs/nopt#v7.2.0",
    "user/repo#main",
    "user/repo#semver:^1",
    "workspace:*",
    "portal:../x",
  ]) {
    const dir = fixtureDir(t, {
      [`${AGENT}/package.json`]: JSON.stringify({ dependencies: { dep: spec } }),
    });
    assert.ok(
      blocks(scan(dir)).some((b) => b.includes("non-registry dependency")),
      `${spec} was not reported as non-registry`,
    );
  }
});

test("a registry range with a lock beside it is not called non-registry", (t) => {
  const dir = fixtureDir(t, {
    [`${AGENT}/package.json`]: JSON.stringify({ dependencies: { nopt: "^7.2.0" } }),
    [`${AGENT}/package-lock.json`]: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/nopt": {
          version: "7.2.0",
          resolved: "https://registry.npmjs.org/nopt/-/nopt-7.2.0.tgz",
          integrity: "sha512-x",
        },
      },
    }),
  });
  assert.deepEqual(blocks(scan(dir)), []);
});

test("a UTF-8 BOM does not make a hash-pinned requirements.txt look unpinned", (t) => {
  // The BOM was part of the first line, so the pinned form check saw "\ufeffsix==1.16.0" and
  // rejected it with a message that looked identical to the line it rejected. pip accepts a BOM.
  const pinned =
    "six==1.16.0 --hash=sha256:8abb2f1d86890a2dfb989f9a77cfcfd3e47c2a354b01111771326f8aa26e0254\n";
  const dir = fixtureDir(t, { [`${AGENT}/requirements.txt`]: `\ufeff${pinned}` });
  assert.deepEqual(blocks(scan(dir)), []);
});

// Rules §4.7.1: the persistent directory is the participant's, and reading back what the reference
// runtime saved there needs `fs`. The import alone used to be a BLOCK labelled "filesystem writes".
const writeWarns = (report: Report) =>
  report.findings.filter((f) => f.severity === "WARN" && /writes files/.test(f.message));

test("reading the persistent state directory with node:fs is not a finding", (t) => {
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: [
      `import { existsSync, readFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const path = join(process.env.ERIS_AGENT_STATE_DIR ?? "", "versions.json");`,
      `const memory = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).memory : null;`,
      AGENT_TS,
    ].join("\n"),
    [`${AGENT}/tune.ts`]: `const fs = require("fs");\nexport const raw = fs.readFileSync("x", "utf8");\n`,
  });
  const report = scan(dir);
  assert.deepEqual(blocks(report), []);
  assert.deepEqual(writeWarns(report), []);
});

test("writing files is a WARN for the operator, not a BLOCK", (t) => {
  const cases: Record<string, string> = {
    sync: `import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/x", "1");\n`,
    promises: `import { writeFile } from "node:fs/promises";\nawait writeFile("/tmp/x", "1");\n`,
    member: `import * as fs from "node:fs";\nfs.rm("/tmp/x", () => {});\n`,
    imported: `import { rm } from "node:fs/promises";\nawait rm("/tmp/x");\n`,
  };
  for (const [name, body] of Object.entries(cases)) {
    const dir = fixtureDir(t, { [`${AGENT}/agent.ts`]: body + AGENT_TS });
    const report = scan(dir);
    assert.deepEqual(blocks(report), [], name);
    assert.equal(writeWarns(report).length, 1, name);
  }
});

test("ordinary write()/link() calls that are not fs are not read as file writes", (t) => {
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: `process.stdout.write("x");\nconst link = (a: string) => a;\nlink("y");\n` + AGENT_TS,
  });
  assert.deepEqual(writeWarns(scan(dir)), []);
});

// The vendored sdk/runtime/lib are compared with this checkout, which moves with every operator
// update; extraction never copies them. A copy from another release is a WARN, not a rejection.
test("a vendored sdk file that differs from this checkout is a WARN, not a BLOCK", (t) => {
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    "sdk/src/constants.ts": "// an earlier release of this file\nexport const X = 1;\n",
    "agents/runtime/removed-in-a-later-release.ts": "export const Y = 2;\n",
  });
  const report = scan(dir);
  assert.deepEqual(blocks(report), []);
  const warns = report.findings.filter((f) => f.severity === "WARN").map((f) => f.path);
  assert.ok(warns.includes("sdk/src/constants.ts"), warns.join("\n"));
  assert.ok(warns.includes("agents/runtime/removed-in-a-later-release.ts"), warns.join("\n"));
});

test("a zip bomb is refused without being extracted", (t) => {
  // 60 MB of zeros deflates to ~60 KB: over the declared-size cap and the ratio cap. The size check
  // in walk_dir only runs on what was extracted, so its absence shows nothing was written.
  const dir = mkdtempSync(join(tmpdir(), "eris-scanbomb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "bomb.zip");
  const py = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("${AGENT}/agent.ts", "export function decide() { return []; }\\n")
    zf.writestr("${AGENT}/zeros.ts", b"\\0" * (60 * 1024 * 1024))
`;
  const r = spawnSync(PY, ["-c", py, out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const report = scan(out);
  assert.equal(report.accept, false);
  const found = blocks(report).join("\n");
  assert.match(found, /declared unpacked size/);
  assert.match(found, /zip bomb/);
  assert.doesNotMatch(found, /unpacked too large/, "walk_dir saw extracted files");
});

// Synthetic tokens only: exercise both submission formats without shipping real credentials.
const SECRET = "sk-" + "a".repeat(24);
const secretWarns = (report: Report) => report.findings.filter((f) =>
  f.severity === "WARN" && f.message === "looks like a hardcoded secret/key/token");
const secretNameWarns = (report: Report) => report.findings.filter((f) =>
  f.severity === "WARN" && f.message.startsWith("secret-material file name"));

for (const format of ["directory", "zip"] as const) {
  test(`secrets in non-code UTF-8 text WARN without rejecting a ${format}`, (t) => {
    const names = [".env", "notes.md", "notes.txt", "config.yaml", "config.yml", "config.toml",
      "config.ini", "config.cfg", "README", ".env.example", "agent.ts"];
    const files = Object.fromEntries(names.map((name) => [`${AGENT}/${name}`, `// ${SECRET}\n`]));
    const target = format === "directory" ? fixtureDir(t, files) : fixtureZip(t,
      Object.entries(files).map(([name, body]) => ({ name, body })));
    const report = scan(target); // scan() also asserts exit 0 when accept is true
    assert.equal(report.accept, true);
    assert.deepEqual(blocks(report), []);
    assert.deepEqual(secretWarns(report).map((f) => f.path).sort(), Object.keys(files).sort());
    assert.deepEqual(secretNameWarns(report).map((f) => f.path), [`${AGENT}/.env`]);
  });
}

test("secret-material names WARN once regardless of contents; env templates are exempt", (t) => {
  const names = [".env", ".env.local", ".env.production", "cert.pem", "signing.key",
    "id_rsa", "id_ed25519", "cert.p12", "cert.pfx"];
  const files: Record<string, string | Buffer> = { [`${AGENT}/agent.ts`]: AGENT_TS };
  for (const name of names) files[`${AGENT}/${name}`] = Buffer.from([0xff, 0]);
  for (const name of [".env.example", ".env.sample", ".env.template", "env", "key.txt"])
    files[`${AGENT}/${name}`] = "placeholder\n";
  const report = scan(fixtureDir(t, files));
  assert.equal(report.accept, true);
  assert.deepEqual(secretNameWarns(report).map((f) => f.path).sort(), names.map((n) => `${AGENT}/${n}`).sort());
  assert.deepEqual(secretWarns(report), []);
});

test("binary contents are not text-scanned even when they contain a token", (t) => {
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    [`${AGENT}/invalid.dat`]: Buffer.concat([Buffer.from(SECRET + " ".repeat(65536)), Buffer.from([0xff])]),
    [`${AGENT}/nul.dat`]: `${SECRET}${" ".repeat(65536)}\0`,
  });
  const report = scan(dir);
  assert.equal(report.accept, true);
  assert.deepEqual(secretWarns(report), []);
});

test("a secret split across text read boundaries still WARNs once", (t) => {
  const dir = fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    [`${AGENT}/notes.md`]: " ".repeat(65534) + SECRET + "\n" + SECRET,
  });
  const report = scan(dir);
  assert.equal(report.accept, true);
  assert.deepEqual(secretWarns(report).map((f) => f.path), [`${AGENT}/notes.md`]);
});


for (const format of ["directory", "zip"] as const) {
  test(`bundled operator copies keep their body-scan exemption in a ${format}`, (t) => {
    const body = `export const ID = "0x${"a".repeat(64)}";\n`;
    const refs = {
      "sdk/src/fixture.ts": body,
      "example/agents/runtime/fixture.ts": body,
      "example/agents/lib/fixture.md": body,
    };
    const repo = fixtureDir(t, refs);
    const files = {
      [`${AGENT}/agent.ts`]: AGENT_TS,
      "sdk/src/fixture.ts": body,
      "agents/runtime/fixture.ts": body,
      "agents/lib/fixture.md": body,
    };
    const target = format === "directory" ? fixtureDir(t, files) : fixtureZip(t,
      Object.entries(files).map(([name, body]) => ({ name, body })));
    assert.deepEqual(scan(target, repo).findings, []);
  });
}

test("forge artifact bytecode retains its INFO without a secret WARN", (t) => {
  const report = scan(fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    "out/Fixture.sol/Fixture.json": JSON.stringify({ bytecode: { object: "0x" + "ab".repeat(1000) } }),
  }));
  assert.deepEqual(report.findings, [{ severity: "INFO", path: "out/Fixture.sol/Fixture.json",
    message: "forge artifact, 1000 bytes of creation bytecode (deployment is permitted; issue #40)" }]);
});

test("node_modules bodies and binary extensions do not gain secret WARNs", (t) => {
  const report = scan(fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    "node_modules/dep/index.js": SECRET,
    "node_modules/dep/notes.md": SECRET,
    [`${AGENT}/payload.bin`]: SECRET,
  }));
  assert.deepEqual(secretWarns(report), []);
  assert.equal(report.blocks, 1);
  assert.deepEqual(report.findings.filter((f) => f.severity === "WARN").map((f) => f.path), ["node_modules/"]);
});

test("specialized file paths retain their existing scan without secret WARNs", (t) => {
  const report = scan(fixtureDir(t, {
    [`${AGENT}/agent.ts`]: AGENT_TS,
    [`${AGENT}/package.json`]: JSON.stringify({ description: SECRET }),
    [`${AGENT}/package-lock.json`]: lock({}),
    [`${AGENT}/requirements.txt`]: `# ${SECRET}\n`,
    [`${AGENT}/Fixture.sol`]: `// ${SECRET}\n`,
  }));
  assert.deepEqual(secretWarns(report), []);
  assert.deepEqual(blocks(report), []);
});

test("code retains the original secret WARN even with NUL or invalid UTF-8", (t) => {
  const files = {
    [`${AGENT}/agent.ts`]: Buffer.concat([Buffer.from(`// ${SECRET}\0`), Buffer.from([0xff])]),
  };
  assert.deepEqual(secretWarns(scan(fixtureDir(t, files))).map((f) => f.path), Object.keys(files));
});

test("vendored secret-material names still WARN, without scanning their bodies", (t) => {
  const report = scan(fixtureDir(t, { "sdk/fixture.key": SECRET, [`${AGENT}/agent.ts`]: AGENT_TS }));
  assert.deepEqual(secretNameWarns(report).map((f) => f.path), ["sdk/fixture.key"]);
  assert.deepEqual(secretWarns(report), []);
});
