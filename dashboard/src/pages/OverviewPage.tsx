// The landing page: what a participant needs to know about ASCON before any number on this
// dashboard — where the schedule stands today, how the score works, what the prizes are, what a
// submission may do, who leads, and where the rules, the guide and the connection details are.
//
// Everything here is either a fact from the rules (data/competitionInfo.ts, which cites them) or
// the selected competition's own standings. Each fact is shown as its gist, with the full statement
// one "?" away and the authoritative text linked on ascon.dev: this page summarises the rules, it
// does not replace them.

import { useMemo } from "react";
import { AppShell, PAGE_MAIN } from "@/components/AppShell";
import { Panel, toneColor } from "@/components/competitionUi";
import {
  CONSTRAINTS,
  DISCORD_URL,
  LEADERBOARD_PRIZES_JPY,
  LEADERBOARD_TOTAL_JPY,
  LIVE_RESERVE_DAY,
  MANIFEST_PATH,
  PRACTICE_EXPLORER_URL,
  PRACTICE_RPC_URL,
  PRIZE_SCORE_FLOOR,
  PRIZE_SCORE_FLOOR_FROM_RANK,
  PRIZE_TOTAL_JPY,
  REPO_URL,
  REPORT_PRIZES_JPY,
  REPORT_TOTAL_JPY,
  SCHEDULE,
  SCORING,
  SITE_URL,
  guideUrl,
  jstDayStart,
  nextMilestone,
  phaseStatus,
  rulesUrl,
  termsUrl,
  type PhaseStatus,
} from "@/data/competitionInfo";
import { useMode } from "@/data/mode";
import { buildStandings } from "@/data/standings";
import { useCompetitionSnapshot } from "@/data/useCompetitionSnapshot";
import { InfoTip, TipText } from "@/design-system/InfoTip";
import { useLocale, type Locale } from "@/i18n/locale";
import { t, type MessageKey } from "@/i18n/messages";
import {
  formatJpy,
  formatJpyShort,
  formatJstDay,
  formatJstRange,
  formatScore,
} from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { navigate } from "@/navigation";

const TOP_N = 5;

const EYEBROW: React.CSSProperties = {
  font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase",
  color: "var(--text-secondary)",
};

const LINK: React.CSSProperties = {
  color: "var(--text-link)",
  textDecoration: "none",
};

const FORMULA: React.CSSProperties = {
  display: "block",
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  font: "var(--text-xs) var(--font-mono)",
  color: "var(--text-primary)",
  lineHeight: 1.7,
  whiteSpace: "pre-wrap",
};

function External({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={LINK}>
      {children}
    </a>
  );
}

/** "Rules §4.4 ↗" — the authoritative text for a card. */
function RulesLink({ locale, section }: { locale: Locale; section: string }) {
  return (
    <External href={rulesUrl(locale, section)}>
      {t("overview.rulesLink", { section: `§${section}` })} ↗
    </External>
  );
}

