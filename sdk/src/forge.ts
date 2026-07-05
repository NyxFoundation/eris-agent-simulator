// Shared reader for forge artifacts (out/<Name>.sol/<Name>.json).
// Unified so the environment's mock deploy (sdk/protocols/deploy.ts), the FlashArb demo (core), and
// participant contract deploy (example/agents/runtime/deploy.ts) all read the same way.
// The default out/ is the repo root (../../out from this file). Overridable via ERIS_FORGE_OUT
// (for cases where the layout changes, such as a submission bundle).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));

export function readForgeArtifact(
  name: string,
  outDir?: string,
): { abi: Abi; bytecode: Hex } {
  const dir =
    outDir ?? process.env.ERIS_FORGE_OUT ?? resolve(here, "../../out");
  const p = resolve(dir, `${name}.sol/${name}.json`);
  if (!existsSync(p)) {
    throw new Error(
      `forge artifact missing: ${p}. Run \`npm run build:contracts\` (or set ERIS_FORGE_OUT).`,
    );
  }
  const a = JSON.parse(readFileSync(p, "utf8"));
  return {
    abi: a.abi as Abi,
    bytecode: (a.bytecode?.object ?? a.bytecode) as Hex,
  };
}
