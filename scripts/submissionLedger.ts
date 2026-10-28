// npm run submission-ledger -- <record | check | final> [--ledger <ledger.jsonl>] ...
//
// The acceptance ledger: one JSON line per run of infra/submission/accept-submission.sh, ACCEPT or
// REJECT. Rules §2.2: a participation unit may replace its submission up to 5 times a day, and the
// LAST accepted one is the one evaluated. Without a ledger, "which ZIP is the evaluated one" was the
// operator's memory plus whatever eris-agent:<id> happened to be tagged at the time.
//
//   record --unit <id> --result ACCEPT|REJECT [--zip <zip>] [--digest <image id>] [--reason <text>]
//          [--at <ISO time>] [--limit 5]
//       appends one line; the ZIP's sha256 is computed here. An ACCEPT beyond the day's limit is
//       recorded with overLimit: true and exits 3 (the line is still written: it happened)
//   check  --unit <id> [--at <ISO time>] [--limit 5]
//       how many accepts the unit has on today's JST day; exits 3 when the limit is reached
//   final  [--deadline <ISO time>] [--format table|yaml|both]
//       the last ACCEPT per unit (the §2.2 evaluated submission) as a table and as the field.yaml
//       `agents:` block. --deadline drops anything recorded at or after it (the 11/30 24:00 JST
//       deadline is 2026-11-30T15:00:00Z)
//
// The ledger path is --ledger, or ERIS_SUBMISSION_LEDGER (what accept-submission.sh passes on).
// "Day" is the JST calendar day, because that is the day the rules and the participants count in.
import { appendFileSync, createReadStream, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DAILY_LIMIT = 5;
const UNIT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export type LedgerEntry = {
  unit: string;
  result: "ACCEPT" | "REJECT";
  at: string; // ISO 8601, UTC
  jstDay: string; // YYYY-MM-DD in Asia/Tokyo
  zip?: string; // the file's base name as received
  zipSha256?: string;
  imageDigest?: string; // ACCEPT only: `docker image inspect --format {{.Id}}`
  reason?: string; // REJECT only
  acceptedToday: number; // the unit's ACCEPTs on jstDay, this one included
  overLimit?: true;
};

export function jstDay(at: Date): string {
  return new Date(at.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let e: LedgerEntry;
    try {
      e = JSON.parse(line) as LedgerEntry;
    } catch {
      throw new Error(`ledger line ${i + 1} is not JSON`);
    }
    if (!e || typeof e.unit !== "string" || (e.result !== "ACCEPT" && e.result !== "REJECT") || typeof e.at !== "string")
      throw new Error(`ledger line ${i + 1} is not a ledger entry`);
    out.push(e);
  });
  return out;
}

export function readLedger(path: string): LedgerEntry[] {
  return existsSync(path) ? parseLedger(readFileSync(path, "utf8")) : [];
}

export function acceptedOn(entries: LedgerEntry[], unit: string, day: string): number {
  return entries.filter((e) => e.unit === unit && e.result === "ACCEPT" && e.jstDay === day).length;
}

export function makeEntry(
  entries: LedgerEntry[],
  input: {
    unit: string;
    result: "ACCEPT" | "REJECT";
    at: Date;
    zip?: string;
    zipSha256?: string;
    imageDigest?: string;
    reason?: string;
  },
  limit = DAILY_LIMIT,
): LedgerEntry {
  if (!UNIT_ID_RE.test(input.unit)) throw new Error(`invalid unit id: ${input.unit}`);
  if (input.result === "ACCEPT" && !input.imageDigest) throw new Error("an ACCEPT needs the image digest");
  const day = jstDay(input.at);
  const before = acceptedOn(entries, input.unit, day);
  const acceptedToday = before + (input.result === "ACCEPT" ? 1 : 0);
  return {
    unit: input.unit,
    result: input.result,
    at: input.at.toISOString(),
    jstDay: day,
    ...(input.zip ? { zip: input.zip } : {}),
    ...(input.zipSha256 ? { zipSha256: input.zipSha256 } : {}),
    ...(input.result === "ACCEPT" ? { imageDigest: input.imageDigest } : {}),
    ...(input.result === "REJECT" && input.reason ? { reason: input.reason } : {}),
    acceptedToday,
    ...(input.result === "ACCEPT" && acceptedToday > limit ? { overLimit: true as const } : {}),
  };
}

export type FinalRow = {
  unit: string;
  entry: LedgerEntry; // the evaluated one
  accepts: number; // all ACCEPTs before the deadline
  rejectedAfter: number; // REJECTs after the evaluated one (they do not displace it)
  overLimitDays: string[];
};

// Rules §2.2: the last ACCEPT per unit. Order is the ledger's (append order = acceptance order);
// `at` breaks nothing because the lines are written as they happen.
export function finalSubmissions(entries: LedgerEntry[], deadline?: Date): FinalRow[] {
  const inTime = deadline ? entries.filter((e) => Date.parse(e.at) < deadline.getTime()) : entries;
  const byUnit = new Map<string, FinalRow>();
  for (const e of inTime) {
    const row = byUnit.get(e.unit);
    if (e.result === "ACCEPT") {
      if (row) {
        row.entry = e;
        row.accepts++;
        row.rejectedAfter = 0;
      } else byUnit.set(e.unit, { unit: e.unit, entry: e, accepts: 1, rejectedAfter: 0, overLimitDays: [] });
    } else if (row) row.rejectedAfter++;
  }
  for (const row of byUnit.values()) {
    const days = new Map<string, number>();
    for (const e of inTime)
      if (e.unit === row.unit && e.result === "ACCEPT") days.set(e.jstDay, (days.get(e.jstDay) ?? 0) + 1);
    row.overLimitDays = [...days].filter(([, n]) => n > DAILY_LIMIT).map(([d, n]) => `${d} (${n})`);
  }
  return [...byUnit.values()].sort((a, b) => a.unit.localeCompare(b.unit));
}

