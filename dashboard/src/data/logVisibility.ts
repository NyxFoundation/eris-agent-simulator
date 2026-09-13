// Why an agent's decision log (and the mempool self-reports written to the same file) is absent
// from a page, so the page can say it instead of rendering an empty list (issue #69).
//
// Two reasons exist and they are not the same claim:
//
//   - "audience": the server is not serving `agents/<id>.jsonl` to anyone because the competition
//     is running (server/runsApi.ts audience mode). The log is a participant's own reasoning, and
//     its mempool rows are bids not yet included in a block (rules §2.6). This applies to every
//     agent, operator-run or not, so it takes precedence: in the public view the fact that a log
//     was never written here is not the reason it is absent.
//   - "self-hosted": the agent runs on its owner's machine (practice devnet, ADR 0021), so nothing
//     was ever written under runs/ for it. Only true of `external` agents.
//
// Both callers -- the agent page and the board's log panel -- used to derive this inline, and
// disagreed on the precedence. `null` means the log is there to show.
export type LogAbsence = "audience" | "self-hosted" | null;

export function decisionLogAbsence(
  external: boolean,
  audience: boolean,
): LogAbsence {
  if (audience) return "audience";
  if (external) return "self-hosted";
  return null;
}
