import { useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { Input } from "@/design-system/Input";
import { useExplorerSnapshot } from "@/data/useExplorerSnapshot";
import type { ExplorerBlock, ExplorerTransaction } from "@/data/types";

const SECTION_LABEL_STYLE = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={SECTION_LABEL_STYLE}>{label}</div>
      <div style={{ font: "var(--weight-semibold) var(--text-md) var(--font-mono)", color: "var(--text-primary)" }}>
        {value}
      </div>
    </div>
  );
}

function BlockRow({ block }: { block: ExplorerBlock }) {
  return (
    <div
      title="Block detail not yet available"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 18px",
        borderBottom: "1px solid var(--border-subtle)",
        cursor: "not-allowed",
      }}
    >
      <span
        style={{
          width: "32px",
          height: "32px",
          borderRadius: "var(--radius-md)",
          background: "var(--bg-surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          font: "13px var(--font-mono)",
          color: "var(--text-tertiary)",
          flexShrink: 0,
        }}
      >
        ▦
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ font: "var(--weight-semibold) var(--text-sm) var(--font-mono)", color: "var(--text-link)" }}>
          {block.number}
        </div>
        <div style={{ font: "var(--text-xs) var(--font-sans)", color: "var(--text-tertiary)" }}>{block.time}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ font: "var(--text-sm) var(--font-mono)", color: "var(--text-secondary)" }}>
          {block.txCount} tx
        </div>
      </div>
    </div>
  );
}

function TransactionRow({ tx }: { tx: ExplorerTransaction }) {
  const methodColor = tx.methodTone === "danger" ? "var(--danger-text)" : "var(--text-secondary)";
  return (
    <div
      title="Transaction detail not yet available"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 18px",
        borderBottom: "1px solid var(--border-subtle)",
        cursor: "not-allowed",
      }}
    >
      <span
        style={{
          width: "32px",
          height: "32px",
          borderRadius: "var(--radius-md)",
          background: "var(--bg-surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          font: "13px var(--font-mono)",
          color: "var(--text-tertiary)",
          flexShrink: 0,
        }}
      >
        ⧉
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ font: "var(--weight-semibold) var(--text-sm) var(--font-mono)", color: "var(--text-link)" }}>
          {tx.hash}
        </div>
        <div style={{ font: "var(--text-xs) var(--font-mono)", color: "var(--text-tertiary)" }}>
          <span style={{ color: "var(--text-secondary)" }}>{tx.agent}</span> · <span style={{ color: methodColor }}>{tx.method}</span>
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ font: "var(--text-sm) var(--font-mono)", color: "var(--text-secondary)" }}>{tx.amount}</div>
        <div style={{ font: "var(--text-xs) var(--font-mono)", color: "var(--text-tertiary)" }}>{tx.time}</div>
      </div>
    </div>
  );
}

export function ExplorerPage() {
  const { data, loading, error } = useExplorerSnapshot();
  const [search, setSearch] = useState("");

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-canvas)" }}>
        <span style={{ font: "var(--text-sm) var(--font-mono)", color: "var(--text-tertiary)" }}>Loading ASCON…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-canvas)" }}>
        <span style={{ font: "var(--text-sm) var(--font-mono)", color: "var(--danger-text)" }}>
          Failed to load data{error ? `: ${error.message}` : ""}
        </span>
      </div>
    );
  }

  const { round, stats, blocks, transactions } = data;

  return (
    <div style={{ minHeight: "100vh", display: "flex", background: "var(--bg-canvas)" }}>
      <Sidebar activePage="explorer" />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <RoundsBar round={round} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "16px",
          padding: "48px 32px 40px",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span
          style={{
            font: "var(--weight-bold) var(--text-2xl) var(--font-sans)",
            color: "var(--text-primary)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Round explorer
        </span>
        <div style={{ width: "100%", maxWidth: "680px" }}>
          <Input
            placeholder="Search by tx hash / block / agent / wallet address…"
            mono
            suffix="⌕"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div style={{ padding: "16px 32px", borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", justifyContent: "center", gap: "48px", flexWrap: "wrap", maxWidth: "900px", margin: "0 auto" }}>
          <StatTile label="Round" value={`${round.roundNumber} · ${round.status === "live" ? "Live" : "Archived"}`} />
          <StatTile label="Latest block" value={stats.latestBlockNumber} />
          <StatTile label="Tx this round" value={stats.txCountThisRound.toLocaleString("en-US")} />
          <StatTile label="Active agents" value={String(stats.activeAgents)} />
          <StatTile label="Avg block time" value={`${stats.avgBlockTimeSeconds}s`} />
        </div>
      </div>

      <main
        style={{
          maxWidth: "1240px",
          width: "100%",
          margin: "0 auto",
          padding: "28px 32px 64px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "24px",
          flex: 1,
          boxSizing: "border-box",
        }}
      >
        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 18px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <span style={{ font: "var(--weight-semibold) var(--text-base) var(--font-sans)", color: "var(--text-primary)" }}>
              Latest blocks
            </span>
          </div>
          {blocks.map((block) => (
            <BlockRow key={block.number} block={block} />
          ))}
        </div>

        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 18px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <span style={{ font: "var(--weight-semibold) var(--text-base) var(--font-sans)", color: "var(--text-primary)" }}>
              Latest transactions
            </span>
          </div>
          {transactions.map((tx) => (
            <TransactionRow key={tx.hash} tx={tx} />
          ))}
        </div>
      </main>
      </div>
    </div>
  );
}
