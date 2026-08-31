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
import { runDisplayName } from "@/data/competition";
import { useExplorerSnapshot } from "@/data/useExplorerSnapshot";
import { useScenarioLabel } from "@/data/useScenarioLabel";
import { t } from "@/i18n/messages";
import type { ExplorerBlock, ExplorerTransaction } from "@/data/types";

const SECTION_LABEL_STYLE = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

const searchHint = (kind: string): string => {
  switch (kind) {
    case "tx":
      return t("explorer.hint.tx");
    case "address":
      return t("explorer.hint.address");
    case "block":
      return t("explorer.hint.block");
    case "agent":
      return t("explorer.hint.agent");
    default:
      return t("explorer.hint.unknown");
  }
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
      title={href ? t("explorer.openBlock") : t("explorer.startToOpen")}
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
          {t("rounds.txN", { n: block.txCount })}
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
              title={t("agent.openTx")}
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
              title={t("agent.openAddress")}
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
  const scenario = useScenarioLabel();
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

  if (loading) return <CenteredMessage text={t("common.loading")} />;
  if (error || !data)
    return (
      <CenteredMessage
        text={t("common.loadFailed", {
          detail: error ? `: ${error.message}` : "",
        })}
        tone="danger"
      />
    );

  const { round, scope, stats } = data;
  const base = blockscout.base;
  const worldName = scenario.name
    ? scenario.name.replace(/^full-/, "")
    : runDisplayName(round.runId);

  const indexerNote = ((): string | null => {
    if (indexedProbe === "missing") return t("explorer.notIndexed");
    // Live: the gap between the chain and the indexer is genuine lag, and worth seeing.
    if (round.status === "live" && blockscout.indexedHeight !== null) {
      const behind = round.blockNumber - blockscout.indexedHeight;
      return behind > 1 ? t("explorer.behind", { n: behind }) : null;
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
            {t("explorer.title")}
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
                  {t("explorer.connected")}
                </a>
                <span style={{ color: "var(--text-tertiary)" }}>
                  {t("explorer.indexed", {
                    n: blockscout.indexedHeight?.toLocaleString("en-US") ?? "—",
                  })}
                  {blockscout.indexedPercent !== null &&
                    blockscout.indexedPercent < 100 &&
                    t("explorer.indexedPct", {
                      p: blockscout.indexedPercent.toFixed(1),
                    })}
                </span>
                {indexerNote && (
                  <span style={{ color: "var(--warning)" }}>{indexerNote}</span>
                )}
              </>
            ) : blockscout.probed ? (
              <span>{t("explorer.offline")}</span>
            ) : (
              <span>{t("explorer.probing")}</span>
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
              placeholder={t("explorer.search")}
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
                  {searchHint(target.kind)}
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
                      {t("explorer.open")}
                    </span>
                  ) : (
                    <span>
                      {blockscout.probed ? t("explorer.localOnly") : "…"}
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
          <span style={SECTION_LABEL_STYLE}>{t("market.scope")}</span>
          <Select
            value={selectedRound === null ? "all" : String(selectedRound)}
            options={[
              {
                label: t("explorer.wholeRun", { n: round.epochs.length }),
                value: "all",
              },
              ...round.epochs.map((e) => ({
                label: t("explorer.roundOption", {
                  i: String(e.index).padStart(2, "0"),
                  from: e.fromBlock.toLocaleString("en-US"),
                  to: e.toBlock.toLocaleString("en-US"),
                }),
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
              ? t("explorer.scopeBlocks", {
                  from: scope.fromBlock.toLocaleString("en-US"),
                  to: scope.toBlock.toLocaleString("en-US"),
                })
              : t("explorer.scopeRound", {
                  i: scope.roundIndex,
                  from: scope.fromBlock.toLocaleString("en-US"),
                  to: scope.toBlock.toLocaleString("en-US"),
                })}
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
              label={t("explorer.stat.scenario")}
              value={`${worldName} · ${round.status === "live" ? t("common.live") : t("common.finished")}`}
            />
            <StatTile
              label={t("explorer.stat.latest")}
              value={stats.latestBlockNumber}
            />
            {stats.indexerBlockNumber !== undefined && (
              <StatTile
                label={t("explorer.stat.indexed")}
                value={stats.indexerBlockNumber}
              />
            )}
            <StatTile
              label={
                scope.roundIndex === null
                  ? t("explorer.stat.txRun")
                  : t("explorer.stat.txRound")
              }
              // null = the live view does not hold this round's blocks; "0" would be a claim.
              value={
                stats.txCountThisRound === null
                  ? "—"
                  : stats.txCountThisRound.toLocaleString("en-US")
              }
            />
            <StatTile
              label={t("explorer.stat.agents")}
              value={String(stats.activeAgents)}
            />
            <StatTile
              label={t("explorer.stat.blockTime")}
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
                {t("explorer.blocks")}
              </span>
              <span
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                {t("explorer.shown", { n: blocks.length })}
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
                {t("explorer.noBlocks")}
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
                {t("explorer.transactions")}
              </span>
              <span
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                {t("explorer.shown", { n: transactions.length })}
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
                {t("explorer.noTx")}
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
