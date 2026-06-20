// runWatcher: 対象 run dir の 3 ファイル（events.jsonl / blocks.csv / agents/*.jsonl）を
// 増分 tail し、行を構造化イベントへ変換して DashboardState に流す（ADR 0008「runWatcher」）。
//
// 単一 run 前提（ADR 0008 §追加決定）。RUN_DIR 明示指定 or 起動時点の最新 dir に固定する。
// realtime では blocks.csv は run 後一括書込なので、ライブ tx は events.jsonl の tx_submitted と
// agents/*.jsonl の mempool submitted が主。blocks.csv は run 末に確定の着順・status を補完する。

import {
  existsSync,
  readdirSync,
  readSync,
  openSync,
  closeSync,
  fstatSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { BLOCKS_CSV_INDEX } from "../logger.js";
import type { DashboardState } from "./state.js";

// 1 ファイルをバイトオフセット追跡で増分読みするテイラー。完全な 1 行だけを yield する。
class FileTailer {
  private offset = 0;
  private carry = "";
  constructor(private readonly path: string) {}

  poll(onLine: (line: string) => void): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return; // まだ存在しない
    }
    if (size < this.offset) {
      // 切り詰め/再作成 → 先頭から読み直す
      this.offset = 0;
      this.carry = "";
    }
    if (size === this.offset) return;
    const fd = openSync(this.path, "r");
    try {
      const len = fstatSync(fd).size;
      let pos = this.offset;
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (pos < len) {
        const read = readSync(fd, chunk, 0, chunk.length, pos);
        if (read <= 0) break;
        pos += read;
        this.carry += chunk.toString("utf8", 0, read);
        let nl = this.carry.indexOf("\n");
        while (nl >= 0) {
          const line = this.carry.slice(0, nl).trim();
          this.carry = this.carry.slice(nl + 1);
          if (line) onLine(line);
          nl = this.carry.indexOf("\n");
        }
      }
      this.offset = pos;
    } finally {
      closeSync(fd);
    }
  }
}

function tsOf(obj: { ts?: unknown }): number | undefined {
  if (typeof obj.ts !== "string") return undefined;
  const t = Date.parse(obj.ts);
  return Number.isNaN(t) ? undefined : t;
}

// RUNS_DIR 配下で最新の run dir（events.jsonl を持つ最大名）を返す。無ければ null。
function latestRunDir(runsDir: string): string | null {
  if (!existsSync(runsDir)) return null;
  const dirs = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(runsDir, name, "events.jsonl")))
    .sort(); // runId は ISO タイムスタンプ由来 → 辞書順 = 時系列順
  return dirs.length ? join(runsDir, dirs[dirs.length - 1]) : null;
}

export type RunWatcherOptions = {
  runsDir: string;
  runDir?: string; // 明示指定（未指定なら起動時点の最新を採用）
  intervalMs?: number;
  onResolved?: (runDir: string) => void;
};

