// discovery-arb（ADR 0014 §6）: 発見 + 即実行（naive）。
// factory の PoolCreated を購読して新規プールを発見し、fair より割安な base を見つけたら
// **検証せず**即 approve+swap（minOut=0 で trust）する。rigged プールなら skim で被弾する
// （＝取引前検証をしない者の失敗モードの対照）。
import { runDiscoveryAgent } from "./lib/discoveryAgent.js";

void runDiscoveryAgent({ verify: false });
