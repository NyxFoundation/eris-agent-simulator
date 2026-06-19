// dashboard サーバ（ADR 0008「server」）: 静的フロント配信 + SSE 状態 push。
//
// coordinator / agent とは完全に独立した第 3 のプロセス（観測者）。anvil を読むだけで
// tx は送らない（着順・fee 競争・採点に干渉しない）。runWatcher（ファイル tail）と
// valuePoller（RPC 断面）が DashboardState を更新 → 接続中の全ブラウザへ SSE で push する。
//
// 起動: npm run dashboard
// env: DASH_PORT(4317) / DASH_POLL_EVERY(2) / RUNS_DIR(runs) / RUN_DIR(明示指定) /
//      ANVIL_RPC_URL(anvil 本体 RPC。既定 http://127.0.0.1:8545。接続不可なら degrade)

import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRunWatcher } from "./runWatcher.js";
import { DashboardState } from "./state.js";
import { startValuePoller } from "./valuePoller.js";

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function intEnv(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // ディレクトリトラバーサル防止: public 配下に正規化
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type":
        CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function main(): void {
  const port = intEnv(process.env.DASH_PORT, 4317);
  const pollEvery = intEnv(process.env.DASH_POLL_EVERY, 2);
  const runsDir = process.env.RUNS_DIR ?? "runs";
  const runDir =
    process.env.RUN_DIR && process.env.RUN_DIR.trim() !== ""
      ? process.env.RUN_DIR.trim()
      : undefined;
  const rpcUrl = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";

  const state = new DashboardState();

  // ---- SSE クライアント管理 ----
  const clients = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  state.on("message", (msg: { event: string; data: unknown }) =>
    broadcast(msg.event, msg.data),
  );

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`retry: 2000\n\n`);
      res.write(
        `event: snapshot\ndata: ${JSON.stringify(state.snapshot())}\n\n`,
      );
      clients.add(res);
      const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients: clients.size }));
      return;
    }
    serveStatic(res, url);
  });

  startRunWatcher(state, {
    runsDir,
    runDir,
    onResolved: (dir) => console.error(`[dashboard] watching run dir: ${dir}`),
  });
  startValuePoller(state, { rpcUrl, pollEvery });

  server.listen(port, () => {
    console.error(
      `[dashboard] http://127.0.0.1:${port}  (runs=${runsDir}${
        runDir ? `, run=${runDir}` : " latest"
      }, anvil=${rpcUrl}, pollEvery=${pollEvery})`,
    );
  });
}

main();
