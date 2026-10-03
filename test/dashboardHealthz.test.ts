// Issue #159: the hosted dashboard had nothing to probe. Every unknown path is the SPA fallback --
// 200 with index.html -- so a probe of any URL proved only that node was running. /healthz answers for
// the server itself and for the one thing every page needs, a listable runs/ directory.
//
// It also reports which commit is being served (issue #211). The sync builds the bundle and swaps
// dist/ under a running server, so a forgotten `promote`, a sync that stopped days ago, and a box
// that is up to date all used to answer the same `{"ok":true}`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVE = join(
  import.meta.dirname,
  "..",
  "dashboard",
  "server",
  "serve.ts",
);

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function withServer(
  runsDir: string,
  dist: string,
  port: number,
  fn: (base: string) => Promise<void>,
) {
  const child = spawn(process.execPath, ["--import", "tsx", SERVE], {
    env: {
      ...process.env,
      ERIS_DASHBOARD_DIST: dist,
      ERIS_RUNS_DIR: runsDir,
      PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    // serve.ts logs to stderr once it is listening
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("dashboard server did not start")),
        15_000,
      );
      child.stderr.on("data", (c: Buffer) => {
        if (c.toString().includes("serving")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) =>
        reject(new Error(`dashboard server exited (${code})`)),
      );
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

test("/healthz is 200 with a listable runs/ and 503 without, and is not the SPA fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "eris-healthz-"));
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<html></html>");
  mkdirSync(join(root, "runs"));
  try {
    await withServer(
      join(root, "runs"),
      dist,
      await freePort(),
      async (base) => {
        const ok = await fetch(`${base}/healthz`);
        assert.equal(ok.status, 200);
        const body = (await ok.json()) as Record<string, unknown>;
        assert.equal(body.ok, true);
        // A dist nobody's sync built: null rather than a guess, and no build "since" a start that
        // has nothing to compare against.
        assert.equal(body.commit, null);
        assert.equal(body.builtAt, null);
        assert.equal(body.serverCommit, null);
        assert.equal(body.builtSinceStart, false);
        assert.match(String(body.serverStartedAt), /^\d{4}-\d{2}-\d{2}T/);
        // any other path is still the SPA
        const spa = await fetch(`${base}/standings`);
        assert.equal(spa.status, 200);
        assert.match(await spa.text(), /<html>/);
      },
    );
    await withServer(
      join(root, "missing"),
      dist,
      await freePort(),
      async (base) => {
        const down = await fetch(`${base}/healthz`);
        assert.equal(down.status, 503);
        assert.equal(((await down.json()) as { ok: boolean }).ok, false);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/healthz names the commit in dist, and says when a build landed under it", async () => {
  const root = mkdtempSync(join(tmpdir(), "eris-healthz-commit-"));
  const dist = join(root, "dist");
  mkdirSync(dist);
  mkdirSync(join(root, "runs"));
  writeFileSync(join(dist, "index.html"), "<html></html>");
  // What infra/dashboard/sync-main.sh writes on every build, inside the directory it describes.
  const info = (commit: string, builtAt: string) =>
    writeFileSync(
      join(dist, ".build-info.json"),
      JSON.stringify({ commit, builtAt }),
    );
  info("a".repeat(40), "2026-10-03T01:02:03Z");
  try {
    await withServer(
      join(root, "runs"),
      dist,
      await freePort(),
      async (base) => {
        const first = (await (await fetch(`${base}/healthz`)).json()) as Record<
          string,
          unknown
        >;
        assert.equal(first.commit, "a".repeat(40));
        assert.equal(first.builtAt, "2026-10-03T01:02:03Z");
        assert.equal(first.serverCommit, "a".repeat(40));
        assert.equal(first.builtSinceStart, false);

        // A promotion lands: the sync replaces dist/ while this process keeps running, so the bundle
        // moves and dashboard/server/*.ts -- compiled at startup -- does not.
        info("b".repeat(40), "2026-10-03T04:05:06Z");
        const second = (await (await fetch(`${base}/healthz`)).json()) as Record<
          string,
          unknown
        >;
        assert.equal(second.commit, "b".repeat(40));
        assert.equal(second.serverCommit, "a".repeat(40));
        assert.equal(second.builtSinceStart, true);
        // `ok` is what ascon_dashboard_down alerts on, and a stale bundle is not an outage.
        assert.equal(second.ok, true);

        // The same two fields as a static file, for a check that does not want to parse /healthz.
        const file = await fetch(`${base}/.build-info.json`);
        assert.equal(file.status, 200);
        assert.equal(
          ((await file.json()) as { commit: string }).commit,
          "b".repeat(40),
        );

        // A dist from before .build-info.json existed: .built-at holds the commit alone.
        rmSync(join(dist, ".build-info.json"));
        writeFileSync(join(dist, ".built-at"), `${"c".repeat(40)}\n`);
        const legacy = (await (await fetch(`${base}/healthz`)).json()) as Record<
          string,
          unknown
        >;
        assert.equal(legacy.commit, "c".repeat(40));
        assert.equal(legacy.builtAt, null);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
