// noop: 何もしないベースライン。
import type { AgentAction } from "@eris/sdk";

export function decide(): AgentAction {
  return { type: "noop", reason: "baseline" };
}
