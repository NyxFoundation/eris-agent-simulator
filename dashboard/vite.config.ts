import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const RUNS_DIR = fileURLToPath(new URL("../runs", import.meta.url));

/**
 * Serves the sibling runs/ directory (same repo, relative path — issue #63):
 *   /runs/index.json      -> run dirs that contain a summary.json, newest first
 *   /runs/<id>/<artifact> -> the artifact file itself
 * Dev-server only: the dashboard is a local viewer over local run output.
 */
function runsPlugin(): Plugin {
  return {
    name: "eris-runs",
    configureServer(server) {
      server.middlewares.use("/runs", (req, res, next) => {
        const url = (req.url ?? "/").split("?")[0];

        if (url === "/index.json") {
          let entries: { id: string; mtimeMs: number }[] = [];
          try {
            entries = fs
              .readdirSync(RUNS_DIR, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .flatMap((d) => {
                try {
                  const stat = fs.statSync(
                    path.join(RUNS_DIR, d.name, "summary.json"),
                  );
                  return [{ id: d.name, mtimeMs: stat.mtimeMs }];
                } catch {
                  return [];
                }
              })
              .sort((a, b) => b.mtimeMs - a.mtimeMs);
          } catch {
            // no runs/ directory yet — an empty index is the honest answer
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(entries));
          return;
        }

        const rel = decodeURIComponent(url.replace(/^\//, ""));
        const file = path.resolve(RUNS_DIR, rel);
        if (
          rel.includes("\0") ||
          !file.startsWith(path.resolve(RUNS_DIR) + path.sep)
        ) {
          res.statusCode = 403;
          res.end();
          return;
        }
        fs.stat(file, (err, stat) => {
          if (err || !stat.isFile()) {
            next();
            return;
          }
          res.setHeader(
            "content-type",
            file.endsWith(".json")
              ? "application/json"
              : "text/plain; charset=utf-8",
          );
          fs.createReadStream(file).pipe(res);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), runsPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Local Blockscout explorer (npm run explorer, :3100). Proxying keeps the
      // availability probe same-origin; when the explorer is down the proxied
      // request fails and the dashboard silently drops its deep links.
      "/blockscout": {
        target: "http://localhost:3100",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/blockscout/, ""),
      },
    },
  },
});
