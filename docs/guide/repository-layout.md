[← README](../../README.md)

# リポジトリ構成

3 npm workspace（`sdk` / `core` / `example`。依存方向は `example → sdk ← core` のみ）+ 同梱 deployer（ADR 0015）。

```
sdk/src/            契約レイヤ（@eris/sdk）
  actionSchema.ts     agent アクションの zod スキーマ（プロンプト型の <schema> 生成元）
  protocols/          プロトコルアダプタ（uniswap / balancer / curve / aave / gmx + registry / oracles）
  chain.ts            クライアント・anvil cheatcode・resetFork（ローカルは snapshot/revert）
  observation.ts      observationFor（環境の採点と agent の観測が同じものを使う）
  runConfig.ts        YAML 設定スキーマ（ネスト lowercase → 内部キー）
  constants*.ts       venue アドレス（fork: constants.ts / local: constants.local.ts = gen:local-constants 生成）
core/src/           環境デーモン + 採点（参加者は触らない）
  cli/                CLI エントリ（anvil / sim-realtime / backtest / checkOrdering）
  realtime/           coordinator / priceFeed / events(stress) / vulnEvents / reconstruct / agentProcess / flowProcess
  flow/               orderflow bot（logic.ts = 純関数 / market-maker.ts = 独立プロセス）
  backtest/           バックテスト共有ヘルパ（state dump manifest / fingerprint / regime 解決。ADR 0016）
  postRunCheck.ts     事後ルール検査（fee 上限超過 → violations）
example/agents/     参加者テンプレート（1 agent = 1 ディレクトリがコピー・提出の単位）
  runtime/            汎用駆動スクリプト（bot / read / send / llm / prompt / agentLog。予約名）
  lib/                共有戦略ヘルパ（markets.ts 等。予約名）
  <id>/               agent 本体（agent.ts の decide/run、または prompt.md）
contracts/          PriceFeed + モックオラクル + FlashArb（Foundry）
deployer/           同梱の deploy オーケストレータ（空の anvil へ全 5 venue を deploy する自己完結サブパッケージ）
config/             YAML 設定（example.yaml = 雛形 / vuln-test.yaml / regimes/ = 公式 regime。ADR 0016）
backtest/state/     state dump + manifest（gen:state-dump 生成物。gitignore）
docs/guide/         利用ガイド（本ディレクトリ）
docs/adr/           アーキテクチャ意思決定記録（ADR 0001–0016）
scripts/            gen:local-constants / gen:state-dump / check:strategy / check:boundaries / bundle:agent
test/               ユニットテスト（node --test）
runs/               run 出力（summary.json / events.jsonl / blocks.csv / agents/<id>.jsonl）
```
