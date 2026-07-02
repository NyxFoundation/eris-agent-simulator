// discovery-arb-verify（ADR 0014 §6）: 発見 + 取引前検証 + 実行（careful）。
// discovery-arb と同じ発見レイヤを使い、取引前に verifyContract（dry-run + codehash 照合 +
// 任意 LLM ソース監査）で候補プールを監査する。rigged を弾き（vulnerability_avoided）、安全な
// 新規プールだけ保護的 minOut で約定する（safe_pool_captured）。「検知のみ vs 検知+検証」の
// discrimination が検証ゲートの有無だけに帰着する。
import { runDiscoveryAgent } from "./lib/discoveryAgent.js";

void runDiscoveryAgent({ verify: true });
