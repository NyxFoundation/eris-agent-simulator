[← README](../../README.md)

# アーキテクチャ（環境とエージェント実行の分離）

パッケージは 3 workspace + 同梱 deployer（ADR 0015）。依存方向は **`example → sdk ← core`** のみ
（`npm run check:boundaries` が検査）:

| workspace | 役割 |
|---|---|
| `sdk/` | 契約レイヤ — types / action スキーマ(zod) / chain / markets / protocols / observation / SimConfig |
| `core/` | 環境デーモン + 採点 — realtime coordinator / anvil / flow / stress / vuln / backtest / cli。参加者は触らない |
| `example/` | 参加者テンプレート — `example/agents/<id>/` がコピー・提出の単位。`runtime/`（汎用駆動）と `lib/`（共有戦略ヘルパ）は予約名 |
| `deployer/` | venue デプロイ（workspace 外の自己完結サブパッケージ） |

```
環境プロセス（core/src/realtime/coordinator.ts = 環境デーモン + 採点者）   agent プロセス × N（完全独立）
  ・anvil ライフサイクル（fork/ローカル setup・interval mining）        ・spawn は一律 example/agents/runtime/bot.ts
  ・fair price 生成(Rng(seed)) → PriceFeed/oracle を毎ブロック更新         （agent ディレクトリは env ERIS_AGENT_DIR）
  ・flow bot 注文の送信（市場を動かす）                                ・env で受領: RPC URL / 自分の秘密鍵 /
  ・GMX keeper（注文執行）                                               PriceFeed アドレス / runId・ログ出力先
  ・採点: run 後に歴史ブロック読取で価値系列を一括再構成               ・runtime/read.ts が毎ブロック観測を再構成
         └──────────── 同じ mempool。ブロック内順序は anvil --order fees ・runtime/send.ts が署名・直接送信（nonce 自己管理）
```

- **fair price はオンチェーン配布**（`contracts/PriceFeed.sol`。読取 `sdk/src/priceFeed.ts` / 書込
  `core/src/realtime/priceFeed.ts`）。書込 tx は次ブロック着弾なので情報は全員等しく 1 ブロック遅れる（仕様）。
- **採点は run 後再構成**（`core/src/realtime/reconstruct.ts`）— blockNumber 指定の Multicall3 で全 agent
  同一断面の価値系列を `events.jsonl` に書き、`runs/<id>/summary.json` に集計する。
- **ルール執行は事後検出**（`core/src/postRunCheck.ts`）— `blocks.csv` から fee 上限超過等を検査し違反 run を
  `violations` に記録する。入口側は `npm run check:strategy`（cheatcode 静的検査）。
- **orderflow は独立プロセス** — 生成ロジックは `core/src/flow/logic.ts`（純粋関数）、bot 本体は
  `core/src/flow/market-maker.ts`。coordinator と stdin/stdout の同期プロトコルで毎ラウンド駆動され、
  自前 `Rng(ERIS_FLOW_SEED)` で決定論的に動く。
- protocol アダプタ（`sdk/src/protocols/*.ts`）は `readState`/`observe`/`buildTxs`/`valueUsdc` 等を実装し、
  環境の採点と agent の観測再構成が**同じアダプタ・同じ `observationFor`** を使う。

## なぜ分離するか

エージェントには RPC・他者の秘密鍵・pending トランザクション・txpool を渡さず、**確定済み状態の観測**
だけを与える。これにより mempool の覗き見によるフロントランを構造的に封じ、全員が同じ情報・同じ
mempool で競う公平な土俵を作る。市場を動かすのは環境側の flow bot で、エージェントはその結果生まれた
価格乖離＝裁定機会に反応する。

## agent の書き方（1 agent = 1 ディレクトリ。ADR 0015）

`example/agents/<id>/` に次のいずれか 1 枚を置き、ロスターに id を足すだけで agent が増える。
spawn は一律 `runtime/bot.ts` が担う（手順つきのチュートリアルは[戦略の書き方](writing-agents.md)）:

| 中身 | 種別 | 動き方 |
|---|---|---|
| `agent.ts`（`decide(obs, ctx)` export） | ルール戦略 | bot.ts が read→decide→send のループで駆動（`export const config = { intervalMs }` で間隔指定可） |
| `agent.ts`（`run(ctx)` export） | 自走型 | bot.ts はループせず ctx（clients / latestObservation / onObservation / submit / log）を渡して委譲（例: liquidator） |
| `prompt.md`（frontmatter: name/description 必須） | プロンプト型 | bot.ts が observation を添えて毎判断 LLM に action を出させる（[LLM エージェント](llm-agents.md)） |

runtime/send.ts は mempool 活動（`kind:"mempool"`: submitted / submit_failed / rejected）を
`runs/<id>/agents/<id>.jsonl` に自己申告で追記する（coordinator が提出数を数えられなくなる穴を塞ぐ）。

## 実行モード

同じ coordinator を 2 つの入口から使う:

- **`npm run sim:realtime`** — 通常の実時間 run。fork（`ARB_RPC_URL`）または[ローカルデプロイ](local-deploy.md)。
- **`npm run backtest -- --regime <name>`** — 参加者バックテスト（ADR 0016）。配布 state dump をロードした
  専用 anvil の上で公式 regime を再生し、`--repeat` で反復する。詳細は [バックテスト](backtest.md)。
