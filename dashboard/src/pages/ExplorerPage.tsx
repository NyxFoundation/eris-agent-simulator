// /explorer — the round explorer.
//
// Two things it owes the reader. First, it is scoped to a *round* (a scoring epoch) when one is
// selected in the rounds bar, so "what happened in round 4" is a block window, not a whole run.
// Second, it is a front door to the local Blockscout instance rather than a dead end: the
// connection state is visible, search resolves a hash / block / address / agent name into a real
// deep link, and when the explorer is down the page says so and still filters what it holds itself.
import { useMemo, useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { Input } from "@/design-system/Input";
import { Select } from "@/design-system/Select";
import {
  blockscoutAddressUrl,
  blockscoutBlockUrl,
  blockscoutTxUrl,
  classifySearch,
  searchTargetUrl,
  useBlockscoutStatus,
  useIndexedTxProbe,
} from "@/data/blockscout";
import { setSelectedRound, useSelectedRound } from "@/data/roundSelection";
import { useExplorerSnapshot } from "@/data/useExplorerSnapshot";
import type { ExplorerBlock, ExplorerTransaction } from "@/data/types";

const SECTION_LABEL_STYLE = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

const SEARCH_HINT: Record<string, string> = {
  tx: "transaction hash",
  address: "wallet address",
  block: "block number",
  agent: "agent → wallet address",
  unknown: "no exact match — filtering the lists below",
};

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={SECTION_LABEL_STYLE}>{label}</div>
      <div
        style={{
          font: "var(--weight-semibold) var(--text-md) var(--font-mono)",
          color: "var(--text-primary)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function BlockRow({ block, href }: { block: ExplorerBlock; href?: string }) {
  return (
    <div
      title={
        href
          ? "Open block in Blockscout"
          : "start `npm run explorer` to open blocks"
      }
      onClick={href ? () => window.open(href, "_blank", "noopener") : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 18px",
        borderBottom: "1px solid var(--border-subtle)",
        cursor: href ? "pointer" : "default",
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
        <div
          style={{
            font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
            color: href ? "var(--text-link)" : "var(--text-primary)",
          }}
        >
          {block.number}
        </div>
        <div
          style={{
            font: "var(--text-xs) var(--font-sans)",
            color: "var(--text-tertiary)",
          }}
        >
          {block.time}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div
          style={{
            font: "var(--text-sm) var(--font-mono)",
            color: "var(--text-secondary)",
          }}
        >
          {block.txCount} tx
        </div>
      </div>
    </div>
  );
}

function TransactionRow({
  tx,
  href,
  addressHref,
}: {
  tx: ExplorerTransaction;
  href?: string;
  addressHref?: string;
}) {
  const methodColor =
    tx.methodTone === "danger" ? "var(--danger-text)" : "var(--text-secondary)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 18px",
        borderBottom: "1px solid var(--border-subtle)",
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
        <div
          style={{
            font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
            color: href ? "var(--text-link)" : "var(--text-primary)",
          }}
        >
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title="Open transaction in Blockscout"
              style={{ color: "inherit", textDecoration: "none" }}
            >
              {tx.hash}
            </a>
          ) : (
            tx.hash
          )}
        </div>
        <div
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          {addressHref ? (
            <a
              href={addressHref}
              target="_blank"
              rel="noopener noreferrer"
              title="Open sender in Blockscout"
              style={{ color: "var(--text-link)", textDecoration: "none" }}
            >
              {tx.agent}
            </a>
          ) : (
            <span style={{ color: "var(--text-secondary)" }}>{tx.agent}</span>
          )}{" "}
          · <span style={{ color: methodColor }}>{tx.method}</span>
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div
          style={{
            font: "var(--text-sm) var(--font-mono)",
            color: "var(--text-secondary)",
          }}
        >
          {tx.amount}
        </div>
        <div
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          {tx.time}
        </div>
      </div>
    </div>
  );
}

function CenteredMessage({ text, tone }: { text: string; tone?: "danger" }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-canvas)",
      }}
    >
      <span
        style={{
          font: "var(--text-sm) var(--font-mono)",
          color:
            tone === "danger" ? "var(--danger-text)" : "var(--text-tertiary)",
        }}
      >
        {text}
      </span>
    </div>
  );
}

