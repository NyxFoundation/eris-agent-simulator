[← README](../../README.md)

# LLM 駆動の自律エージェント（prompt.md 型）

`example/agents/<id>/` に **`prompt.md` 1 枚**を置くと、その agent はプロンプト型になる:
`runtime/bot.ts` が毎判断サイクルで observation を添えて LLM を呼び、JSON アクションを出させる。
手書きのトレードロジックは無く、**prompt.md が戦略そのもの**（提出物）になる。同梱サンプルは
`example/agents/my-arb/prompt.md`。

```markdown
---
name: my-arb                      # 必須
description: cross-venue arb; push toward fair above 30bps   # 必須
intervalMs: 5000                  # 判断サイクル間隔（省略可）
model: gpt-oss:120b               # 使用モデル（省略可。"claude..." なら Anthropic）
---
# Mission
（自然言語の戦略。観測の読み方・発注条件・サイズ・リスク制約を書く）
```

## 動き方（runtime/bot.ts + runtime/llm.ts）

- 毎サイクル、bot.ts が観測（JSON）と **action の `<schema>`**（`sdk/src/actionSchema.ts` の zod
  スキーマから生成）を system prompt に載せて LLM を 1 回呼ぶ。
- 応答は zod で validate し、**失敗はエラー内容を会話に追記して再試行**（上限超過はそのサイクル
  `noop` = fail-closed）。
- 判断とアクションは `runs/<run_id>/agents/<id>.jsonl` に残る（[run 出力と解析](run-output.md)）。
- agent.ts と prompt.md を**併置**した場合の既定は agent.ts（ルール戦略）。ロスターの
  `env: { ERIS_AGENT_MODE: "prompt" }` で prompt.md 駆動へ切り替える。

## 自己改訂（任意）

`ERIS_PROMPT_REVISE_EVERY=<N>` で、N 判断サイクルごとに LLM が **prompt 本文を自己改訂**する
（既定 0 = off）。改訂版は `runs/<run_id>/agents/<id>.prompt.v<K>.md` に版付き保存され以後の
サイクルで使われる。`ERIS_PROMPT_REVISE_PERSIST=1` で agent ディレクトリの prompt.md にも書き戻す。

## バックエンド（runtime/llm.ts）

プロバイダは frontmatter の `model` 名で切り替わる:

| model | プロバイダ | 認証 |
|---|---|---|
| `gpt-oss:120b` 等（既定） | Ollama（既定 Ollama Cloud `https://ollama.com/api`。`ERIS_OLLAMA_BASE_URL` でローカル `http://127.0.0.1:11434/api` へ） | `OLLAMA_API_KEY` / `ERIS_OLLAMA_API_KEY`（ローカル ollama は不要） |
| `claude...` で始まる | Anthropic SDK（tool use で structured output） | `ANTHROPIC_API_KEY` |

1 呼び出しのタイムアウトは `ERIS_LLM_CALL_TIMEOUT_MS`（既定 60000）。秘密の API キーは
`.env.local` に置く（[設定](configuration.md)）。

## 実行例

```yaml
# config/local.yaml のロスター
agents:
  - id: my-arb                       # example/agents/my-arb/（prompt.md のみ → prompt 型）
    wallet: AGENT1_PRIVATE_KEY
  - id: venue-arb                    # agent.ts 併置 agent を prompt.md で動かす場合
    wallet: AGENT2_PRIVATE_KEY
    env:
      ERIS_AGENT_MODE: "prompt"
      ERIS_PROMPT_REVISE_EVERY: "10" # 10 サイクルごとに prompt を自己改訂
```

```bash
set -a; source .env.local; set +a   # OLLAMA_API_KEY 等の秘密のみ
npm run sim:realtime                 # または npm run backtest -- --regime calm-01
```

> prompt 型はブロック時間の壁時計待ちに加えて LLM レイテンシが律速になる。バックテストでも
> LLM 呼び出し自体は残る（[バックテスト](backtest.md)）。

## 旧機構について

実行時に TypeScript の executor を生成・改訂する旧 LLM 自己改善機構（`claude-llm.ts` / `src/llm/`）は
ADR 0015 で退役し、`_archive/` に温存されている。現行の LLM 経路は本ページの prompt.md 型のみ。