export function renderTable(rows: FinalRow[]): string {
  const head = ["unit", "accepted at (UTC)", "JST day", "image digest", "zip sha256", "accepts", "note"];
  const body = rows.map((r) => [
    r.unit,
    r.entry.at,
    r.entry.jstDay,
    r.entry.imageDigest ?? "",
    r.entry.zipSha256 ?? "",
    String(r.accepts),
    [
      r.rejectedAfter ? `${r.rejectedAfter} later REJECT(s)` : "",
      r.overLimitDays.length ? `over ${DAILY_LIMIT}/day: ${r.overLimitDays.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

export function renderAgentsBlock(rows: FinalRow[]): string {
  return ["agents:", ...rows.map((r) => `  - id: ${r.unit}\n    wallet: AUTO`)].join("\n");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// --- CLI -------------------------------------------------------------------------------------------

const USAGE = [
  "usage: npm run submission-ledger -- record --unit <id> --result ACCEPT|REJECT [--zip <zip>] [--digest <id>] [--reason <text>] [--ledger <path>]",
  "       npm run submission-ledger -- check --unit <id> [--ledger <path>]",
  "       npm run submission-ledger -- final [--deadline <ISO>] [--format table|yaml|both] [--ledger <path>]",
].join("\n");

function parseArgs(argv: string[]): { command?: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = v;
    } else if (!command) command = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return { command, flags };
}

function parseTime(text: string | undefined, name: string): Date | undefined {
  if (text === undefined) return undefined;
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`--${name}: not a time: ${text}`);
  return new Date(t);
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: (s: string) => void = console.log,
  err: (s: string) => void = console.error,
): Promise<number> {
  try {
    const { command, flags } = parseArgs(argv);
    const ledgerPath = flags.ledger ?? env.ERIS_SUBMISSION_LEDGER;
    if (!command || !ledgerPath) {
      err(USAGE);
      return 1;
    }
    const path = resolve(ledgerPath);
    const limit = flags.limit ? Number(flags.limit) : DAILY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer`);
    const entries = readLedger(path);
    const at = parseTime(flags.at, "at") ?? new Date();

    if (command === "check") {
      if (!flags.unit) throw new Error("check needs --unit");
      const day = jstDay(at);
      const n = acceptedOn(entries, flags.unit, day);
      log(`${flags.unit}: ${n} accepted on ${day} (JST), ${Math.max(0, limit - n)} of ${limit} left`);
      return n >= limit ? 3 : 0;
    }
    if (command === "record") {
      if (!flags.unit) throw new Error("record needs --unit");
      const result = flags.result?.toUpperCase();
      if (result !== "ACCEPT" && result !== "REJECT") throw new Error("record needs --result ACCEPT|REJECT");
      const entry = makeEntry(
        entries,
        {
          unit: flags.unit,
          result,
          at,
          ...(flags.zip ? { zip: basename(flags.zip) } : {}),
          ...(flags.zip && existsSync(flags.zip) ? { zipSha256: await sha256File(flags.zip) } : {}),
          ...(flags.digest ? { imageDigest: flags.digest } : {}),
          ...(flags.reason ? { reason: flags.reason.replace(/\s+/g, " ").trim().slice(0, 500) } : {}),
        },
        limit,
      );
      appendFileSync(path, JSON.stringify(entry) + "\n");
      log(
        `ledger: ${entry.result} ${entry.unit} at ${entry.at}` +
          (entry.zipSha256 ? ` zip ${entry.zipSha256.slice(0, 12)}…` : "") +
          ` -- ${entry.acceptedToday} accepted on ${entry.jstDay} (JST), ${Math.max(0, limit - entry.acceptedToday)} of ${limit} left`,
      );
      if (entry.overLimit) {
        err(`ledger: ${entry.unit} is over the limit of ${limit} accepted per JST day (rules §2.2)`);
        return 3;
      }
      return 0;
    }
    if (command === "final") {
      const deadline = parseTime(flags.deadline, "deadline");
      const rows = finalSubmissions(entries, deadline);
      const format = flags.format ?? "both";
      if (!["table", "yaml", "both"].includes(format)) throw new Error("--format is table | yaml | both");
      if (rows.length === 0) {
        err(`no ACCEPT in ${path}${deadline ? ` before ${deadline.toISOString()}` : ""}`);
        return 1;
      }
      if (format !== "yaml") {
        log(`# evaluated submission per unit (rules §2.2: the last accepted)${deadline ? `, before ${deadline.toISOString()}` : ""}`);
        log(renderTable(rows));
      }
      if (format === "both") log("");
      if (format !== "table") log(renderAgentsBlock(rows));
      for (const r of rows)
        if (r.overLimitDays.length)
          err(`warn: ${r.unit} has more than ${DAILY_LIMIT} accepts on ${r.overLimitDays.join(", ")}`);
      return 0;
    }
    err(USAGE);
    return 1;
  } catch (e) {
    err(`submission-ledger: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
