// The competition's facts a participant needs before any number on this dashboard: the schedule,
// how the score is computed, the prizes, what a submission may do, and where everything else lives.
//
// The rules are published on ascon.dev (NyxFoundation/ascon-web, `content/legal/rules.md`), and
// that document is the authority. This file copies the values the Overview page shows and cites the
// section each one comes from. When the rules are amended, this is the one file to change; the
// sentences around the values are in `i18n/messages.ts` (keys `overview.*`).
//
// Dates are Japan Standard Time days (rules §1: "すべて日本標準時によります"), and the page decides
// "now" with the browser's clock — ascon.dev is static, so "where we are" can only be said here.

// Relative, not "@/": the root test suite imports this file and knows no dashboard alias.
import type { Locale } from "../i18n/locale.js";

// ---- schedule (rules §1) ----

/** A span of JST days, both ends inclusive ("2026-09-01" .. "2026-10-24"). */
export interface SchedulePhase {
  key:
    | "registration"
    | "submission"
    | "live"
    | "review"
    | "reportDeadline"
    | "results";
  first: string;
  last: string;
}

export const SCHEDULE: SchedulePhase[] = [
  // §1: 参加登録期間 2026年9月1日 〜 10月24日
  { key: "registration", first: "2026-09-01", last: "2026-10-24" },
  // §1: エージェント提出期間 2026年9月23日 〜 10月31日 (the practice environment, §2.7, runs in it)
  { key: "submission", first: "2026-09-23", last: "2026-10-31" },
  // §1: ライブ競技期間 2026年11月1日 〜 11月7日 (reserve day 11/8, see LIVE_RESERVE_DAY)
  { key: "live", first: "2026-11-01", last: "2026-11-07" },
  // §1: 審査期間 2026年11月9日 〜 11月30日
  { key: "review", first: "2026-11-09", last: "2026-11-30" },
  // §1: レポートトラック 応募締切 2026年11月21日
  { key: "reportDeadline", first: "2026-11-21", last: "2026-11-21" },
  // §1: 結果発表 2026年12月7日
  { key: "results", first: "2026-12-07", last: "2026-12-07" },
];

/** §1: 予備日 2026年11月8日 (an epoch re-run under §4.4.2). */
export const LIVE_RESERVE_DAY = "2026-11-08";

/**
 * The moments the page counts down to, in order. A deadline is the end of its day; a start is the
 * beginning of its day.
 */
export interface Milestone {
  key:
    | "registrationCloses"
    | "submissionCloses"
    | "liveStarts"
    | "reportDue"
    | "results";
  day: string;
  at: "start" | "end";
}

export const MILESTONES: Milestone[] = [
  { key: "registrationCloses", day: "2026-10-24", at: "end" },
  { key: "submissionCloses", day: "2026-10-31", at: "end" },
  { key: "liveStarts", day: "2026-11-01", at: "start" },
  { key: "reportDue", day: "2026-11-21", at: "end" },
  { key: "results", day: "2026-12-07", at: "start" },
];

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;

