// The overrides one epoch of a scenario matrix runs under (ADR 0020 §1, issue #167).
//
// The ordinal handed to the agents is the scenario's own `s` from the set -- never a count of what
// this invocation has run. A resumed matrix skips its complete epochs, a partial rehearsal of a
// 60-epoch schedule starts wherever it starts, and a failed epoch is run again: each time the agents
// are told the epoch's scheduled ordinal, which is also the one its weight is computed from (rules
// §4.4.2: a re-run inherits the original ordinal and weight).
//
// @eris/sdk/epoch.js has no imports, so this is safe to load before the backtest CLI has synced the
// constants (see the top of cli/backtest.ts).
import { epochOrdinalEnv } from "@eris/sdk/epoch.js";

export function matrixEpochOverrides(
  s: number,
  k: number,
): Record<string, string> {
  return {
    ERIS_RESET_UNIT: "scenario",
    ...epochOrdinalEnv({ index: s, count: k }),
  };
}
