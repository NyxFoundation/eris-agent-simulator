import { navigate } from "@/navigation";

export type SidebarNavKey = "home" | "leaderboard" | "explorer" | "markets";

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
        <div style={{ padding: "var(--space-4)", borderTop: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: "7px" }}>
          <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--pink-500)", flexShrink: 0 }} />
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

      <div
        style={{
          marginTop: "auto",
          padding: "var(--space-4)",
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        <span style={{ font: "var(--text-xs) var(--font-mono)", color: "var(--text-tertiary)", letterSpacing: "var(--tracking-wide)" }}>
          OBSERVER
        </span>
        <span style={{ font: "var(--text-xs) var(--font-mono)", color: "var(--text-disabled)" }}>no login required</span>
      </div>
    </div>
  );
}
