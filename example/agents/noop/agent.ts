// noop: a do-nothing baseline.
import type { AgentAction } from "@eris/sdk";

export function decide(): AgentAction {
  return { type: "noop", reason: "baseline" };
}