/** 00:00 JST of `day` ("YYYY-MM-DD"), as epoch ms. */
export function jstDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00+09:00`);
}

/** The JST calendar day `ms` falls on, as a day count (for differences only). */
function jstDayIndex(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

export type PhaseStatus = "done" | "now" | "upcoming";

export function phaseStatus(phase: SchedulePhase, nowMs: number): PhaseStatus {
  if (nowMs < jstDayStart(phase.first)) return "upcoming";
  if (nowMs >= jstDayStart(phase.last) + DAY_MS) return "done";
  return "now";
}

function milestoneMs(m: Milestone): number {
  return jstDayStart(m.day) + (m.at === "end" ? DAY_MS : 0);
}

/**
 * The next moment still ahead, and how many JST calendar days away its day is (0 = today). Null
 * once the results are out.
 */
export function nextMilestone(
  nowMs: number,
): { milestone: Milestone; daysLeft: number } | null {
  const next = MILESTONES.find((m) => milestoneMs(m) > nowMs);
  if (!next) return null;
  return {
    milestone: next,
    daysLeft: jstDayIndex(jstDayStart(next.day)) - jstDayIndex(nowMs),
  };
}

/**
 * Whether the registration form still takes entries. §1 closes registration at the end of 10/24
 * JST, so the header stops offering the form at 10/25 00:00 JST.
 */
export function registrationOpen(nowMs: number): boolean {
  const registration = SCHEDULE.find((p) => p.key === "registration");
  return (
    registration !== undefined && phaseStatus(registration, nowMs) !== "done"
  );
}

// ---- scoring (rules §4.4, §4.6, appendix A) ----

export const SCORING = {
  /** Appendix A / §4.4.1: epochs planned for the live week (12 regimes × 5). */
  epochs: 60,
  regimes: 12,
  /** Appendix A / §4.7.1: blocks per epoch (≈ 12 minutes at 2 s). */
  blocksPerEpoch: 360,
  /** §4.4.1: w_s rises linearly from the first epoch to the last. */
  weightFirst: 1,
  weightLast: 1.5,
};

// ---- prizes (rules §6) ----

/** §6.1 Leaderboard track, JPY by rank (1st … 15th). */
export const LEADERBOARD_PRIZES_JPY = [
  1_000_000, 500_000, 300_000, 200_000, 150_000, 130_000, 120_000, 110_000,
  100_000, 90_000, 80_000, 70_000, 60_000, 50_000, 40_000,
];

/** §6.1: from 6th place down, a prize needs a final score above this (the field's mean). */
export const PRIZE_SCORE_FLOOR = 50;
export const PRIZE_SCORE_FLOOR_FROM_RANK = 6;

/** §6.2 Report track: how many of each award, and JPY each. */
export const REPORT_PRIZES_JPY: {
  key: "best" | "excellence" | "division" | "honorable";
  count: number;
  each: number;
}[] = [
  { key: "best", count: 1, each: 500_000 },
  { key: "excellence", count: 2, each: 300_000 },
  { key: "division", count: 3, each: 200_000 },
  { key: "honorable", count: 3, each: 100_000 },
];

export const LEADERBOARD_TOTAL_JPY = LEADERBOARD_PRIZES_JPY.reduce(
  (a, b) => a + b,
  0,
);
export const REPORT_TOTAL_JPY = REPORT_PRIZES_JPY.reduce(
  (a, r) => a + r.count * r.each,
  0,
);
export const PRIZE_TOTAL_JPY = LEADERBOARD_TOTAL_JPY + REPORT_TOTAL_JPY;

// ---- submission and constraints (rules §2) ----

export const CONSTRAINTS = {
  /** §2.2: replacements per JST day during the submission period. */
  submissionsPerDay: 5,
  /** §2.3: compute cap per agent. */
  vcpu: 2,
  memoryGb: 4,
  /** §2.3: a decision not back within this is that block passed up (no restart). */
  decisionTimeoutMs: 5_000,
  /** §2.5: the LLM revises the strategy at most once per this many blocks (the default). */
  reviseEveryBlocks: 60,
  /** §2.6 */
  blockTimeSec: 2,
  blockGasLimit: 30_000_000,
};

// ---- where things are ----

/** ascon.dev (NyxFoundation/ascon-web `src/links.ts`). */
export const SITE_URL = "https://ascon.dev";
/** ascon-web `src/links.ts` REGISTRATION_FORM_URL. */
export const REGISTRATION_FORM_URL = "https://forms.gle/PWhktsUMmic2FbYm8";
/** ascon-web `src/links.ts` DISCORD_URL. Questions, and practice registrations (post an address). */
export const DISCORD_URL = "https://discord.gg/QusaeRK4Ea";
export const REPO_URL = "https://github.com/NyxFoundation/eris-agent-simulator";
/** The practice environment (§2.7) a self-hosted agent connects to. */
export const PRACTICE_RPC_URL = "https://ascon-rpc.nyx.foundation/";
export const PRACTICE_EXPLORER_URL = "https://ascon-explorer.nyx.foundation";
/** Served by this dashboard's own runs API (server/runsApi.ts, issue #156). */
export const MANIFEST_PATH = "/runs/manifest.json";

/** The English pages of ascon.dev live under /en (the Japanese text is authoritative, terms §39). */
function sitePath(locale: Locale, page: string): string {
  return `${SITE_URL}${locale === "en" ? "/en" : ""}/${page}`;
}

/**
 * The rules, optionally at a numbered section ("4.4" → `#section-4-4`, the anchor ascon-web's
 * `scripts/build-legal.ts` gives a numbered heading).
 */
export function rulesUrl(locale: Locale, section?: string): string {
  const anchor = section ? `#section-${section.replace(/\./g, "-")}` : "";
  return `${sitePath(locale, "rules")}${anchor}`;
}

export function termsUrl(locale: Locale): string {
  return sitePath(locale, "terms");
}

/** The participant guide (build, test, submit), in the viewer's language. */
export function guideUrl(locale: Locale): string {
  return `${REPO_URL}/blob/main/docs/competition-start${locale === "en" ? ".en" : ""}.md`;
}
