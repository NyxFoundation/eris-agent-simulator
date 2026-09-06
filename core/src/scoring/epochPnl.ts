// P(a, s) for one agent, read off the values at the epoch's boundaries (rules §4.4.1, §4.4.2).
//
//   P = V_K − V_0     V_0 the mark at the epoch's first boundary, V_K at its last
//
// Each end is valued at its own block's marks (the 5-block median of §4.1), which is what separates
// this from summary.json's netPnlUsdc, where both ends are priced at the final marks. When every
// agent starts with the same basket the two differ by a constant across the field, so the deviation
// score is identical either way -- but this is the number the rules name, so it is the one recorded.
//
// §4.4.2: if the value at the end of the epoch could not be obtained, the most recent boundary that
// did report is used. That is an environment-side event and is reported as such (`carriedFinal`).
export type EpochPnl = {
  pnlUsdc: number;
  initialValueUsdc: number;
  finalValueUsdc: number;
  // Index of the boundary V_K was read at, and of the last boundary the series has. They differ
  // only when the final boundary did not report.
  finalBoundaryIndex: number;
  lastBoundaryIndex: number;
  carriedFinal: boolean;
};

export function epochPnlFromSeries(
  values: ReadonlyArray<number | null | undefined>,
): EpochPnl | null {
  if (values.length < 2) return null;
  const v0 = values[0];
  // Without a starting value there is no P to speak of. Inventing one (par, the first value that did
  // report) would put a number on an agent nobody measured at the start.
  if (typeof v0 !== "number" || !Number.isFinite(v0)) return null;
  const last = values.length - 1;
  let i = last;
  while (i > 0) {
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v)) break;
    i--;
  }
  if (i === 0) return null;
  const vK = values[i] as number;
  return {
    pnlUsdc: vK - v0,
    initialValueUsdc: v0,
    finalValueUsdc: vK,
    finalBoundaryIndex: i,
    lastBoundaryIndex: last,
    carriedFinal: i !== last,
  };
}