/** 1 → "1st", 12 → "12th", 22 → "22nd". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

// ---- schedule ----

function whenLabel(daysLeft: number): string {
  if (daysLeft <= 0) return t("overview.schedule.today");
  if (daysLeft === 1) return t("overview.schedule.tomorrow");
  return t("overview.schedule.inDays", { n: daysLeft });
}

const STATUS_COLOR: Record<PhaseStatus, string> = {
  done: "var(--text-disabled)",
  now: "var(--text-primary)",
  upcoming: "var(--text-secondary)",
};

function SchedulePanel({ now, locale }: { now: number; locale: Locale }) {
  const next = nextMilestone(now);
  return (
    <Panel
      title={t("overview.schedule.title")}
      info={
        <>
          <TipText>{t("overview.schedule.tipJst")}</TipText>
          <TipText>
            {t("overview.schedule.tipReserve", {
              day: formatJstDay(LIVE_RESERVE_DAY, locale),
            })}
          </TipText>
          <TipText>
            <RulesLink locale={locale} section="1" />
          </TipText>
        </>
      }
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          gap: "4px 10px",
        }}
      >
        {next ? (
          <>
            <span style={{ ...EYEBROW, color: "var(--pink-300)" }}>
              {t("overview.schedule.next")}
            </span>
            <span
              style={{
                font: "var(--weight-semibold) var(--text-md) var(--font-sans)",
                color: "var(--text-primary)",
              }}
            >
              {t(`overview.milestone.${next.milestone.key}` as MessageKey)}
            </span>
            <span
              style={{
                font: "var(--text-sm) var(--font-mono)",
                color: "var(--text-secondary)",
              }}
            >
              {formatJstDay(next.milestone.day, locale)} ·{" "}
              <span style={{ color: "var(--pink-300)" }}>
                {whenLabel(next.daysLeft)}
              </span>
            </span>
          </>
        ) : (
          <span
            style={{
              font: "var(--text-sm) var(--font-sans)",
              color: "var(--text-secondary)",
            }}
          >
            {t("overview.schedule.complete")}
          </span>
        )}
      </div>
      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          // Six phases side by side where they fit, a column on a phone.
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "1px",
          background: "var(--border-subtle)",
        }}
      >
        {SCHEDULE.map((phase) => {
          const status = phaseStatus(phase, now);
          return (
            <li
              key={phase.key}
              aria-current={status === "now" ? "step" : undefined}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                padding: "11px 14px",
                minWidth: 0,
                background:
                  status === "now"
                    ? "color-mix(in oklch, var(--pink-500) 10%, var(--bg-surface))"
                    : "var(--bg-surface)",
                boxShadow:
                  status === "now" ? "inset 0 3px 0 var(--pink-500)" : "none",
              }}
            >
              <span
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color:
                    status === "now"
                      ? "var(--pink-300)"
                      : status === "done"
                        ? "var(--text-disabled)"
                        : "var(--text-tertiary)",
                  letterSpacing: "var(--tracking-wide)",
                }}
              >
                {status === "now"
                  ? t("overview.schedule.now")
                  : status === "done"
                    ? t("overview.schedule.done")
                    : t("overview.schedule.upcoming")}
              </span>
              <span
                style={{
                  font: `${status === "now" ? "var(--weight-semibold)" : "var(--weight-medium)"} var(--text-sm) var(--font-sans)`,
                  color: STATUS_COLOR[status],
                  lineHeight: 1.35,
                }}
              >
                {t(`overview.phase.${phase.key}` as MessageKey)}
              </span>
              <span
                style={{
                  font: "var(--text-sm) var(--font-mono)",
                  color: STATUS_COLOR[status],
                }}
              >
                {formatJstRange(phase.first, phase.last, locale)}
              </span>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

// ---- the three rule cards ----

function RuleCard({
  title,
  gist,
  facts,
  tip,
  locale,
  section,
}: {
  title: string;
  gist: string;
  facts: string;
  tip: React.ReactNode;
  locale: Locale;
  section: string;
}) {
  return (
    <section
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-surface)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        minWidth: 0,
      }}
    >
      <span
        style={{
          ...EYEBROW,
          display: "flex",
          alignItems: "center",
          gap: "4px",
        }}
      >
        {title}
        <InfoTip label={title} title={title} width={420}>
          {tip}
        </InfoTip>
      </span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-md) var(--font-sans)",
          color: "var(--text-primary)",
          lineHeight: 1.4,
        }}
      >
        {gist}
      </span>
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
          lineHeight: 1.6,
        }}
      >
        {facts}
      </span>
      <span
        style={{ marginTop: "auto", font: "var(--text-xs) var(--font-mono)" }}
      >
        <RulesLink locale={locale} section={section} />
      </span>
    </section>
  );
}

function ScoringTip({ locale }: { locale: Locale }) {
  return (
    <>
      <TipText>
        {t("overview.scoring.tipEpoch", {
          blocks: SCORING.blocksPerEpoch,
          min: (SCORING.blocksPerEpoch * CONSTRAINTS.blockTimeSec) / 60,
          k: SCORING.epochs,
        })}
      </TipText>
      <span style={FORMULA}>
        {`P = V_K − V_0\nT = 50 + 10 × (P − μ) / σ\nScore = Σ w·T / Σ w`}
      </span>
      <TipText>{t("overview.scoring.tipP")}</TipText>
      <TipText>{t("overview.scoring.tipT")}</TipText>
      <TipText>
        {t("overview.scoring.tipW", {
          first: SCORING.weightFirst,
          last: SCORING.weightLast,
        })}
      </TipText>
      <TipText>{t("overview.scoring.tipTies")}</TipText>
      <TipText>{t("overview.scoring.tipBankrupt")}</TipText>
      <TipText>{t("overview.scoring.tipSameBlocks")}</TipText>
      <TipText>{t("overview.scoring.tipPractice")}</TipText>
      <TipText>
        <RulesLink locale={locale} section="4.4" />
        {" · "}
        <RulesLink locale={locale} section="4.6" />
      </TipText>
    </>
  );
}

function PrizeTip({ locale }: { locale: Locale }) {
  return (
    <>
      <TipText>
        {t("overview.prize.tipLeaderboard", {
          total: formatJpy(LEADERBOARD_TOTAL_JPY, locale),
        })}
      </TipText>
      <span
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "2px 16px",
          font: "var(--text-xs) var(--font-mono)",
        }}
      >
        {LEADERBOARD_PRIZES_JPY.map((amount, i) => (
          <span
            key={i}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "8px",
              color:
                i + 1 >= PRIZE_SCORE_FLOOR_FROM_RANK
                  ? "var(--text-secondary)"
                  : "var(--text-primary)",
            }}
          >
            <span>
              {t("overview.prize.rank", {
                n: locale === "en" ? ordinal(i + 1) : i + 1,
              })}
            </span>
            <span>{formatJpy(amount, locale)}</span>
          </span>
        ))}
      </span>
      <TipText>
        {t("overview.prize.tipFloor", {
          from:
            locale === "en"
              ? ordinal(PRIZE_SCORE_FLOOR_FROM_RANK)
              : PRIZE_SCORE_FLOOR_FROM_RANK,
          floor: PRIZE_SCORE_FLOOR,
        })}
      </TipText>
      <TipText>
        {t("overview.prize.tipReport", {
          total: formatJpy(REPORT_TOTAL_JPY, locale),
          list: REPORT_PRIZES_JPY.map((r) =>
            t("overview.prize.award", {
              name: t(`overview.prize.award.${r.key}` as MessageKey),
              amount: formatJpyShort(r.each, locale),
              n: r.count,
            }),
          ).join(" · "),
        })}
      </TipText>
      <TipText>{t("overview.prize.tipBoth")}</TipText>
      <TipText>
        <RulesLink locale={locale} section="6" />
      </TipText>
    </>
  );
}

function SubmissionTip({ locale }: { locale: Locale }) {
  return (
    <>
      <TipText>{t("overview.submission.tipZip")}</TipText>
      <TipText>
        {t("overview.submission.tipReplace", {
          n: CONSTRAINTS.submissionsPerDay,
        })}
      </TipText>
      <TipText>
        {t("overview.submission.tipRun", {
          cpu: CONSTRAINTS.vcpu,
          mem: CONSTRAINTS.memoryGb,
          ms: CONSTRAINTS.decisionTimeoutMs.toLocaleString("en-US"),
        })}
      </TipText>
      <TipText>
        {t("overview.submission.tipLlm", {
          n: CONSTRAINTS.reviseEveryBlocks,
        })}
      </TipText>
      <TipText>
        {t("overview.submission.tipChain", {
          sec: CONSTRAINTS.blockTimeSec,
          gas: CONSTRAINTS.blockGasLimit.toLocaleString("en-US"),
        })}
      </TipText>
      <TipText>{t("overview.submission.tipSees")}</TipText>
      <TipText>
        <RulesLink locale={locale} section="2" />
      </TipText>
    </>
  );
}

// ---- the top of the table ----

function TopStandings({ now }: { now: number }) {
  const mode = useMode();
  // Rules §4.7: where the server says standings are not posted, this page posts none either — the
  // same switch the standings page obeys. Until the mode is known, nothing is shown, and the
  // competition is not even loaded: on the public box that load is the heaviest thing a visit to
  // the landing page could ask for.
  return mode.standings ? <TopStandingsTable now={now} /> : null;
}

function TopStandingsTable({ now }: { now: number }) {
  const { data } = useCompetitionSnapshot();
  const standings = useMemo(
    () => (data ? buildStandings(data.competition, data.rounds, null) : null),
    [data],
  );
  if (!data || !standings) return null;

  const practice = data.competition.file.resetUnit === "continuous";
  const resultsDay = SCHEDULE.find((p) => p.key === "results");
  const announced =
    resultsDay !== undefined && now >= jstDayStart(resultsDay.first);
  // By what the data is, and by the calendar only for "final": a finished matrix before the results
  // date may be a participant's own backtest rather than the live week, and even the live week's is
  // provisional until the review period ends (rules §4.7).
  const title = practice
    ? t("overview.top.practice", { n: TOP_N })
    : data.inProgress
      ? t("overview.top.soFar", { n: TOP_N })
      : announced
        ? t("overview.top.final", { n: TOP_N })
        : t("overview.top.standings", { n: TOP_N });
  const rows = standings.rows.slice(0, TOP_N);

  return (
    <Panel
      title={title}
      info={
        <>
          <TipText>
            {practice
              ? t("overview.top.tipPractice")
              : t("overview.top.tipOfficial")}
          </TipText>
          <TipText>{t("overview.top.tipScore")}</TipText>
        </>
      }
      action={{
        label: t("overview.top.all"),
        onClick: () => navigate("/standings"),
      }}
    >
      {rows.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: "14px 16px",
            font: "var(--text-sm) var(--font-sans)",
            color: "var(--text-tertiary)",
          }}
        >
          {t("overview.top.empty")}
        </p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <li
              key={row.id}
              className="row-link"
              onClick={() => navigate(`/agent/${encodeURIComponent(row.id)}`)}
              style={{
                display: "grid",
                gridTemplateColumns: "32px minmax(0, 1fr) auto",
                alignItems: "baseline",
                gap: "8px",
                padding: "10px 16px",
                borderBottom: "1px solid var(--border-subtle)",
                font: "var(--text-sm) var(--font-mono)",
              }}
            >
              <span style={{ color: "var(--text-tertiary)" }}>
                {row.rank}
                {row.tied ? "=" : ""}
              </span>
              <span
                style={{
                  color: "var(--text-link)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={row.id}
              >
                {row.id}
              </span>
              <span
                style={{
                  color: toneColor((row.score ?? 50) - 50),
                  fontWeight: "var(--weight-semibold)" as never,
                }}
              >
                {formatScore(row.score)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ---- links ----

function LinkGroup({
  title,
  body,
  links,
}: {
  title: string;
  body: string;
  links: { label: string; href: string; external?: boolean }[];
}) {
  return (
    <div
      style={{
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        minWidth: 0,
        background: "var(--bg-surface)",
      }}
    >
      <span
        style={{
          font: "var(--weight-semibold) var(--text-sm) var(--font-sans)",
          color: "var(--text-primary)",
        }}
      >
        {title}
      </span>
      <span
        style={{
          font: "var(--text-xs) var(--font-sans)",
          color: "var(--text-tertiary)",
          lineHeight: 1.55,
        }}
      >
        {body}
      </span>
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "3px",
          font: "var(--text-xs) var(--font-mono)",
          minWidth: 0,
        }}
      >
        {links.map((link) =>
          link.external === false ? (
            <a
              key={link.href}
              href={link.href}
              style={{ ...LINK, overflowWrap: "anywhere" }}
            >
              {link.label}
            </a>
          ) : (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...LINK, overflowWrap: "anywhere" }}
            >
              {link.label} ↗
            </a>
          ),
        )}
      </span>
    </div>
  );
}

function LinksPanel({ locale }: { locale: Locale }) {
  const bare = (url: string) =>
    url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <Panel title={t("overview.links.title")}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "1px",
          background: "var(--border-subtle)",
        }}
      >
        <LinkGroup
          title={t("overview.links.guide")}
          body={t("overview.links.guideBody")}
          links={[
            { label: t("overview.links.guideDoc"), href: guideUrl(locale) },
            { label: t("overview.links.repo"), href: REPO_URL },
          ]}
        />
        <LinkGroup
          title={t("overview.links.rules")}
          body={t("overview.links.rulesBody")}
          links={[
            { label: t("overview.links.rulesDoc"), href: rulesUrl(locale) },
            { label: t("overview.links.termsDoc"), href: termsUrl(locale) },
            { label: bare(SITE_URL), href: SITE_URL },
          ]}
        />
        <LinkGroup
          title={t("overview.links.discord")}
          body={t("overview.links.discordBody")}
          links={[{ label: bare(DISCORD_URL), href: DISCORD_URL }]}
        />
        <LinkGroup
          title={t("overview.links.connect")}
          body={t("overview.links.connectBody")}
          links={[
            {
              label: `RPC · ${bare(PRACTICE_RPC_URL)}`,
              href: PRACTICE_RPC_URL,
            },
            {
              label: `Explorer · ${bare(PRACTICE_EXPLORER_URL)}`,
              href: PRACTICE_EXPLORER_URL,
            },
            {
              label: t("overview.links.manifest", { path: MANIFEST_PATH }),
              href: MANIFEST_PATH,
              external: false,
            },
          ]}
        />
      </div>
    </Panel>
  );
}

export function OverviewPage() {
  const locale = useLocale();
  const now = useNow();

  return (
    <AppShell activePage="overview">
      <main
        style={{
          ...PAGE_MAIN,
          display: "flex",
          flexDirection: "column",
          gap: "18px",
        }}
      >
        <header
          style={{ display: "flex", flexDirection: "column", gap: "6px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <h1
              style={{
                margin: 0,
                font: "var(--weight-bold) 24px var(--font-sans)",
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              {t("overview.title")}
            </h1>
            <InfoTip
              label={t("overview.about")}
              title={t("overview.about")}
              width={440}
            >
              <TipText>{t("overview.aboutVenues")}</TipText>
              <TipText>{t("overview.aboutEnvironment")}</TipText>
              <TipText>{t("overview.aboutAgents")}</TipText>
            </InfoTip>
          </div>
          <p
            style={{
              margin: 0,
              font: "var(--text-sm) var(--font-sans)",
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              maxWidth: "72ch",
            }}
          >
            {t("overview.lead")}
          </p>
        </header>

        <SchedulePanel now={now} locale={locale} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
            gap: "18px",
          }}
        >
          <RuleCard
            title={t("overview.scoring.title")}
            gist={t("overview.scoring.gist")}
            facts={t("overview.scoring.facts", {
              k: SCORING.epochs,
              regimes: SCORING.regimes,
              blocks: SCORING.blocksPerEpoch,
            })}
            tip={<ScoringTip locale={locale} />}
            locale={locale}
            section="4.4"
          />
          <RuleCard
            title={t("overview.prize.title")}
            gist={t("overview.prize.gist", {
              total: formatJpyShort(PRIZE_TOTAL_JPY, locale),
              first: formatJpyShort(LEADERBOARD_PRIZES_JPY[0], locale),
            })}
            facts={t("overview.prize.facts", {
              leaderboard: formatJpyShort(LEADERBOARD_TOTAL_JPY, locale),
              report: formatJpyShort(REPORT_TOTAL_JPY, locale),
              n: LEADERBOARD_PRIZES_JPY.length,
            })}
            tip={<PrizeTip locale={locale} />}
            locale={locale}
            section="6"
          />
          <RuleCard
            title={t("overview.submission.title")}
            gist={t("overview.submission.gist", {
              n: CONSTRAINTS.submissionsPerDay,
            })}
            facts={t("overview.submission.facts", {
              ms: CONSTRAINTS.decisionTimeoutMs.toLocaleString("en-US"),
              n: CONSTRAINTS.reviseEveryBlocks,
            })}
            tip={<SubmissionTip locale={locale} />}
            locale={locale}
            section="2"
          />
        </div>

        <TopStandings now={now} />

        <LinksPanel locale={locale} />
      </main>
    </AppShell>
  );
}
