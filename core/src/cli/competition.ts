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
//       [--starts-at <ISO 8601> (--every-minutes <N> | --ends-at <ISO 8601>)] stamps each epoch with
//       its intended start. --ends-at spreads the k epochs evenly over the window (ADR 0026: the
//       live week at k = 60 is one every 168 minutes). `backtest --follow-schedule` waits for them.
//
//   npm run competition -- keygen <out.yaml>
//       write a new secret scenario key (ADR 0027) to <out.yaml> (mode 0600; refuses to overwrite) and
//       print its commitment. Only the commitment leaves the operator's machine until the results.
//
// File shapes (YAML or JSON):
//   hidden set    { regimes: { calm: [..seeds..], crash: [...], ... }, salt?: "<random>" }
//   lottery seed  { lotterySeed: "<secret string>", salt?: "<random>" }
//   scenario key  { scenarioKey: "<64 lowercase hex>" }
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildPlan,
  commitmentOf,
  spreadOver,
  type HiddenSet,
  type LotterySeed,
  type Timetable,
} from "../competition/schedule.js";
import { parseFlags } from "../backtest/shared.js";
import { writeNewScenarioKeyFile } from "../scenarioKey.js";

const USAGE = `usage:
  npm run competition -- commit <file>
  npm run competition -- keygen <out.yaml>
  npm run competition -- plan --hidden <hidden.yaml> --lottery <lottery.yaml> --k <N> [--out <plan.yaml>]
      [--starts-at <ISO 8601> (--every-minutes <N> | --ends-at <ISO 8601>)]
          stamp each epoch with its intended start (the dashboard shows the next one, and
          \`npm run backtest -- --scenarios <plan> --follow-schedule\` waits for each). --every-minutes
          is the spacing; --ends-at spreads the k epochs evenly over [starts-at, ends-at) instead, one
          slot of (ends-at − starts-at) / k each, so the last starts one slot before ends-at. The live
          week: --starts-at 2026-11-01T00:00:00+09:00 --ends-at 2026-11-08T00:00:00+09:00 --k 60 is
          an epoch every 168 minutes (ADR 0026). A slot shorter than one epoch's wall time makes
          every epoch after it start late`;

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
  if (sub === "keygen") {
    const file = args[1];
    if (!file) throw new Error(USAGE);
    console.log(writeNewScenarioKeyFile(file));
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
    // Optional timetable (rules §4.7.1: the week is several sessions). A start and exactly one of
    // the spacing or the window's end -- or none of the three.
    const startsAt = flags["starts-at"];
    const everyMinutes = flags["every-minutes"];
    const endsAt = flags["ends-at"];
    if (startsAt === undefined && (everyMinutes !== undefined || endsAt !== undefined))
      throw new Error(
        "--every-minutes / --ends-at need --starts-at <ISO 8601> (the first epoch's start)",
      );
    if (startsAt !== undefined && (everyMinutes === undefined) === (endsAt === undefined))
      throw new Error(
        "--starts-at goes with exactly one of --every-minutes <N> (the spacing) or --ends-at <ISO 8601> " +
          "(spread the k epochs evenly up to it)",
      );
    const timetable: Timetable | undefined =
      startsAt === undefined
        ? undefined
        : endsAt !== undefined
          ? spreadOver({ startsAt, endsAt }, k)
          : { startsAt, everyMinutes: Number(everyMinutes) };
    const plan = buildPlan(hidden, lottery, k, timetable);
    const text = stringifyYaml(plan);
    if (flags.out) {
      writeFileSync(resolve(process.cwd(), flags.out), text);
      console.error(`[competition] wrote ${flags.out} (${plan.epochs.length} epochs)`);
    } else process.stdout.write(text);
    if (timetable) {
      const first = plan.epochs[0]?.startsAt;
      const last = plan.epochs[plan.epochs.length - 1]?.startsAt;
      console.error(
        `[competition] timetable: ${plan.epochs.length} epochs every ` +
          `${Number(timetable.everyMinutes.toFixed(3))} min, first ${first}, last ${last}`,
      );
    }
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
