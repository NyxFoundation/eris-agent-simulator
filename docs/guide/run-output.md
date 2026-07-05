[← README](../../README.md)

# run 出力と解析

run ごとに `runs/<run_id>/` が生成される。評価・採点・可視化系の専用コマンドは撤去済みで、解析は出力ファイルを直接読む。

| ファイル | 内容 |
|---|---|
| `summary.json` | agent ごとの initial / final value・netPnl・alpha・included/revert tx 数、`valueSeries.failedReads`、`violations` |
| `events.jsonl` | イベント列（observation・stress・liquidation 等）。採点の一次情報 |
| `blocks.csv` | ブロックごとの tx 記録（fee はチェーン上の tx フィールド由来） |
| `agents/<id>.jsonl` | 各 agent の自己申告ログ（判断 `reason` / `signals` / `state`、runtime/send.ts が追記する mempool 活動 `kind:"mempool"`: submitted / submit_failed / rejected） |
| `agents/<id>.prompt.v<K>.md` | prompt 型の自己改訂履歴（`ERIS_PROMPT_REVISE_EVERY` 有効時。版付き全文） |
| `agents/<id>.llm.jsonl` | prompt 型の LLM 対話ログ（`ERIS_PROMPT_LOG_CALLS=1` の opt-in。system 全文・送信 messages・生応答・エラー。[LLM エージェント](llm-agents.md)） |

```bash
npm run check:ordering -- runs/<run_id>   # Anvil の fee 順序を検査
npm run check:strategy -- <file>          # 戦略コードの cheatcode 静的検査（入口側）
```

> run の入口は `sim:realtime` と `backtest`（出力形式は同一で、`summary.json` の `mode` が `"realtime"` / `"backtest"`）。**SEED(=regime) は市場条件のラベル**で価格パスは再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも結果はぶれる。run の比較が要るときはサンプルを貯めて集計する — [バックテスト](backtest.md)の `--repeat N` が反復と mean alphaUsdc の表示まで面倒を見る。

## summary.json の主なフィールド

| フィールド | 意味 |
|---|---|
| `mode` | `"realtime"` / `"backtest"`（どの入口の run か） |
| `agents[].initialValueUsdc` / `finalValueUsdc` | run 開始・終了時の総価値（USDC 相当。venue ポジションの評価額込み） |
| `agents[].alphaUsdc` | 約定時 fair 基準の β 除去 PnL（実力比較はこちらを見る） |
| `agents[].netPnlUsdc` | `finalValueUsdc − initialValueUsdc` |
| `agents[].includedTxCount` / `revertCount` | included / revert した tx 数 |
| `agents[].stderrTail` | agent プロセスの stderr 末尾（クラッシュ診断用） |
| `valueSeries.failedReads` | 価値再構成で読めなかった断面数（健全なら `0`） |
| `violations` | 事後ルール検査（fee 上限超過等）の違反 |

## 清算の帰属（stress run）

清算の帰属は専用ツールではなく、`events.jsonl` の `stress_liquidation` と各 agent の `agents/<id>.jsonl` の `liquidationCall`(rawTx) を突き合わせて解析する（jsonl を直接読む）。詳細は [市場ストレスイベント](stress-events.md)。
