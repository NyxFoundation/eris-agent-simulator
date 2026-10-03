// What infra/dashboard/sync-main.sh hands to `docker run`, and what it refuses to check out, read off
// the real script against a throwaway repository with a stub `docker` on PATH (no daemon needed).
//
// Both halves are load-bearing for issue #211. The build runs on the box that holds the period's
// role keys, the practice seed and the participant keys, so what the container can see is the whole
// point of running it in a container; and the pin is the other defence -- a ref that is not on
// origin/main, or one that predates this script, has to stop the tick rather than be checked out.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const SYNC = resolve("infra/dashboard/sync-main.sh");

// The files the build must never be able to read. Paths, not substrings: dashboard/.env.production.local
// is a documented input (the explorer URL vite compiles in), so a test that matched ".env" anywhere
// would call the one allowed case a leak.
const SECRETS = [
  ".env",
  ".env.local",
  ".env.practice",
  "infra/monitoring/.env",
  "keys/alice.key",
];

type Sandbox = {
  root: string;
  upstream: string;
  repo: string;
  bin: string;
  capture: string;
  listing: string;
  envFile: string;
  head: string;
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.email=sync@test",
      "-c",
      "user.name=sync test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      // A developer's global config (hooks, signing, a default branch) must not reach this.
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    },
  );
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(file: string, body: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

/**
 * An `upstream` with one commit carrying the real sync script, and a `box` cloned from it -- so
 * origin/main exists and `git fetch origin main` works without a network. The box then gets what a
 * hosted box has and a build must not: the env files, a keys directory, and the node_modules the
 * build mounts or copies.
 */
function sandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "eris-dash-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const upstream = join(root, "upstream");
  mkdirSync(join(upstream, "infra", "dashboard"), { recursive: true });
  copyFileSync(SYNC, join(upstream, "infra", "dashboard", "sync-main.sh"));
  write(join(upstream, "dashboard", "index.html"), "<html>tracked</html>");
  write(join(upstream, "package.json"), '{ "name": "sandbox" }\n');
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "sandbox at the pinned sync");

  const repo = join(root, "box");
  const cloned = spawnSync("git", ["clone", "-q", upstream, repo], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  assert.equal(cloned.status, 0, cloned.stderr);

  for (const s of SECRETS) write(join(repo, s), `secret ${s}\n`);
  // The one untracked file the build is allowed to see (infra/dashboard/README.md, "Explorer links").
  write(
    join(repo, "dashboard", ".env.production.local"),
    "VITE_BLOCKSCOUT_URL=https://explorer.example\n",
  );
  for (const nm of [
    "node_modules",
    "core/node_modules",
    "sdk/node_modules",
    "dashboard/node_modules",
  ]) {
    write(join(repo, nm, "marker"), nm);
  }

  const bin = join(root, "bin");
  mkdirSync(bin);
  const capture = join(root, "docker-run.json");
  const listing = join(root, "export-listing.json");
  // Records the `docker run` argv and everything the container would have been able to read under
  // /build, then does the one thing the real build does that the script checks for: produce
  // dashboard/dist/index.html inside the export.
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const a = process.argv.slice(2);
if (a[0] === "version") { process.stdout.write("stub\\n"); process.exit(0); }
if (a[0] !== "run") process.exit(0);
fs.writeFileSync(process.env.ERIS_TEST_CAPTURE, JSON.stringify(a));
let work = null;
for (let i = 0; i < a.length - 1; i++) {
  if (a[i] === "-v" && a[i + 1].split(":")[1] === "/build") work = a[i + 1].split(":")[0];
}
if (!work) process.exit(3);
const seen = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else seen.push(r);
  }
})(work, "");
fs.writeFileSync(process.env.ERIS_TEST_LISTING, JSON.stringify(seen));
fs.mkdirSync(path.join(work, "dashboard", "dist"), { recursive: true });
fs.writeFileSync(path.join(work, "dashboard", "dist", "index.html"), "<html>built</html>");
`,
  );
  chmodSync(join(bin, "docker"), 0o700);

  const envFile = join(root, "sync.env");
  writeFileSync(envFile, "# empty: every test passes its mode in the environment\n");
  mkdirSync(join(root, "tmp"));

  return {
    root,
    upstream,
    repo,
    bin,
    capture,
    listing,
    envFile,
    head: git(repo, "rev-parse", "HEAD"),
  };
}

function tick(
  ctx: Sandbox,
  env: Record<string, string>,
): { status: number | null; out: string } {
  const r = spawnSync("bash", [SYNC], {
    // Built, not inherited: an ERIS_SYNC_* in the developer's shell would change the mode under test.
    env: {
      PATH: ctx.bin + delimiter + (process.env.PATH ?? ""),
      HOME: ctx.root,
      TMPDIR: join(ctx.root, "tmp"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ERIS_TEST_CAPTURE: ctx.capture,
      ERIS_TEST_LISTING: ctx.listing,
      ERIS_REPO: ctx.repo,
      ERIS_SYNC_ENV_FILE: ctx.envFile,
      ...env,
    },
    timeout: 60_000,
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("the build container gets the commit and node_modules, and no env file or key", (t) => {
  const ctx = sandbox(t);
  const { status, out } = tick(ctx, { ERIS_SYNC_REF: ctx.head });
  assert.equal(status, 0, out);

  const argv = JSON.parse(readFileSync(ctx.capture, "utf8")) as string[];
  const mounts: { source: string; target: string; readOnly: boolean }[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-v") continue;
    const [source, target, mode] = argv[i + 1].split(":");
    mounts.push({ source, target, readOnly: mode === "ro" });
  }

  // Nothing secret is named anywhere in the argv -- not as a mount, not as an -e value.
  for (const s of SECRETS) {
    const path = join(ctx.repo, s);
    assert.ok(
      !argv.some((a) => a.includes(path)),
      `${s} reached the docker argv: ${argv.join(" ")}`,
    );
  }
  // And the checkout itself is not mounted: what the build sees is the export, under TMPDIR.
  assert.ok(!mounts.some((m) => m.source === ctx.repo), JSON.stringify(mounts));
  const build = mounts.find((m) => m.target === "/build");
  assert.ok(build, JSON.stringify(mounts));
  assert.equal(build.readOnly, false);
  assert.ok(build.source.startsWith(join(ctx.root, "tmp")), build.source);
  // Everything else is a node_modules, read-only.
  for (const m of mounts) {
    if (m.target === "/build") continue;
    assert.match(m.target, /^\/build\/(|core\/|sdk\/)node_modules$/);
    assert.equal(m.source, join(ctx.repo, m.target.slice("/build/".length)));
    assert.ok(m.readOnly, m.target);
  }
  assert.equal(mounts.length, 4, JSON.stringify(mounts));

  // The hardening the README promises, each of which the container would otherwise not have.
  for (const flag of [
    "--network",
    "none",
    "--read-only",
    "--user",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--pids-limit",
  ]) {
    assert.ok(argv.includes(flag), `${flag} missing: ${argv.join(" ")}`);
  }

  // What was actually readable under /build, listed by the stub before it "built". `git archive`
  // carries tracked files only, so the env files and the keys cannot be there however the mounts
  // are written.
  const seen = JSON.parse(readFileSync(ctx.listing, "utf8")) as string[];
  for (const s of SECRETS) assert.ok(!seen.includes(s), `${s} is in the export`);
  assert.ok(seen.includes("dashboard/index.html"), seen.join(" "));
  // dashboard/node_modules is copied in, because `vite build` writes the bundled config into it.
  assert.ok(seen.includes("dashboard/node_modules/marker"), seen.join(" "));
  // The documented exception, and the only untracked file in there.
  assert.ok(seen.includes("dashboard/.env.production.local"), seen.join(" "));

  // dist is swapped in, and says which commit it is -- the stamp the next tick compares against and
  // the build info /healthz reports (dashboard/server/serve.ts).
  const dist = join(ctx.repo, "dashboard", "dist");
  assert.match(readFileSync(join(dist, "index.html"), "utf8"), /built/);
  assert.equal(readFileSync(join(dist, ".built-at"), "utf8").trim(), ctx.head);
  const info = JSON.parse(readFileSync(join(dist, ".build-info.json"), "utf8")) as {
    commit: string;
    builtAt: string;
  };
  assert.equal(info.commit, ctx.head);
  assert.match(info.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // A second tick at the same commit does not rebuild: the bundle is content-hashed.
  rmSync(ctx.capture);
  const again = tick(ctx, { ERIS_SYNC_REF: ctx.head });
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /nothing to build/);
  assert.ok(!existsSync(ctx.capture), "docker run was reached a second time");
});

test("a pin that is not an ancestor of origin/main is refused", (t) => {
  const ctx = sandbox(t);
  // A commit that exists on the box and nowhere else -- what a push to the box, or a local fix
  // somebody committed to get the tree clean, leaves behind.
  write(join(ctx.repo, "dashboard", "index.html"), "<html>local only</html>");
  git(ctx.repo, "add", "-A");
  git(ctx.repo, "commit", "-qm", "never went through main");
  const local = git(ctx.repo, "rev-parse", "HEAD");

  const { status, out } = tick(ctx, { ERIS_SYNC_REF: local });
  assert.equal(status, 1, out);
  assert.match(out, /REFUSED/);
  assert.match(out, /not an ancestor of origin\/main/);
  assert.ok(!existsSync(ctx.capture), "the build ran anyway");
});

test("a pin whose sync-main.sh predates #211 is refused, because the timer runs it", (t) => {
  const ctx = sandbox(t);
  // The shape of the hazard: a commit on main whose script is the following one. Pinning it would
  // put that script back on the timer, and its next tick would undo the pin.
  write(
    join(ctx.upstream, "infra", "dashboard", "sync-main.sh"),
    "#!/usr/bin/env bash\ngit pull --ff-only origin main\nnpm run dashboard:build\n",
  );
  git(ctx.upstream, "add", "-A");
  git(ctx.upstream, "commit", "-qm", "the pre-pin sync");
  const old = git(ctx.upstream, "rev-parse", "HEAD");

  const { status, out } = tick(ctx, { ERIS_SYNC_REF: old });
  assert.equal(status, 1, out);
  assert.match(out, /REFUSED/);
  assert.match(out, /predates the pinned sync/);
  assert.ok(!existsSync(ctx.capture), "the build ran anyway");
});

test("a pin is verified by reading the script, not by racing a pipe", (t) => {
  const ctx = sandbox(t);
  // The check is "does this commit's sync-main.sh know about ERIS_SYNC_REF", and it used to be
  // `git show … | grep -q`. Under `pipefail` that pipeline reports the status of a `git show` that
  // took SIGPIPE when grep matched early and exited, so a commit that carries the pin was refused as
  // one that predates it -- intermittently at this file's size, every time once the blob is well
  // past the pipe buffer. The padding below is what makes the regression deterministic.
  const real = readFileSync(SYNC, "utf8");
  write(
    join(ctx.upstream, "infra", "dashboard", "sync-main.sh"),
    `${real}\n${"# padding so the blob does not fit in one pipe buffer\n".repeat(4000)}`,
  );
  git(ctx.upstream, "add", "-A");
  git(ctx.upstream, "commit", "-qm", "a sync script past the pipe buffer");
  const padded = git(ctx.upstream, "rev-parse", "HEAD");

  const { status, out } = tick(ctx, { ERIS_SYNC_REF: padded });
  assert.equal(status, 0, out);
  assert.ok(!/REFUSED/.test(out), out);
  assert.equal(git(ctx.repo, "rev-parse", "HEAD"), padded);
  assert.ok(existsSync(ctx.capture), "the build was not reached");
});

test("a ref that is neither a sha nor a tag is refused, and says what following one would be", (t) => {
  const ctx = sandbox(t);
  // A branch name resolves, and would quietly turn "pinned" into "following" under the wrong log
  // line, so it is not accepted as a pin at all.
  const branch = tick(ctx, { ERIS_SYNC_REF: "main" });
  assert.equal(branch.status, 1, branch.out);
  assert.match(branch.out, /cannot resolve 'main'/);
  assert.match(branch.out, /ERIS_SYNC_FOLLOW_BRANCH=main/);

  const missing = tick(ctx, { ERIS_SYNC_REF: "v2026.99.99" });
  assert.equal(missing.status, 1, missing.out);
  assert.match(missing.out, /cannot resolve 'v2026.99.99'/);
  assert.ok(!existsSync(ctx.capture), "the build ran anyway");
});

test("a pin and a followed branch together are refused before anything is fetched", (t) => {
  const ctx = sandbox(t);
  const { status, out } = tick(ctx, {
    ERIS_SYNC_REF: ctx.head,
    ERIS_SYNC_FOLLOW_BRANCH: "main",
  });
  assert.equal(status, 1, out);
  assert.match(out, /pick one/);
  assert.ok(!existsSync(ctx.capture), "the build ran anyway");
});

test("a build is refused outright when dashboard/node_modules is missing", (t) => {
  const ctx = sandbox(t);
  rmSync(join(ctx.repo, "dashboard", "node_modules"), { recursive: true });
  const { status, out } = tick(ctx, { ERIS_SYNC_REF: ctx.head });
  assert.equal(status, 1, out);
  assert.match(out, /dashboard\/node_modules is missing/);
  assert.ok(!existsSync(ctx.capture), "the build ran anyway");
  // dist is left alone rather than emptied by a build that could not be done.
  assert.ok(!existsSync(join(ctx.repo, "dashboard", "dist")));
});
