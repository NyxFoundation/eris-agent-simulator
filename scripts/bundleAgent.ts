// bundleAgent: generate the submission zip (ADR 0015 §7).
//   npm run bundle:agent <id> [-- --out <path>]
// Packs the runtime (generic scripts) + sdk + shared lib + target agent directory into a self-contained zip.
// At the destination it runs via `npm install` -> `node --import tsx agents/runtime/bot.ts` (the environment passes the env).
// The exact zip contents (how much of the sdk to bundle, etc.) await the production competition's submission spec (ADR 0015 "open questions").
// For now it is the "minimal self-contained, directly runnable" set = the entire sdk + runtime + lib + one agent.
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
    // Bundle agents/ (runtime + lib + target agent) and sdk/.
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

    // Self-contained package.json (@eris/sdk references the bundled directory via file:).
    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify(
        {
          name: `eris-agent-${id}`,
          private: true,
          type: "module",
          description: `eris-competition submission bundle: ${id} (ADR 0015 §7)`,
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
        "How to run (the environment passes the env — ERIS_RPC_URL / ERIS_AGENT_PRIVATE_KEY / ERIS_PRICE_FEED_ADDRESS, etc.):",
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
