import { useEffect, useMemo, useState } from "react";
import { competitionLabel, loadCompetition, runDisplayName, scenarioLabel, scenarioRunId } from "@/data/competition";
import {
  resolveCompetitionId,
  setSelectedCompetitionId,
  SINGLE_RUNS,
} from "@/data/competitionSelection";
import { isSeedProvider } from "@/data/provider";
import {
  competitionEntries,
  listRuns,
  runEntries,
  type RunIndexEntry,
} from "@/data/runArtifacts";
import { setSelectedRound } from "@/data/roundSelection";
import { setSelectedRunId, useSelectedRunId } from "@/data/runSelection";
import { Select } from "@/design-system/Select";
import { setLocale, useLocale, type Locale } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { navigate } from "@/navigation";

export type SidebarNavKey = "home" | "scenario" | "explorer" | "markets";

/**
 * Two-level picker: competition, then scenario (one world inside it).
 *
 * Both levels show names, not storage ids: a competition is its scenario set and date
 * ("full-8h · 8/29"), a scenario is what it is a draw of ("calm#101"). The raw directory id stays
 * one hover away in the option title.
 *
 * "— single run —" is not a second mode. It makes the selected run the outer unit, which the home
 * reads as a competition of one scenario — same standings, same round cursor.
 *
 * Re-polled so a run that starts (live) or completes while the page is open appears without a
 * reload. Hidden in seed-provider mode where there is nothing to pick.
 */
const RUN_LIST_POLL_MS = 10_000;

/** A run collected from a remote box has a nested id (`<collection>/runs/<id>`); show the run's own
 * name with where it came from, rather than the raw path. */
function runLabel(id: string): string {
  const parts = id.split("/");
  if (parts.length === 1) return runDisplayName(id);
  return `${runDisplayName(id)}  ← ${parts[0]}`;
}

/** "full-calm#101" -> "calm#101": with every scenario in the same set, the prefix carries nothing. */
function shortScenario(name: string): string {
  return name.replace(/^full-/, "");
}

const SINGLE_RUNS_OPTION = " single";

