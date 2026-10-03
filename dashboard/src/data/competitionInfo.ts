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
/**
 * The agent submission form (rules §2.1–§2.2; ascon-web `ops/submission-form/`). Open 9/23–10/31;
 * it takes a ZIP upload, so it asks the sender to sign in with a Google account.
 */
export const SUBMISSION_FORM_URL = "https://forms.gle/97bxYQvh43GVAS4z9";
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

/**
 * The environment's update history, in the viewer's language. The guide always describes the current
 * environment, so somebody who read it last week has no way to see what moved; this page is that
 * diff. Served from the repository like the guide rather than rendered here: the dashboard has no
 * Markdown page, and a second copy of a notice is a second thing to keep correct.
 */
export function updatesUrl(locale: Locale): string {
  return `${REPO_URL}/blob/main/docs/competition-updates${locale === "en" ? ".en" : ""}.md`;
}

// ---- how to submit (rules §1, §2.1, §2.2, §2.7; the participant guide) ----

/**
 * The steps from registering to the freeze, in order. A step with a `window` is open while that
 * schedule phase is; one with only `from` opens on that day and has no end the rules state. The
 * dashboard cannot know how far a participant has got, so it never points at "your" step — it says
 * which steps are open today.
 */
export interface SubmissionStep {
  key:
    | "register"
    | "apiKey"
    | "build"
    | "test"
    | "practice"
    | "zip"
    | "submit"
    | "freeze";
  /** Not needed to submit (the practice environment, §2.7). */
  optional?: boolean;
  window?: SchedulePhase["key"];
  from?: string;
  /** Heading anchor in docs/competition-start(.en).md. */
  guide?: { ja: string; en: string; section: string };
  /** The one command the step is about, shown as is. */
  command?: string;
}

export const SUBMISSION_STEPS: SubmissionStep[] = [
  // §1: joining the ASCON Discord channel and submitting the registration form.
  { key: "register", window: "registration" },
  // The inference API key is registered once, on its own form (Participation Terms Art. 8-2 keeps
  // it apart from everything else); that form accepts keys from the start of the submission period.
  { key: "apiKey", from: "2026-09-23" },
  {
    key: "build",
    guide: {
      ja: "3-提出できる最小のエージェント",
      en: "3-the-smallest-submittable-agent",
      section: "3",
    },
  },
  {
    key: "test",
    guide: {
      ja: "6-開発の反復-回す読む直す",
      en: "6-the-development-loop-run-read-fix",
      section: "6",
    },
  },
  // §2.7: the practice environment runs through the submission period.
  {
    key: "practice",
    optional: true,
    window: "submission",
    guide: {
      ja: "9-練習-devnet任意",
      en: "9-the-practice-devnet-optional",
      section: "9",
    },
  },
  {
    key: "zip",
    command: "npm run bundle:agent <id>",
    guide: { ja: "10-提出", en: "10-submitting", section: "10" },
  },
  // §2.2: up to five a day, each accepted or not within seconds of sending.
  { key: "submit", window: "submission" },
  // §2.2: the one accepted last when the period ends is evaluated; agents are frozen.
  { key: "freeze" },
];

export type StepStatus =
  | { kind: "before"; day: string }
  | { kind: "open"; daysLeft: number | null }
  | { kind: "closed" };

/** Whether a step can be done today, and for how many more JST days. Null for a step with no date. */
export function stepStatus(step: SubmissionStep, nowMs: number): StepStatus | null {
  if (step.window) {
    const phase = SCHEDULE.find((p) => p.key === step.window);
    if (!phase) return null;
    const status = phaseStatus(phase, nowMs);
    if (status === "upcoming") return { kind: "before", day: phase.first };
    if (status === "done") return { kind: "closed" };
    return {
      kind: "open",
      daysLeft: jstDayIndex(jstDayStart(phase.last)) - jstDayIndex(nowMs),
    };
  }
  if (step.from) {
    return nowMs < jstDayStart(step.from)
      ? { kind: "before", day: step.from }
      : { kind: "open", daysLeft: null };
  }
  return null;
}

/** Within the submission period (rules §1: 9/23–10/31 JST), when the submission form takes ZIPs. */
export function submissionOpen(nowMs: number): boolean {
  const submission = SCHEDULE.find((p) => p.key === "submission");
  return submission !== undefined && phaseStatus(submission, nowMs) === "now";
}

/** Past the end of the submission period: agents are frozen and the steps are history. */
export function submissionClosed(nowMs: number): boolean {
  const submission = SCHEDULE.find((p) => p.key === "submission");
  return submission !== undefined && phaseStatus(submission, nowMs) === "done";
}

/** The participant guide at one section, in the viewer's language. */
export function guideSectionUrl(
  locale: Locale,
  guide: NonNullable<SubmissionStep["guide"]>,
): string {
  return `${guideUrl(locale)}#${locale === "en" ? guide.en : guide.ja}`;
}
