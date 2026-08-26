import { useEffect, useState } from "react";
import { isSeedProvider } from "@/data/provider";
import { listRuns, type RunIndexEntry } from "@/data/runArtifacts";
import { setSelectedRunId, useSelectedRunId } from "@/data/runSelection";
import { Select } from "@/design-system/Select";
import { navigate } from "@/navigation";

export type SidebarNavKey = "home" | "leaderboard" | "explorer" | "markets";

/**
 * Run picker (issue #63 Phase 1): every view renders one run from runs/<id>/,
 * newest by default. Re-polled so a run that starts (live) or completes while
 * the page is open appears without a reload. Hidden in seed-provider mode
 * where there is nothing to pick.
 */
const RUN_LIST_POLL_MS = 10_000;

function RunPicker() {
  const selected = useSelectedRunId();
  const [runs, setRuns] = useState<RunIndexEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listRuns()
        .then((entries) => {
          if (!cancelled) setRuns(entries);
        })
        .catch(() => {
          if (!cancelled) setRuns((prev) => prev ?? []);
        });
    };
    load();
    const timer = window.setInterval(load, RUN_LIST_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!runs || runs.length === 0) return null;
  const value =
    selected && runs.some((r) => r.id === selected) ? selected : runs[0].id;
  const liveSelected = runs.find((r) => r.id === value)?.live ?? false;

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
          color: liveSelected ? "var(--pink-300)" : "var(--text-tertiary)",
          letterSpacing: "var(--tracking-wide)",
        }}
      >
        {liveSelected ? "RUN · LIVE" : "RUN"}
      </span>
      <Select
        value={value}
        options={runs.map((r) => ({
          label: r.live ? `● ${r.id} (live)` : r.id,
          value: r.id,
        }))}
        onChange={(e) => setSelectedRunId(e.target.value)}
        style={{ width: "100%" }}
      />
    </div>
  );
}

const SIDEBAR_NAV: { key: SidebarNavKey; label: string; path: string }[] = [
  { key: "home", label: "Top", path: "/" },
  { key: "leaderboard", label: "Leaderboard", path: "/leaderboard" },
  { key: "explorer", label: "Explorer", path: "/explorer" },
  { key: "markets", label: "Markets", path: "/markets" },
];

export function Sidebar({
  activePage,
  roundNumber,
  roundStatus,
}: {
  activePage?: SidebarNavKey;
  roundNumber?: number;
  roundStatus?: string;
}) {
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
          A
        </span>
        <span
          style={{
            font: "var(--weight-bold) var(--text-base) var(--font-sans)",
            letterSpacing: "var(--tracking-tight)",
            textTransform: "uppercase",
          }}
        >
          Ascon
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {SIDEBAR_NAV.map((item) => {
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

      {roundNumber !== undefined && (
        <div
          style={{
            padding: "var(--space-4)",
            borderTop: "1px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            gap: "7px",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "var(--pink-500)",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
              letterSpacing: "var(--tracking-wide)",
              color: "var(--text-secondary)",
              textTransform: "uppercase",
            }}
          >
            Round {roundNumber} · {roundStatus}
          </span>
        </div>
      )}

      <div style={{ marginTop: "auto" }}>
        {!isSeedProvider && <RunPicker />}
      </div>

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
            color: "var(--text-tertiary)",
            letterSpacing: "var(--tracking-wide)",
          }}
        >
          OBSERVER
        </span>
        <span
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-disabled)",
          }}
        >
          no login required
        </span>
      </div>
    </div>
  );
}