function PickerBlock({
  label,
  labelColor,
  children,
}: {
  label: string;
  labelColor?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        borderTop: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      }}
    >
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: labelColor ?? "var(--text-tertiary)",
          letterSpacing: "var(--tracking-wide)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Picker() {
  const selectedRun = useSelectedRunId();
  const locale = useLocale();
  const [entries, setEntries] = useState<RunIndexEntry[] | null>(null);
  // competition id -> display label ("full-8h · 8/29").
  const [competitionNames, setCompetitionNames] = useState<Map<string, string>>(
    new Map(),
  );
  // run id -> "regime#seed". A scenario's own name is what it is a draw of, not when it was written.
  const [scenarioNames, setScenarioNames] = useState<Map<
    string,
    string
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listRuns()
        .then((list) => {
          if (!cancelled) setEntries(list);
        })
        .catch(() => {
          if (!cancelled) setEntries((prev) => prev ?? []);
        });
    };
    load();
    const timer = window.setInterval(load, RUN_LIST_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const competitions = useMemo(
    () => (entries ? competitionEntries(entries) : []),
    [entries],
  );
  const runs = useMemo(() => (entries ? runEntries(entries) : []), [entries]);

  // Resolve each listed competition's display name (cached loads; the id stays the fallback).
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      competitions.map(async (entry) => {
        try {
          const c = await loadCompetition(entry.id);
          return [entry.id, competitionLabel(c, locale)] as const;
        } catch {
          return [entry.id, entry.id] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setCompetitionNames(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [competitions, locale]);

  // Same resolution the standings loader and the scenario title use, so all three agree on which
  // competition is in view when nothing has been picked yet.
  const competitionValue = entries ? resolveCompetitionId(entries) : null;

  // Restrict the scenario list to the chosen competition. Its scenarios are sibling run dirs, so
  // the mapping goes through the competition's own path prefix rather than the stored
  // (machine-relative) one.
  useEffect(() => {
    let cancelled = false;
    if (!competitionValue) {
      setScenarioNames(null);
      return;
    }
    loadCompetition(competitionValue)
      .then((m) => {
        if (cancelled) return;
        setScenarioNames(
          new Map(
            m.file.scenarios.map((s) => [
              scenarioRunId(m.id, s.runDir),
              shortScenario(scenarioLabel(s)),
            ]),
          ),
        );
      })
      .catch(() => {
        // An unreadable competition falls back to the full run list rather than an empty picker.
        if (!cancelled) setScenarioNames(null);
      });
    return () => {
      cancelled = true;
    };
  }, [competitionValue]);

  const inCompetition = competitionValue !== null && scenarioNames !== null;
  const visibleRuns = inCompetition
    ? runs.filter((r) => scenarioNames.has(r.id))
    : runs;
  // A live run is never part of a stored competition, and watching one is the whole point of live
  // mode.
  const liveRuns = runs.filter(
    (r) => r.live && !visibleRuns.some((v) => v.id === r.id),
  );
  const options = [...liveRuns, ...visibleRuns];

  const runValue =
    selectedRun && options.some((r) => r.id === selectedRun)
      ? selectedRun
      : (options[0]?.id ?? "");
  const liveSelected = options.find((r) => r.id === runValue)?.live ?? false;

  // Write the resolved default back, so "what is displayed" and "what is selected" stay the same
  // statement for every consumer.
  useEffect(() => {
    if (runValue && runValue !== selectedRun) setSelectedRunId(runValue);
  }, [runValue, selectedRun]);

  if (!entries || entries.length === 0) return null;

  return (
    <>
      {competitions.length > 0 && (
        <PickerBlock label={t("sidebar.competition")}>
          <Select
            value={competitionValue ?? SINGLE_RUNS_OPTION}
            options={[
              ...competitions.map((m) => ({
                label: competitionNames.get(m.id) ?? m.id,
                value: m.id,
                title: m.id,
              })),
              { label: t("sidebar.singleRun"), value: SINGLE_RUNS_OPTION },
            ]}
            onChange={(e) => {
              const picked = e.target.value;
              setSelectedRound(null);
              setSelectedCompetitionId(
                picked === SINGLE_RUNS_OPTION ? SINGLE_RUNS : picked,
              );
              // Point the scenario selection inside the new competition, so the run-level pages
              // are not left showing a world that belongs to a different competition.
              if (picked !== SINGLE_RUNS_OPTION) {
                loadCompetition(picked)
                  .then((m) => {
                    const first = m.file.scenarios[0];
                    if (first)
                      setSelectedRunId(scenarioRunId(m.id, first.runDir));
                  })
                  .catch(() => {
                    /* keep the current scenario rather than clearing it */
                  });
              }
            }}
            style={{ width: "100%" }}
          />
        </PickerBlock>
      )}
      {options.length > 0 && (
        <PickerBlock
          label={
            liveSelected ? t("sidebar.scenarioLive") : t("sidebar.scenario")
          }
          labelColor={liveSelected ? "var(--pink-300)" : undefined}
        >
          <Select
            value={runValue}
            options={options.map((r) => ({
              label: `${r.live ? "● " : ""}${scenarioNames?.get(r.id) ?? runLabel(r.id)}${r.live ? ` (${t("common.live")})` : ""}`,
              value: r.id,
              title: r.id,
            }))}
            onChange={(e) => {
              // A round index only means something inside one run; carrying it across would scope
              // the next run's explorer to a block window that belongs to nothing.
              setSelectedRound(null);
              setSelectedRunId(e.target.value);
            }}
            style={{ width: "100%" }}
          />
        </PickerBlock>
      )}
    </>
  );
}

function LanguageToggle() {
  const locale = useLocale();
  const options: { value: Locale; label: string }[] = [
    { value: "en", label: "EN" },
    { value: "ja", label: "日本語" },
  ];
  return (
    <div style={{ display: "flex", gap: "4px" }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => setLocale(o.value)}
          style={{
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            background:
              o.value === locale ? "var(--bg-surface-raised)" : "transparent",
            color:
              o.value === locale
                ? "var(--text-primary)"
                : "var(--text-tertiary)",
            font: "var(--text-xs) var(--font-mono)",
            padding: "3px 9px",
            cursor: "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Sidebar({ activePage }: { activePage?: SidebarNavKey }) {
  // Read so the whole sidebar re-renders (nav labels, picker labels) when the language changes.
  useLocale();

  // In seed-provider mode there are no competitions, so "/" renders the scenario view.
  const nav: { key: SidebarNavKey; label: string; path: string }[] =
    isSeedProvider
      ? [
          { key: "home", label: t("nav.top"), path: "/" },
          { key: "explorer", label: t("nav.explorer"), path: "/explorer" },
          { key: "markets", label: t("nav.markets"), path: "/markets" },
        ]
      : [
          { key: "home", label: t("nav.standings"), path: "/" },
          { key: "scenario", label: t("nav.scenario"), path: "/scenario" },
          { key: "markets", label: t("nav.markets"), path: "/markets" },
          { key: "explorer", label: t("nav.explorer"), path: "/explorer" },
        ];

  return (
    <div
      style={{
        width: "212px",
        flexShrink: 0,
        borderRight: "1px solid var(--border-subtle)",
        background: "var(--bg-sunken)",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        top: 0,
        alignSelf: "flex-start",
        height: "100vh",
      }}
    >
      <div
        style={{
          height: "76px",
          flexShrink: 0,
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          padding: "0 var(--space-4)",
          gap: "10px",
          cursor: "pointer",
        }}
        onClick={() => navigate("/")}
      >
        <span
          style={{
            width: "26px",
            height: "26px",
            borderRadius: "7px",
            background: "var(--accent-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-on-accent)",
            font: "var(--weight-bold) 13px var(--font-sans)",
          }}
        >
          E
        </span>
        <span
          style={{
            font: "var(--weight-bold) var(--text-base) var(--font-sans)",
            letterSpacing: "var(--tracking-tight)",
            textTransform: "uppercase",
          }}
        >
          Eris
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {nav.map((item) => {
          const isActive = item.key === activePage;
          return (
            <div
              key={item.path}
              onClick={isActive ? undefined : () => navigate(item.path)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                height: "52px",
                padding: "0 var(--space-4)",
                background: isActive ? "var(--pink-500)" : "transparent",
                borderBottom: "1px solid var(--border-subtle)",
                borderLeft: `3px solid ${isActive ? "var(--gray-950)" : "transparent"}`,
                color: isActive ? "var(--gray-950)" : "var(--text-secondary)",
                font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
                letterSpacing: "var(--tracking-widest)",
                textTransform: "uppercase",
                cursor: isActive ? "default" : "pointer",
              }}
            >
              <span>{item.label}</span>
              {isActive && <span>/</span>}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: "auto" }}>{!isSeedProvider && <Picker />}</div>

      <div
        style={{
          padding: "var(--space-4)",
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <LanguageToggle />
        <span
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-disabled)",
          }}
        >
          {t("sidebar.readOnly")} · {t("sidebar.noSignIn")}
        </span>
      </div>
    </div>
  );
}
