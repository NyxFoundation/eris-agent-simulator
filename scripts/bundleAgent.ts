// bundleAgent: 提出用 zip の生成（ADR 0015 §7）。
//   npm run bundle:agent <id> [-- --out <path>]
// runtime（汎用スクリプト）+ sdk + 共有 lib + 対象 agent ディレクトリを自己完結の zip に固める。
// コピー先では `npm install` → `node --import tsx agents/runtime/bot.ts`（env は環境が渡す）で動く。
// zip 内容の詳細（sdk の同梱範囲等）は本番コンペの提出仕様待ち（ADR 0015「決めていないこと」）。
// 現状は「そのまま実行可能な最小自己完結」= sdk 全体 + runtime + lib + agent 1 体を入れる。
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AGENTS_DIR = "example/agents";

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const id = args[0];
  if (!id || id.startsWith("--")) {
    console.error("usage: npm run bundle:agent <agent-id> [-- --out <path>]");
    process.exitCode = 1;
    return;
  }
  const outIdx = args.indexOf("--out");
  const outPath = resolve(
    outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : `bundle-${id}.zip`,
  );
  const agentDir = join(AGENTS_DIR, id);
  if (!existsSync(agentDir)) {
    console.error(`agent directory not found: ${agentDir}`);
    process.exitCode = 1;
    return;
  }

  const stage = mkdtempSync(join(tmpdir(), `eris-bundle-${id}-`));
  try {
    // agents/（runtime + lib + 対象 agent）と sdk/ を同梱する。
    cpSync(join(AGENTS_DIR, "runtime"), join(stage, "agents", "runtime"), {
      recursive: true,
    });
    if (existsSync(join(AGENTS_DIR, "lib")))
      cpSync(join(AGENTS_DIR, "lib"), join(stage, "agents", "lib"), {
        recursive: true,
      });
    cpSync(agentDir, join(stage, "agents", id), { recursive: true });
    cpSync("sdk", join(stage, "sdk"), { recursive: true });
    rmSync(join(stage, "sdk", "node_modules"), {
      recursive: true,
      force: true,
    });

    // 自己完結の package.json（@eris/sdk は同梱ディレクトリを file: 参照）。
    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify(
        {
          name: `eris-agent-${id}`,
          private: true,
          type: "module",
          description: `eris-competition 提出 bundle: ${id}（ADR 0015 §7）`,
          dependencies: {
            "@anthropic-ai/sdk": "^0.98.0",
            "@eris/sdk": "file:./sdk",
            viem: "^2.39.3",
            yaml: "^2.9.0",
            zod: "^4.4.3",
          },
          devDependencies: {
            tsx: "^4.20.6",
            typescript: "^5.9.3",
            "@types/node": "^24.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(stage, "README.md"),
      [
        `# eris agent bundle: ${id}`,
        "",
        "実行方法（環境が env — ERIS_RPC_URL / ERIS_AGENT_PRIVATE_KEY / ERIS_PRICE_FEED_ADDRESS 等 — を渡す）:",
        "",
        "```sh",
        "npm install",
        `ERIS_AGENT_DIR=agents/${id} node --import tsx agents/runtime/bot.ts`,
        "```",
        "",
      ].join("\n"),
    );

    mkdirSync(resolve(outPath, ".."), { recursive: true });
    rmSync(outPath, { force: true });
    execFileSync("zip", ["-qr", outPath, "."], { cwd: stage });
    console.error(`[bundle] wrote ${outPath}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