export function startRunWatcher(
  state: DashboardState,
  opts: RunWatcherOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? 250;
  let runDir: string | null = opts.runDir ?? null;
  let resolvedNotified = false;
  let eventsTailer: FileTailer | null = null;
  let blocksTailer: FileTailer | null = null;
  const agentTailers = new Map<string, FileTailer>();
  // run 後 reconstruct の observation（reconstructed:true）を agent ごとに最初/最後の断面で
  // 集約し、value_series_reconstructed で確定順位（pnl = last - first）に切替える（ADR 0008 P3）。
  const recon = new Map<
    string,
    { firstRound: number; firstVal: number; lastRound: number; lastVal: number }
  >();

  const dispatchEvent = (line: string): void => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const ts = tsOf(ev);
    switch (ev.type) {
      case "run_started_realtime":
        state.setRun({
          runId: String(ev.runId ?? ""),
          enabledProtocols: Array.isArray(ev.enabledProtocols)
            ? (ev.enabledProtocols as string[])
            : [],
          blockTimeSec: Number(ev.blockTimeSec ?? 0),
          runBlocks: Number(ev.runBlocks ?? 0),
          runDir: runDir ?? "",
          phase: "started",
        });
        break;
      case "price_feed_deployed":
        if (typeof ev.address === "string") state.setPriceFeed(ev.address);
        break;
      case "agents_registered":
        if (Array.isArray(ev.agents)) {
          state.registerAgents(
            (ev.agents as Array<Record<string, unknown>>).map((a) => ({
              id: String(a.id),
              address: typeof a.address === "string" ? a.address : null,
              baseline: Boolean(a.baseline),
            })),
          );
        }
        break;
      case "round_timing":
        state.addBlock({
          blockNumber: Number(ev.blockNumber ?? 0),
          timingMs: ev.totalMs !== undefined ? Number(ev.totalMs) : null,
          ts,
        });
        break;
      case "tx_submitted":
        state.addTx({
          phase: "submitted",
          blockNumber: state.latestBlock,
          txIndex: null,
          ownerId: String(ev.ownerId ?? "?"),
          role: String(ev.role ?? "uninformed-flow"),
          actionType: String(ev.actionType ?? ""),
          priorityFeeWei: String(ev.priorityFeeWei ?? "0"),
          status: "submitted",
        });
        break;
      case "observation": {
        // 採点 reconstruct の observation 形（inventory.valueUsdc = 総価値）。
        // ライブ relay の observation（reconstructed なし）は除外し、確定分だけ集約する。
        const obs = ev.observation as
          | {
              reconstructed?: boolean;
              round?: number;
              inventory?: { valueUsdc?: number };
            }
          | undefined;
        if (!obs?.reconstructed || typeof ev.agentId !== "string") break;
        const round = Number(obs.round ?? 0);
        const val = Number(obs.inventory?.valueUsdc ?? 0);
        const cur = recon.get(ev.agentId);
        if (!cur) {
          recon.set(ev.agentId, {
            firstRound: round,
            firstVal: val,
            lastRound: round,
            lastVal: val,
          });
        } else {
          if (round < cur.firstRound) {
            cur.firstRound = round;
            cur.firstVal = val;
          }
          if (round >= cur.lastRound) {
            cur.lastRound = round;
            cur.lastVal = val;
          }
        }
        break;
      }
      case "value_series_reconstructed":
        if (recon.size > 0) {
          state.setFinalRanking(
            [...recon.entries()].map(([id, r]) => ({
              id,
              valueUsdc: r.lastVal,
              pnlUsdc: r.lastVal - r.firstVal,
            })),
          );
        } else {
          state.markFinalized();
        }
        break;
      case "run_completed":
        state.completeRun();
        break;
      case "stress_schedule": {
        // 市場ストレスシナリオ（ADR 0009）。窓は blockIndex 基準 → runStartBlock を保持する。
        const events = Array.isArray(ev.events)
          ? (ev.events as Array<Record<string, unknown>>).map((e) => ({
              type: String(e.type ?? ""),
              startBlock: Number(e.startBlock ?? 0),
              endBlock: Number(e.endBlock ?? 0),
              magnitude: Number(e.magnitude ?? 0),
            }))
          : [];
        const types = [...new Set(events.map((e) => e.type))].filter(Boolean);
        state.setScenario({
          name: types.join("·") || "stress",
          runStartBlock: Number(ev.runStartBlock ?? 0),
          events,
        });
        break;
      }
      case "stress_liquidation":
        state.recordLiquidation({
          blockNumber: Number(ev.blockNumber ?? 0),
          victimId: String(ev.victimId ?? "?"),
          repaidBaseUsd: Number(ev.repaidBaseUsd ?? 0),
          healthFactor: String(ev.healthFactor ?? "0"),
          ts,
        });
        break;
      default:
        break;
    }
  };

  const dispatchBlockRow = (line: string): void => {
    if (line.startsWith("round,")) return; // ヘッダ
    const cols = line.split(",");
    const blockNumber = Number(cols[BLOCKS_CSV_INDEX.blockNumber]);
    if (!Number.isFinite(blockNumber)) return;
    state.addTx({
      phase: "mined",
      blockNumber,
      txIndex: Number(cols[BLOCKS_CSV_INDEX.txIndex]),
      ownerId: cols[BLOCKS_CSV_INDEX.ownerId] ?? "?",
      role: cols[BLOCKS_CSV_INDEX.role] ?? "",
      actionType: cols[BLOCKS_CSV_INDEX.actionType] ?? "",
      priorityFeeWei: cols[BLOCKS_CSV_INDEX.priorityFeeWei] ?? "0",
      status: cols[BLOCKS_CSV_INDEX.status] ?? "",
    });
  };

  const dispatchAgentLine = (agentId: string, line: string): void => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const ts = tsOf(ev);
    if (ev.kind === "mempool") {
      const event = String(ev.event ?? "");
      if (event === "direct_start") {
        if (typeof ev.address === "string")
          state.noteAgentAddress(agentId, ev.address);
        return;
      }
      if (
        event === "submitted" ||
        event === "rejected" ||
        event === "submit_failed"
      ) {
        state.addAgentAction({
          agentId,
          event,
          actionType: typeof ev.actionType === "string" ? ev.actionType : null,
          reason: typeof ev.reason === "string" ? ev.reason : null,
          ts,
        });
        // direct agent の submitted はライブ tx フィードにも流す
        if (event === "submitted") {
          state.addTx({
            phase: "submitted",
            blockNumber:
              typeof ev.blockSeen === "number"
                ? ev.blockSeen
                : state.latestBlock,
            txIndex: null,
            ownerId: agentId,
            role: "agent",
            actionType:
              typeof ev.actionType === "string" ? ev.actionType : "direct",
            priorityFeeWei: String(ev.priorityFeeWei ?? "0"),
            status: "submitted",
          });
        }
      }
      return;
    }
    // createEmitter 由来の通常行動ログ（reason / action を持つ rule 系 agent）
    if (ev.reason || ev.action) {
      state.addAgentAction({
        agentId,
        event: "decided",
        actionType:
          ev.action && typeof ev.action === "object" && "type" in ev.action
            ? String((ev.action as { type: unknown }).type)
            : null,
        reason: typeof ev.reason === "string" ? ev.reason : null,
        ts,
      });
    }
  };

  const scanAgents = (): void => {
    if (!runDir) return;
    const dir = join(runDir, "agents");
    if (!existsSync(dir)) return;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return;
    }
    for (const f of files) {
      if (!agentTailers.has(f)) {
        agentTailers.set(f, new FileTailer(join(dir, f)));
      }
      const agentId = f.replace(/\.jsonl$/, "");
      agentTailers.get(f)!.poll((line) => dispatchAgentLine(agentId, line));
    }
  };

  const tick = (): void => {
    if (!runDir) {
      runDir = latestRunDir(opts.runsDir);
      if (!runDir) return;
    }
    if (!resolvedNotified) {
      resolvedNotified = true;
      state.run.runDir = runDir;
      opts.onResolved?.(runDir);
    }
    if (!eventsTailer)
      eventsTailer = new FileTailer(join(runDir, "events.jsonl"));
    if (!blocksTailer)
      blocksTailer = new FileTailer(join(runDir, "blocks.csv"));
    eventsTailer.poll(dispatchEvent);
    blocksTailer.poll(dispatchBlockRow);
    scanAgents();
  };

  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}
