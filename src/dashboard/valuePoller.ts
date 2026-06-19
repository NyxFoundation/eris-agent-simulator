// valuePoller: anvil 本体の RPC に読取専用で接続し、N ブロックごとに確定ブロック（latest-1）の
// 価値断面を readValueSnapshotAtBlock で読む（ADR 0008「valuePoller」）。
//
// 採点（reconstruct）と同一の価値計算ロジックを現ブロック断面に対して実行する → ライブ順位が
// 「採点と同じ価値定義」で出る（指標の一貫性）。ただしライブ値は参考、権威は run 後 reconstruct。
// tx は一切送らない read-only 観測者なので着順・fee 競争・採点には干渉しない。
// RPC 接続不可ならファイル tail のみの degrade モードへ落ちる。

import type { Address, PublicClient } from "viem";
import { activeStables, makeClients } from "../chain.js";
import { CHAIN_ID } from "../constants.js";
import { initProtocols } from "../protocols/registry.js";
import { readValueSnapshotAtBlock } from "../realtime/reconstruct.js";
import type { ProtocolId } from "../types.js";
import type { DashboardState } from "./state.js";

export type ValuePollerOptions = {
  rpcUrl: string;
  pollEvery: number; // N ブロックごとに 1 断面
  intervalMs?: number;
};

export function startValuePoller(
  state: DashboardState,
  opts: ValuePollerOptions,
): () => void {
  const pollEvery = Math.max(1, opts.pollEvery);
  let publicClient: PublicClient | null = null;
  let stoppedExternally = false;
  let initialized = false; // initProtocols（activeStables 設定）済みか
  let lastPolledBlock: number | null = null;
  let busy = false;

  state.setPollerStatus({ pollEvery, connected: false, degraded: false });

  const ensureClient = (): PublicClient => {
    if (!publicClient) {
      const { publicClient: pc } = makeClients(opts.rpcUrl, CHAIN_ID, {
        batch: true,
      });
      publicClient = pc;
    }
    return publicClient;
  };

  const ready = (): boolean =>
    !!state.priceFeed &&
    state.run.enabledProtocols.length > 0 &&
    state.agentsWithAddress().length > 0;

  const pollOnce = async (): Promise<void> => {
    if (busy || stoppedExternally) return;
    if (state.run.phase === "completed") return; // run 終了後は確定値に任せる
    if (!ready()) return;
    busy = true;
    try {
      const client = ensureClient();
      const head = Number(await client.getBlockNumber());
      if (!state.poller.connected) {
        state.setPollerStatus({
          connected: true,
          degraded: false,
          lastError: null,
        });
      }
      const confirmed = head - 1; // 進行中ブロックの未確定 state を拾わない
      if (confirmed < 1) return;
      if (lastPolledBlock !== null && confirmed < lastPolledBlock + pollEvery) {
        return;
      }
      if (!initialized) {
        initProtocols(state.run.enabledProtocols as ProtocolId[]);
        initialized = true;
      }
      const snapshot = await readValueSnapshotAtBlock({
        publicClient: client,
        agents: state.agentsWithAddress().map((a) => ({
          id: a.id,
          address: a.address as Address,
        })),
        enabledIds: state.run.enabledProtocols as ProtocolId[],
        activeStables: activeStables(),
        priceFeed: state.priceFeed as Address,
        blockNumber: confirmed,
      });
      lastPolledBlock = confirmed;
      state.setValues({
        blockNumber: confirmed,
        fairPrice: snapshot.fairPriceUsdcPerWeth,
        poolPrice: snapshot.poolPriceUsdcPerWeth,
        values: snapshot.values,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 接続不可 → degrade（ファイル tail は runWatcher が継続）。再試行は続ける。
      state.setPollerStatus({
        connected: false,
        degraded: true,
        lastError: message,
      });
    } finally {
      busy = false;
    }
  };

  const intervalMs = opts.intervalMs ?? 750;
  const timer = setInterval(() => void pollOnce(), intervalMs);
  void pollOnce();

  return () => {
    stoppedExternally = true;
    clearInterval(timer);
  };
}
