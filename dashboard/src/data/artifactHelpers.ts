// Shared readers and formatters over a loaded run's artifacts. Split out so the two consumers —
// runsProvider (the snapshots the pages consume) and venuePanels (what each deployed application
// is doing) — read the same event stream and print the same numbers the same way.

import type { LoadedRun, MarketSeriesFile, RunEvent } from "./runArtifacts";

// ---------------------------------------------------------------------------
// event-payload coercion. Payload fields are `unknown`: an older run may not carry a field at all,
// and uint256s arrive as decimal strings.

export const num = (v: unknown): number =>
  typeof v === "number" ? v : Number(v ?? 0);

export const str = (v: unknown): string =>
  typeof v === "string" ? v : String(v ?? "");

/** wei string -> whole tokens. Event payloads carry uint256 as decimal strings. */
export function fromWei(value: unknown, decimals = 18): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n / 10 ** decimals : null;
}

// ---------------------------------------------------------------------------
// event stream

export function eventOfType(
  events: RunEvent[],
  type: string,
): RunEvent | undefined {
  return events.find((e) => e.type === type);
}

export function eventsOfType(events: RunEvent[], type: string): RunEvent[] {
  return events.filter((e) => e.type === type);
}

/** Per-block payloads of one coordinator event type, in block order. */
export function blockSeriesOf(run: LoadedRun, type: string): RunEvent[] {
  return eventsOfType(run.events, type)
    .filter((e) => Number.isFinite(Number(e.blockNumber)))
    .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
}

/** One numeric field of a per-block event series, as chart points keyed by block. */
export function seriesOf(
  events: RunEvent[],
  field: string,
): { time: number; value: number }[] {
  return events.flatMap((e) => {
    const value = Number(e[field]);
    return Number.isFinite(value)
      ? [{ time: Number(e.blockNumber), value }]
      : [];
  });
}

/** The protocols the coordinator recorded as enabled at run start. */
export function enabledProtocols(run: LoadedRun): string[] {
  const event = eventOfType(run.events, "run_started_realtime");
  const list = event?.enabledProtocols;
  return Array.isArray(list) ? (list as string[]) : [];
}

/** Every market-priced stable the reconstructed series carries a sample for. */
export function stableSymbols(market: MarketSeriesFile): string[] {
  const symbols = new Set<string>();
  for (const row of market.series)
    for (const symbol of Object.keys(row.stables ?? {})) symbols.add(symbol);
  return [...symbols].sort();
}

// ---------------------------------------------------------------------------
// formatting

export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000)
    return `$${(value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: abs >= 1000 ? 0 : 2 })}`;
}

export function formatBps(value: number): string {
  return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(1)}bps`;
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export function formatBaseUnits(units: number): string {
  if (units >= 1000)
    return units.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (units >= 1) return units.toFixed(2);
  return units.toPrecision(3);
}

export function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== points[points.length - 1])
    out.push(points[points.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// venue identity

export const VENUE_COLORS: Record<string, string> = {
  uniswap: "#7c9eff",
  balancer: "#f5a623",
  curve: "#4fd1a5",
};

export const VENUE_LABELS: Record<string, string> = {
  uniswap: "Uniswap v3",
  balancer: "Balancer",
  curve: "Curve",
};

// A stable palette for the venue-state charts, used wherever a series has no venue colour of its own.
const SERIES_COLORS = [
  "#7c9eff",
  "#f5a623",
  "#4fd1a5",
  "#e879a6",
  "#b18cf0",
  "#6dd3e0",
];

export const seriesColor = (i: number): string =>
  SERIES_COLORS[i % SERIES_COLORS.length];

/** What an agent's own log says a transaction was: the action type it submitted, and the venue. */
export type TxInfo = { method: string; protocol?: string };
