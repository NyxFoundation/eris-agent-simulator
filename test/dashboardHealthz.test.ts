// Issue #159: the hosted dashboard had nothing to probe. Every unknown path is the SPA fallback --
// 200 with index.html -- so a probe of any URL proved only that node was running. /healthz answers for
// the server itself and for the one thing every page needs, a listable runs/ directory.
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
        assert.deepEqual(await ok.json(), { ok: true });
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
        assert.deepEqual(await down.json(), { ok: false });
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
