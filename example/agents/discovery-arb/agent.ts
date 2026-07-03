// discovery-arb（ADR 0014 §6）: 発見 + 即実行（naive）。
// factory の PoolCreated を購読して新規プールを発見し、fair より割安な base を見つけたら
// **検証せず**即 approve+swap（minOut=0 で trust）する。rigged プールなら skim で被弾する
// （＝取引前検証をしない者の失敗モードの対照）。
//
// 自前で block 購読して action を出す run(ctx) 契約（ADR 0015 §3）。共通コアへ委譲する。
import type { AgentContext } from "@eris/sdk";
import { runDiscoveryAgent } from "../lib/discoveryAgent.js";

export async function run(ctx: AgentContext): Promise<void> {
  await runDiscoveryAgent(ctx, { verify: false });
}
