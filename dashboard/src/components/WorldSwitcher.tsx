// "Change" beside the world's name in the interval bar, on the scenario-level pages (scenario,
// markets, explorer, agent): which world is on screen, where it sits among the competition's worlds,
// and the list to step to a sibling. It used to be a block in the sidebar (issue #183); the
// sidebar is gone, and the bar is where every one of those pages already names its world.
//
// Rows come from the same builder as the standings page's scenario list, so the two agree on who
// leads and what the environment scheduled. Outside a competition (single runs) the list is the
// runs themselves.
//
// It also keeps the run selection inside the competition in view: a run chosen on an earlier visit,
// or in another competition, is replaced by the first world of this one -- so "what is displayed"
// and "what is selected" stay the same statement for every page.

import { useEffect, useMemo, useRef, useState } from "react";
import { runLabel } from "@/components/CompetitionPicker";
import { toneColor } from "@/components/competitionUi";
import {
  isHiddenScenario,
  loadCompetition,
  scenarioLabel,
  scenarioRunId,
} from "@/data/competition";
import { resolveCompetitionId } from "@/data/competitionSelection";
import { useMode } from "@/data/mode";
import { useCursor } from "@/data/roundCursor";
import { setSelectedRound } from "@/data/roundSelection";
import { runEntries } from "@/data/runArtifacts";
import { setSelectedRunId, useSelectedRunId } from "@/data/runSelection";
import { buildScenarioList } from "@/data/scenarioList";
import { useCompetitionSnapshot } from "@/data/useCompetitionSnapshot";
import { useRunIndex } from "@/data/useRunIndex";
import { t } from "@/i18n/messages";
import { formatPnlUsdc } from "@/lib/format";

