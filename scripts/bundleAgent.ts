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
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AGENTS_DIR = "example/agents";

// Contracts an agent deploys (issue #40 T6).
//
// A strategy may ship its own contracts, and the bundle has to carry the forge artifacts or the
// deployment throws at the first block with `forge artifact missing` -- on the operator's machine,
// mid-run, where nobody can fix it. Which artifacts is decided from the source rather than by
// copying `out/` wholesale: the whole of `out/` is every venue mock in the repository, and a
// submission is not entitled to ship those.
//
// The names are the string literals handed to the sdk's single artifact reader, in any of its three
// spellings. A name assembled at runtime is not found, which is the honest failure: the bundle
// cannot carry what the source does not name.
const ARTIFACT_REFERENCE =
  /\b(?:deployAction|readForgeArtifact|artifactAbi)\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g;

function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectSources(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".md")) out.push(p);
  }
  return out;
}

function artifactNamesFor(dirs: string[]): string[] {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of collectSources(dir)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(ARTIFACT_REFERENCE)) names.add(m[1]);
    }
  }
  return [...names].sort();
}

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

    // Forge artifacts for the contracts this agent deploys. They land in `out/`, which is exactly
    // where the sdk's reader looks by default (`../../out` from the bundled sdk), so nothing in the
    // runtime has to know the bundle exists.
    const wanted = artifactNamesFor([agentDir, join(AGENTS_DIR, "lib")]);
    const shipped: string[] = [];
    const missing: string[] = [];
    for (const name of wanted) {
      const src = join("out", `${name}.sol`, `${name}.json`);
      if (!existsSync(src)) {
        missing.push(name);
        continue;
      }
      mkdirSync(join(stage, "out", `${name}.sol`), { recursive: true });
      cpSync(src, join(stage, "out", `${name}.sol`, `${name}.json`));
      shipped.push(name);
    }
    // Named, not silent. A bundle that quietly lacks an artifact fails on the operator's machine at
    // the first block the strategy tries to deploy, and the message there says nothing about here.
    if (shipped.length > 0)
      console.error(`[bundle] artifacts: ${shipped.join(", ")}`);
    if (missing.length > 0)
      console.error(
        `[bundle] WARNING: no forge artifact for ${missing.join(", ")} — run \`npm run build:contracts\` ` +
          "first, or this bundle will fail at the first deployment it attempts",
      );

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
        "`out/` carries the forge artifacts for the contracts this agent deploys, if any. That is",
        "where the sdk's artifact reader looks; `ERIS_FORGE_OUT` overrides it.",
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
