// The local Blockscout explorer (npm run explorer, issue #31). The dashboard links into it and
// reports its indexing state; it never depends on it, and every view renders identically when the
// explorer is down. Availability is probed through the Vite proxy (/blockscout -> :3100) so browser
// CORS never applies.

import { useEffect, useState } from "react";

const BLOCKSCOUT_URL =
  (import.meta.env.VITE_BLOCKSCOUT_URL as string | undefined) ??
  "http://localhost:3100";

// Connected: keep up with the indexer. Down: back off — every failed probe is a console error the
// browser prints whatever we do with it, and an explorer that is off is usually off for a while.
const STATUS_POLL_CONNECTED_MS = 10_000;
const STATUS_POLL_OFFLINE_MS = 30_000;

let probe: Promise<boolean> | null = null;

function blockscoutAvailable(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch("/blockscout/api/v2/stats", {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  })();
  return probe;
}

/** Base URL for explorer links, or null while probing / when the explorer is down. */
export function useBlockscoutBase(): string | null {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void blockscoutAvailable().then((ok) => {
      if (!cancelled && ok) setBase(BLOCKSCOUT_URL);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return base;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(path, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface BlockscoutStatus {
  /** null while probing, or when the explorer is not answering. */
  base: string | null;
  /** The indexer's newest block, when it answers. */
  indexedHeight: number | null;
  /** Blockscout's own catch-up percentage, when it reports one. */
  indexedPercent: number | null;
  /** False until the first probe resolves — "unknown" is not the same as "down". */
  probed: boolean;
}

/**
 * The explorer's connection state, re-polled while the page is open: a run that starts after the
 * explorer, or an explorer started after the page, both settle on their own. The indexer height is
 * carried separately from the chain height because it lags — Blockscout cannot follow a chain
 * rollback, so a stale height is the signal to run `npm run explorer:reset`.
 */
export function useBlockscoutStatus(): BlockscoutStatus {
  const [status, setStatus] = useState<BlockscoutStatus>({
    base: null,
    indexedHeight: null,
    indexedPercent: null,
    probed: false,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const schedule = (connected: boolean) => {
      if (cancelled) return;
      timer = window.setTimeout(
        () => void read(),
        connected ? STATUS_POLL_CONNECTED_MS : STATUS_POLL_OFFLINE_MS,
      );
    };
    const read = async () => {
      const stats = await fetchJson<{
        total_blocks?: string;
        indexed_blocks_percentage?: number;
      }>("/blockscout/api/v2/stats");
      if (cancelled) return;
      if (!stats) {
        setStatus({
          base: null,
          indexedHeight: null,
          indexedPercent: null,
          probed: true,
        });
        schedule(false);
        return;
      }
      const blocks = await fetchJson<{ items?: { height?: number }[] }>(
        "/blockscout/api/v2/blocks?type=block",
      );
      if (cancelled) return;
      const height = blocks?.items?.[0]?.height;
      setStatus({
        base: BLOCKSCOUT_URL,
        indexedHeight: typeof height === "number" ? height : null,
        indexedPercent:
          typeof stats.indexed_blocks_percentage === "number"
            ? stats.indexed_blocks_percentage
            : null,
        probed: true,
      });
      schedule(true);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return status;
}

/** Whether the indexer holds a given transaction: "unknown" until the probe answers. */
export type IndexedProbe = "unknown" | "indexed" | "missing";

/**
 * Does Blockscout actually hold *this run's* transactions?
 *
 * Comparing heights cannot answer that. Every run rewinds the chain and no indexer can follow a
 * rewind, so the indexer can sit at a perfectly plausible height while the blocks at those heights
 * belong to a previous run — and the height is also routinely a few blocks *past* a run's last
 * scored block, because the environment's teardown keeps mining after scoring stops. Asking for one
 * transaction the run really produced settles it in a single request: found means the deep links
 * work, not found means the indexer is holding a different chain and needs `explorer:reset`.
 */
export function useIndexedTxProbe(
  base: string | null,
  hash: string | undefined,
): IndexedProbe {
  const [state, setState] = useState<IndexedProbe>("unknown");
  useEffect(() => {
    setState("unknown");
    if (!base || !hash) return;
    let cancelled = false;
    void fetchJson<{ hash?: string }>(
      `/blockscout/api/v2/transactions/${hash}`,
    ).then((tx) => {
      if (!cancelled) setState(tx?.hash ? "indexed" : "missing");
    });
    return () => {
      cancelled = true;
    };
  }, [base, hash]);
  return state;
}

export const blockscoutTxUrl = (base: string, hash: string): string =>
  `${base}/tx/${hash}`;
export const blockscoutBlockUrl = (base: string, block: number): string =>
  `${base}/block/${block}`;
export const blockscoutAddressUrl = (base: string, address: string): string =>
  `${base}/address/${address}`;
export const blockscoutSearchUrl = (base: string, term: string): string =>
  `${base}/search?q=${encodeURIComponent(term)}`;

export type SearchTargetKind = "tx" | "address" | "block" | "agent" | "unknown";

export interface SearchTarget {
  kind: SearchTargetKind;
  /** The value the deep link is built from — a hash, an address, or a block number. */
  value: string;
  /** What the user typed, for the "no match" message. */
  term: string;
  /** For an agent name that resolved to a wallet. */
  agentId?: string;
}

/**
 * Classify a search term. An agent name resolves to its wallet address, because that is the only
 * identity Blockscout knows — `npm run explorer:tag` names those addresses, but the name is not
 * addressable in a URL.
 */
export function classifySearch(
  term: string,
  agents: { id: string; address?: string }[],
): SearchTarget {
  const q = term.trim();
  if (!q) return { kind: "unknown", value: "", term };
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return { kind: "tx", value: q, term };
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { kind: "address", value: q, term };
  if (/^\d[\d,]*$/.test(q))
    return { kind: "block", value: q.replace(/,/g, ""), term };
  const agent = agents.find((a) => a.id.toLowerCase() === q.toLowerCase());
  if (agent?.address)
    return {
      kind: "agent",
      value: agent.address,
      term,
      agentId: agent.id,
    };
  return { kind: "unknown", value: q, term };
}

/** The Blockscout URL a classified term points at, or the search page as a fallback. */
export function searchTargetUrl(
  base: string,
  target: SearchTarget,
): string | null {
  switch (target.kind) {
    case "tx":
      return blockscoutTxUrl(base, target.value);
    case "address":
    case "agent":
      return blockscoutAddressUrl(base, target.value);
    case "block":
      return blockscoutBlockUrl(base, Number(target.value));
    case "unknown":
      return target.value ? blockscoutSearchUrl(base, target.value) : null;
  }
}