export function WorldSwitcher() {
  const entries = useRunIndex();
  const selectedRun = useSelectedRunId();
  const mode = useMode();
  const cursor = useCursor();
  const { data } = useCompetitionSnapshot();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The competition in view and its worlds: run id -> "regime#seed", in the competition's own order.
  // `names` is null when it could not be read. Kept with the id it belongs to, so a switch of
  // competition is never answered with the previous one's names.
  const [loaded, setLoaded] = useState<{
    id: string;
    names: Map<string, string> | null;
  } | null>(null);

  const competitionValue = entries ? resolveCompetitionId(entries) : null;
  const competitionMtime =
    entries?.find((e) => e.id === competitionValue)?.mtimeMs ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!competitionValue) {
      setLoaded(null);
      return;
    }
    loadCompetition(competitionValue, { mtimeMs: competitionMtime })
      .then((m) => {
        if (cancelled) return;
        setLoaded({
          id: competitionValue,
          names: new Map(
            // An epoch the runner never ran has no directory and so no run to name.
            m.file.scenarios.flatMap((s) =>
              typeof s.runDir === "string"
                ? [
                    [
                      scenarioRunId(m.id, s.runDir),
                      scenarioLabel(s).replace(/^full-/, ""),
                    ] as const,
                  ]
                : [],
            ),
          ),
        });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: competitionValue, names: null });
      });
    return () => {
      cancelled = true;
    };
  }, [competitionValue, competitionMtime, mode.audience]);

  const runs = useMemo(() => (entries ? runEntries(entries) : []), [entries]);
  // Settled: outside a competition, or the competition's own worlds are known (or unreadable).
  const settled =
    entries !== null &&
    (competitionValue === null || loaded?.id === competitionValue);
  const scenarioNames =
    loaded && loaded.id === competitionValue ? loaded.names : null;
  const inCompetition = competitionValue !== null && scenarioNames !== null;
  // In the competition's own order, not the index's (newest first).
  const visibleRuns = inCompetition
    ? [...scenarioNames.keys()].flatMap((id) => {
        const run = runs.find((r) => r.id === id);
        return run ? [run] : [];
      })
    : runs;
  // A live run is never part of a stored competition, and watching one is the whole point of live
  // mode.
  const liveOutside = runs.filter(
    (r) => r.live && !visibleRuns.some((v) => v.id === r.id),
  );
  const options = [...liveOutside, ...visibleRuns];
  // A selection that is not among them (chosen on an earlier visit, or in another competition)
  // falls back to the competition's first world; a live run outside it only when there is none.
  const runValue =
    selectedRun && options.some((r) => r.id === selectedRun)
      ? selectedRun
      : (visibleRuns[0]?.id ?? liveOutside[0]?.id ?? "");

  useEffect(() => {
    // Not before the competition's worlds are known: a guess made against the whole index would be
    // written, then overwritten, and every page would load a world twice.
    if (!settled) return;
    if (runValue && runValue !== selectedRun) setSelectedRunId(runValue);
  }, [settled, runValue, selectedRun]);

  const rows = useMemo(
    () =>
      data && inCompetition
        ? buildScenarioList(
            data.competition,
            data.rounds,
            data.schedules,
            cursor.round,
          )
        : [],
    [data, inCompetition, cursor.round],
  );

  // Open on the world in view, not at the top of a 35-row list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choices = inCompetition
    ? rows.length + liveOutside.length
    : options.length;
  if (!entries || choices < 2) return null;

  const index = rows.findIndex((r) => r.runId === runValue);
  const current = index >= 0 ? rows[index] : null;
  const pick = (runId: string) => {
    setSelectedRound(null);
    setSelectedRunId(runId);
    setOpen(false);
  };
  const line: React.CSSProperties = {
    font: "var(--text-xs) var(--font-mono)",
    color: "var(--text-tertiary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textTransform: "none",
    letterSpacing: "normal",
  };

  return (
    <span
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "pointer",
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-link)",
          letterSpacing: "normal",
          textTransform: "none",
          whiteSpace: "nowrap",
        }}
      >
        {open ? t("picker.close") : `${t("picker.change")} ▾`}
      </button>
      {open && (
        <div
          ref={listRef}
          role="dialog"
          aria-label={t("picker.world")}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 45,
            width: "min(420px, calc(100vw - 32px))",
            maxHeight: "60vh",
            overflowY: "auto",
            background: "var(--bg-surface-raised)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            textAlign: "left",
          }}
        >
          {current && (
            <div
              style={{
                padding: "10px var(--space-4)",
                display: "flex",
                flexDirection: "column",
                gap: "3px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <span style={line}>
                {t("picker.worldOf", { i: index + 1, n: rows.length })}
                {" · "}
                {t("picker.worldRounds", { n: current.rounds })}
                {current.ended ? ` · ${t("home.scenarios.ended")}` : ""}
              </span>
              {mode.standings && current.leader && (
                <span style={line}>
                  {t("picker.worldLeader", { id: current.leader.id })}{" "}
                  <span style={{ color: toneColor(current.leader.pnlUsdc) }}>
                    {formatPnlUsdc(current.leader.pnlUsdc)}
                  </span>
                </span>
              )}
              <span style={line}>
                {isHiddenScenario(current)
                  ? t("home.scenarios.eventsWithheld")
                  : current.events.length > 0
                    ? t("picker.worldEvents", {
                        list: current.events.join(", "),
                      })
                    : t("picker.worldNoEvents")}
              </span>
            </div>
          )}
          {liveOutside.map((r) => (
            <WorldRow
              key={r.id}
              current={r.id === runValue}
              name={`● ${runLabel(r.id)}`}
              detail={t("common.live")}
              onPick={() => pick(r.id)}
            />
          ))}
          {inCompetition
            ? rows.map((r) => (
                <WorldRow
                  key={r.key}
                  current={r.runId !== null && r.runId === runValue}
                  name={r.label}
                  leader={mode.standings ? r.leader?.id : undefined}
                  detail={
                    // An epoch that never ran has no world to step into, and says why instead.
                    r.runId === null
                      ? t("home.scenarios.failed", {
                          reason: r.error ?? t("home.scenarios.noLeader"),
                        })
                      : [
                          t("picker.worldRounds", { n: r.rounds }),
                          isHiddenScenario(r)
                            ? t("home.scenarios.eventsWithheld")
                            : r.events.length > 0
                              ? r.events.join(", ")
                              : t("picker.worldNoEvents"),
                        ].join(" · ")
                  }
                  onPick={r.runId === null ? undefined : () => pick(r.runId!)}
                />
              ))
            : visibleRuns.map((r) => (
                <WorldRow
                  key={r.id}
                  current={r.id === runValue}
                  name={runLabel(r.id)}
                  detail={r.live ? t("common.live") : t("common.finished")}
                  onPick={() => pick(r.id)}
                />
              ))}
        </div>
      )}
    </span>
  );
}

function WorldRow({
  current,
  name,
  leader,
  detail,
  onPick,
}: {
  current: boolean;
  name: string;
  leader?: string;
  detail: string;
  /** Absent for a row with nothing to open (an epoch that never ran). */
  onPick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!onPick}
      className={onPick ? "row-link" : undefined}
      onClick={onPick}
      aria-current={current ? "true" : undefined}
      style={{
        width: "100%",
        textAlign: "left",
        border: "none",
        background: current
          ? "color-mix(in oklch, var(--pink-500) 14%, transparent)"
          : "transparent",
        boxShadow: current ? "inset 2px 0 0 var(--pink-500)" : "none",
        padding: "7px var(--space-4)",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "1px 8px",
        borderBottom: "1px solid var(--border-subtle)",
        font: "var(--text-xs) var(--font-mono)",
        letterSpacing: "normal",
        textTransform: "none",
        cursor: onPick ? "pointer" : "default",
      }}
    >
      <span
        style={{
          color: onPick ? "var(--text-link)" : "var(--text-disabled)",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {name}
      </span>
      <span style={{ color: "var(--text-secondary)" }}>{leader ?? ""}</span>
      <span
        style={{
          gridColumn: "1 / -1",
          color: "var(--text-tertiary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {detail}
      </span>
    </button>
  );
}