export function ExplorerPage() {
  const { data, loading, error } = useExplorerSnapshot();
  const blockscout = useBlockscoutStatus();
  const selectedRound = useSelectedRound();
  const [search, setSearch] = useState("");

  const target = useMemo(
    () => classifySearch(search, data?.agents ?? []),
    [search, data?.agents],
  );

  const term = search.trim().toLowerCase();
  // Only a block-shaped term filters the block list. An agent name or a tx hash says nothing about
  // which blocks to keep, and emptying the list over it would read as "this round has no blocks".
  const blocks = useMemo(() => {
    if (!data) return [];
    const digits = term.replace(/,/g, "");
    if (!digits || !/^\d+$/.test(digits)) return data.blocks;
    return data.blocks.filter((b) =>
      b.number.replace(/,/g, "").includes(digits),
    );
  }, [data, term]);
  const transactions = useMemo(() => {
    if (!data) return [];
    if (!term) return data.transactions;
    return data.transactions.filter((tx) =>
      [tx.fullHash, tx.agent, tx.method, tx.fullAddress, tx.time]
        .filter((v): v is string => typeof v === "string")
        .some((v) => v.toLowerCase().includes(term)),
    );
  }, [data, term]);

  // Whether the deep links work is answered by asking the indexer for one of this run's own
  // transactions, not by comparing heights: an indexer that never followed the chain rewind can sit
  // at a plausible height holding a previous run's blocks, and a healthy one routinely sits a few
  // blocks past the run's last scored block because the environment's teardown keeps mining.
  const indexedProbe = useIndexedTxProbe(
    blockscout.base,
    data?.transactions.find((tx) => tx.fullHash)?.fullHash,
  );

  if (loading) return <CenteredMessage text="Loading Eris…" />;
  if (error || !data)
    return (
      <CenteredMessage
        text={`Failed to load data${error ? `: ${error.message}` : ""}`}
        tone="danger"
      />
    );

  const { round, scope, stats } = data;
  const base = blockscout.base;

  const indexerNote = ((): string | null => {
    if (indexedProbe === "missing")
      return "this run's transactions are not indexed — the indexer is holding a different chain; run `npm run explorer:reset`";
    // Live: the gap between the chain and the indexer is genuine lag, and worth seeing.
    if (round.status === "live" && blockscout.indexedHeight !== null) {
      const behind = round.blockNumber - blockscout.indexedHeight;
      return behind > 1 ? `${behind} blocks behind the chain` : null;
    }
    return null;
  })();
  const targetUrl = base ? searchTargetUrl(base, target) : null;
  const openTarget = () => {
    if (targetUrl) window.open(targetUrl, "_blank", "noopener");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        background: "var(--bg-canvas)",
      }}
    >
      <Sidebar activePage="explorer" />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <RoundsBar round={round} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "14px",
            padding: "36px 32px 28px",
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

          {/* Connection state. The dashboard reads run artifacts; Blockscout indexes the same
              anvil and is the deep-dive tool — when it is down that is a fact about the tooling,
              not about the run, so it is stated rather than hidden. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              font: "var(--text-xs) var(--font-mono)",
              color: base ? "var(--success-text)" : "var(--text-tertiary)",
            }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: base
                  ? "var(--success)"
                  : blockscout.probed
                    ? "var(--danger)"
                    : "var(--text-disabled)",
              }}
            />
            {base ? (
              <>
                <a
                  href={base}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--text-link)", textDecoration: "none" }}
                >
                  Blockscout connected
                </a>
                <span style={{ color: "var(--text-tertiary)" }}>
                  indexed block{" "}
                  {blockscout.indexedHeight?.toLocaleString("en-US") ?? "—"}
                  {blockscout.indexedPercent !== null &&
                    blockscout.indexedPercent < 100 &&
                    ` · ${blockscout.indexedPercent.toFixed(1)}% indexed`}
                </span>
                {indexerNote && (
                  <span style={{ color: "var(--warning)" }}>{indexerNote}</span>
                )}
              </>
            ) : blockscout.probed ? (
              <span>
                Blockscout offline — run <code>npm run explorer</code> to open
                transactions, blocks and addresses here (and{" "}
                <code>npm run explorer:reset</code> after a chain reset)
              </span>
            ) : (
              <span>probing the local explorer…</span>
            )}
          </div>

          <div
            style={{
              width: "100%",
              maxWidth: "680px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            <Input
              placeholder="Search by tx hash / block / agent / wallet address…"
              mono
              suffix="⌕"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") openTarget();
              }}
            />
            {search.trim() && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                <span>
                  {SEARCH_HINT[target.kind]}
                  {target.agentId ? ` · ${target.value}` : ""}
                </span>
                <span style={{ marginLeft: "auto" }}>
                  {targetUrl ? (
                    <span
                      onClick={openTarget}
                      style={{
                        color: "var(--text-link)",
                        cursor: "pointer",
                      }}
                    >
                      open in Blockscout ↗ (enter)
                    </span>
                  ) : (
                    <span>
                      {blockscout.probed
                        ? "explorer offline — showing local matches only"
                        : "…"}
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Round scope: the explorer's window. Selecting a round here and clicking a segment in
            the rounds bar are the same action. */}
        <div
          style={{
            padding: "12px 32px",
            borderBottom: "1px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <span style={SECTION_LABEL_STYLE}>Scope</span>
          <Select
            value={selectedRound === null ? "all" : String(selectedRound)}
            options={[
              {
                label: `Whole run (${round.epochs.length} rounds)`,
                value: "all",
              },
              ...round.epochs.map((e) => ({
                label: `Round ${String(e.index).padStart(2, "0")} · blk ${e.fromBlock.toLocaleString("en-US")}–${e.toBlock.toLocaleString("en-US")}`,
                value: String(e.index),
              })),
            ]}
            onChange={(e) =>
              setSelectedRound(
                e.target.value === "all" ? null : Number(e.target.value),
              )
            }
            style={{ minWidth: "300px" }}
          />
          <span
            style={{
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-tertiary)",
            }}
          >
            {scope.roundIndex === null
              ? `blocks ${scope.fromBlock.toLocaleString("en-US")}–${scope.toBlock.toLocaleString("en-US")}`
              : `round ${scope.roundIndex} · blocks ${scope.fromBlock.toLocaleString("en-US")}–${scope.toBlock.toLocaleString("en-US")}`}
          </span>
        </div>

        <div
          style={{
            padding: "16px 32px",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "48px",
              flexWrap: "wrap",
              maxWidth: "900px",
              margin: "0 auto",
            }}
          >
            <StatTile
              label="Run"
              value={`${round.runNumber} · ${round.status === "live" ? "Live" : "Archived"}`}
            />
            <StatTile label="Latest block" value={stats.latestBlockNumber} />
            {stats.indexerBlockNumber !== undefined && (
              <StatTile
                label="Indexed block"
                value={stats.indexerBlockNumber}
              />
            )}
            <StatTile
              label={
                scope.roundIndex === null ? "Tx this run" : "Tx this round"
              }
              // null = the live view does not hold this round's blocks; "0" would be a claim.
              value={
                stats.txCountThisRound === null
                  ? "—"
                  : stats.txCountThisRound.toLocaleString("en-US")
              }
            />
            <StatTile
              label="Active agents"
              value={String(stats.activeAgents)}
            />
            <StatTile
              label="Avg block time"
              value={`${stats.avgBlockTimeSeconds}s`}
            />
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
          <div
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                padding: "14px 18px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <span
                style={{
                  font: "var(--weight-semibold) var(--text-base) var(--font-sans)",
                  color: "var(--text-primary)",
                }}
              >
                Blocks
              </span>
              <span
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                {blocks.length} shown
              </span>
            </div>
            {blocks.length === 0 && (
              <div
                style={{
                  padding: "16px 18px",
                  font: "var(--text-sm) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                no block in this scope matches
              </div>
            )}
            {blocks.map((block) => (
              <BlockRow
                key={block.number}
                block={block}
                href={
                  base && block.blockNumber !== undefined
                    ? blockscoutBlockUrl(base, block.blockNumber)
                    : undefined
                }
              />
            ))}
          </div>

          <div
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                padding: "14px 18px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <span
                style={{
                  font: "var(--weight-semibold) var(--text-base) var(--font-sans)",
                  color: "var(--text-primary)",
                }}
              >
                Transactions
              </span>
              <span
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                {transactions.length} shown
              </span>
            </div>
            {transactions.length === 0 && (
              <div
                style={{
                  padding: "16px 18px",
                  font: "var(--text-sm) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                no transaction in this scope matches
              </div>
            )}
            {transactions.map((tx) => (
              <TransactionRow
                key={tx.fullHash ?? tx.hash}
                tx={tx}
                href={
                  base && tx.fullHash
                    ? blockscoutTxUrl(base, tx.fullHash)
                    : undefined
                }
                addressHref={
                  base && tx.fullAddress
                    ? blockscoutAddressUrl(base, tx.fullAddress)
                    : undefined
                }
              />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
