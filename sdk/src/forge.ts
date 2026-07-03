// forge artifact（out/<Name>.sol/<Name>.json）の共有リーダー。
// 環境の mock deploy（sdk/protocols/deploy.ts）・FlashArb デモ（core）・参加者コントラクト
// deploy（example/agents/runtime/deploy.ts）が同じ読み方をするため 1 本化する。
// 既定の out/ は repo ルート（このファイルから ../../out）。ERIS_FORGE_OUT で上書き可
// （提出 bundle のようにレイアウトが変わる場合用）。
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
      `forge artifact missing: ${p}. Run \`npm run build:contracts\` (または ERIS_FORGE_OUT を指定).`,
    );
  }
  const a = JSON.parse(readFileSync(p, "utf8"));
  return {
    abi: a.abi as Abi,
    bytecode: (a.bytecode?.object ?? a.bytecode) as Hex,
  };
}
