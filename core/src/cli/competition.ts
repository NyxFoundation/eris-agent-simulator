// The competition schedule: commitments and the plan (rules §3.3, §7.1, §7.2; ADR 0023).
//
//   npm run competition -- commit <file.yaml>
//       print the commitment (sha256 over canonical JSON) of a hidden-set or lottery-seed file.
//       Publish this before the file is used (§7.1); publish the file itself after the results (§7.2).
//
//   npm run competition -- plan --hidden <hidden.yaml> --lottery <lottery.yaml> --k <N> [--out plan.yaml]
//       derive the k epochs (regime, seed, ordinal) and write a plan that `npm run backtest --
//       --scenarios plan.yaml` replays in order. Also prints both commitments so the plan can be
//       checked against what was published.
//
// File shapes (YAML or JSON):
//   hidden set    { regimes: { calm: [..seeds..], crash: [...], ... }, salt?: "<random>" }
//   lottery seed  { lotterySeed: "<secret string>", salt?: "<random>" }
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildPlan,
  commitmentOf,
  type HiddenSet,
  type LotterySeed,
} from "../competition/schedule.js";
import { parseFlags } from "../backtest/shared.js";

const USAGE = `usage:
  npm run competition -- commit <file>
  npm run competition -- plan --hidden <hidden.yaml> --lottery <lottery.yaml> --k <N> [--out <plan.yaml>]`;

function readDoc(path: string): unknown {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
  return parseYaml(readFileSync(abs, "utf8"));
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const sub = args[0];
  if (sub === "commit") {
    const file = args[1];
    if (!file) throw new Error(USAGE);
    console.log(commitmentOf(readDoc(file)));
    return;
  }
  if (sub === "plan") {
    const flags = parseFlags(["node", "competition", ...args.slice(1)]);
    if (!flags.hidden || !flags.lottery || !flags.k) throw new Error(USAGE);
    const hidden = readDoc(flags.hidden) as HiddenSet;
    const lottery = readDoc(flags.lottery) as LotterySeed;
    if (!hidden || typeof hidden !== "object" || !hidden.regimes)
      throw new Error(`${flags.hidden}: expected { regimes: { <regime>: [seeds] } }`);
    if (!lottery || typeof lottery.lotterySeed !== "string")
      throw new Error(`${flags.lottery}: expected { lotterySeed: "<string>" }`);
    const k = Number(flags.k);
    const plan = buildPlan(hidden, lottery, k);
    const text = stringifyYaml(plan);
    if (flags.out) {
      writeFileSync(resolve(process.cwd(), flags.out), text);
      console.error(`[competition] wrote ${flags.out} (${plan.epochs.length} epochs)`);
    } else process.stdout.write(text);
    console.error(`[competition] hidden set  ${plan.hiddenSetCommitment}`);
    console.error(`[competition] lottery seed ${plan.lotterySeedCommitment}`);
    return;
  }
  throw new Error(USAGE);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
