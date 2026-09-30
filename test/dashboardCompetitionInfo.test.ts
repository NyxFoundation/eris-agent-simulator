// The competition facts the dashboard's overview shows (issue #183): the schedule's "now", the
// registration cutoff the header obeys, the prize totals against the rules, and the rules anchors.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LEADERBOARD_TOTAL_JPY,
  PRIZE_TOTAL_JPY,
  REPORT_TOTAL_JPY,
  SCHEDULE,
  SUBMISSION_STEPS,
  guideSectionUrl,
  guideUrl,
  nextMilestone,
  phaseStatus,
  registrationOpen,
  rulesUrl,
  stepStatus,
  submissionClosed,
} from "../dashboard/src/data/competitionInfo.js";

const jst = (iso: string) => Date.parse(`${iso}+09:00`);

test("registration is offered through the end of 10/24 JST and not at 10/25 00:00", () => {
  assert.equal(registrationOpen(jst("2026-09-29T12:00:00")), true);
  assert.equal(registrationOpen(jst("2026-10-24T23:59:59")), true);
  assert.equal(registrationOpen(jst("2026-10-25T00:00:00")), false);
  // The same instant in UTC, as a browser outside Japan holds it.
  assert.equal(registrationOpen(Date.parse("2026-10-24T15:00:00Z")), false);
  assert.equal(registrationOpen(Date.parse("2026-10-24T14:59:59Z")), true);
});

test("the schedule's current phases on 9/29: registration and submission overlap", () => {
  const now = jst("2026-09-29T12:00:00");
  const status = Object.fromEntries(
    SCHEDULE.map((p) => [p.key, phaseStatus(p, now)]),
  );
  assert.deepEqual(status, {
    registration: "now",
    submission: "now",
    live: "upcoming",
    review: "upcoming",
    reportDeadline: "upcoming",
    results: "upcoming",
  });
});

test("the next milestone counts JST calendar days, 0 being today", () => {
  assert.deepEqual(nextMilestone(jst("2026-09-29T12:00:00")), {
    milestone: { key: "registrationCloses", day: "2026-10-24", at: "end" },
    daysLeft: 25,
  });
  assert.equal(nextMilestone(jst("2026-10-24T23:00:00"))?.daysLeft, 0);
  assert.equal(
    nextMilestone(jst("2026-10-25T00:00:00"))?.milestone.key,
    "submissionCloses",
  );
  // The live week starts at the beginning of 11/1: on 10/31 it is tomorrow's, on 11/1 it is past.
  assert.equal(
    nextMilestone(jst("2026-11-01T00:00:00"))?.milestone.key,
    "reportDue",
  );
  assert.equal(nextMilestone(jst("2026-12-07T00:00:00")), null);
});

test("prize totals match rules §6: 3,000,000 + 2,000,000 = 5,000,000 JPY", () => {
  assert.equal(LEADERBOARD_TOTAL_JPY, 3_000_000);
  assert.equal(REPORT_TOTAL_JPY, 2_000_000);
  assert.equal(PRIZE_TOTAL_JPY, 5_000_000);
});

test("rules links use ascon.dev's numbered-heading anchors, in the viewer's language", () => {
  assert.equal(rulesUrl("ja", "4.4"), "https://ascon.dev/rules#section-4-4");
  assert.equal(rulesUrl("en", "6"), "https://ascon.dev/en/rules#section-6");
  assert.equal(rulesUrl("ja"), "https://ascon.dev/rules");
  assert.match(guideUrl("en"), /docs\/competition-start\.en\.md$/);
  assert.match(guideUrl("ja"), /docs\/competition-start\.md$/);
});

const step = (key: string) => {
  const found = SUBMISSION_STEPS.find((s) => s.key === key);
  assert.ok(found, key);
  return found;
};

test("a step with a window says whether it is open and for how many JST days", () => {
  assert.deepEqual(stepStatus(step("register"), jst("2026-09-29T12:00:00")), {
    kind: "open",
    daysLeft: 25,
  });
  assert.deepEqual(stepStatus(step("register"), jst("2026-10-24T23:59:00")), {
    kind: "open",
    daysLeft: 0,
  });
  assert.deepEqual(stepStatus(step("register"), jst("2026-10-25T00:00:00")), {
    kind: "closed",
  });
  assert.deepEqual(stepStatus(step("submit"), jst("2026-09-20T12:00:00")), {
    kind: "before",
    day: "2026-09-23",
  });
  assert.deepEqual(stepStatus(step("submit"), jst("2026-10-31T23:00:00")), {
    kind: "open",
    daysLeft: 0,
  });
});

test("the API key form opens with the submission period and has no stated end", () => {
  assert.deepEqual(stepStatus(step("apiKey"), jst("2026-09-22T23:59:00")), {
    kind: "before",
    day: "2026-09-23",
  });
  assert.deepEqual(stepStatus(step("apiKey"), jst("2026-11-05T12:00:00")), {
    kind: "open",
    daysLeft: null,
  });
  assert.equal(stepStatus(step("build"), jst("2026-09-29T12:00:00")), null);
});

test("the steps collapse once the submission period is over", () => {
  assert.equal(submissionClosed(jst("2026-10-31T23:59:59")), false);
  assert.equal(submissionClosed(jst("2026-11-01T00:00:00")), true);
});

test("step guide links point at the guide's own heading anchors", () => {
  const zip = step("zip");
  assert.ok(zip.guide);
  assert.match(guideSectionUrl("en", zip.guide), /competition-start\.en\.md#10-submitting$/);
  assert.match(guideSectionUrl("ja", zip.guide), /competition-start\.md#10-提出$/);
});

test("every step's guide anchor is in the guide's table of contents, in both languages", () => {
  const ja = readFileSync(new URL("../docs/competition-start.md", import.meta.url), "utf8");
  const en = readFileSync(new URL("../docs/competition-start.en.md", import.meta.url), "utf8");
  for (const s of SUBMISSION_STEPS) {
    if (!s.guide) continue;
    assert.ok(ja.includes(`(#${s.guide.ja})`), `ja anchor #${s.guide.ja}`);
    assert.ok(en.includes(`(#${s.guide.en})`), `en anchor #${s.guide.en}`);
  }
});
