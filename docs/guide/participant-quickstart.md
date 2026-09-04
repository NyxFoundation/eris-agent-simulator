# ASCON Participant Quickstart

The shortest path from clone to a submittable agent. For the full authoring tutorial see
[Writing a Strategy](writing-agents.md); for the rules see `docs/competition-rules.md`.

Your entry is **one function**, `decide(obs, ctx)`, called once per block. It reads a snapshot of
confirmed state and returns one action (or a `bundle`), or `null` to sit out. Invalid actions are
rejected before signing — they never reach the chain (fail-closed).

## 1. Setup

```bash
git clone <repo> && cd eris-agent-simulator
npm install
npm run build:contracts
```

## 2. Copy the starter template

```bash
cp -r example/agents/starter-template example/agents/my-strategy
```

Open `example/agents/my-strategy/agent.ts` and fill in your logic where the `TODO` markers are.
The template reads the fair price and the Uniswap pool, sizes a trade against your wallet budget,
logs its reasoning, and returns a swap. Read [Writing a Strategy](writing-agents.md) Steps 2–4 for
the observation shape, the action list, and the decision log.

## 3. Test locally

Register your agent in a roster (Step 5 of [Writing a Strategy](writing-agents.md)), then:

```bash
npm run backtest -- --regime calm --seed 101 --agents my-roster.yaml            # one regime
npm run backtest -- --scenarios config/scenarios/public.yaml --agents my-roster.yaml  # ローカル検証用の公開シナリオ束（公式評価セットの定義は規約 §3.2/§3.3・詳細は backtest.md）
```

Read `runs/<run_id>/agents/<id>.jsonl` for your decisions and the `submitted`/`rejected` markers the
runtime leaves. See [Run Output and Analysis](run-output.md).

## 4. The competition constraints (know these before you optimize)

**権威ある制約は `docs/competition-rules.md` です**（§2.3/§2.5/§2.6・2026-09-04 確定）。下表は要点で、規約が優先します。

| 制約 | 値 | 出典 |
|---|---|---|
| 1ブロックの tx 本数 | **最大 3 本**（超過は operator が送信前に reject。1 tx のガス上限も課します） | 規約 §2.6 |
| ブロックガスリミット | **320,000,000 gas** | 規約 §2.6 |
| ブロック内の順序 | **priority fee の高い順**（到着時刻ではない） | 規約 §2.6 |
| ブロックタイム | **2秒**（確定・2026-09-04）。**1ブロックが1回の判断機会**（「ラウンド＝評価区間」は複数ブロック・規約 §0.1） | 規約 §2.6・§2.6.1 |
| 計算資源 | **2 vCPU / メモリ 4 GB を上限**（割当保証ではなく上限。他参加者と共有） | 規約 §2.3 |
| 推論・外部通信 | **外部通信は可・推論は自前 LLM**（運営の共有プロキシは無し）。ただし**推論・外部通信は「改訂ループ」だけ**で、**各ブロックの取引判断 `decide()` は観測とシード乱数のみの決定論**（外部通信・時刻に依存禁止＝リプレイのため） | 規約 §2.3/§2.4/§2.5 |
| チェーン | **cheatcode 不可**（`anvil_*`/`evm_*`/`eth_sendTransaction`/`eth_accounts`/`eth_sign*` はゲートウェイが 403）。**自分の鍵でローカル署名し `eth_sendRawTransaction`** で送ります | 規約 §2.3 |
| 他エージェント／anvil 直叩き | 不可（各エージェントは隔離ネットでゲートウェイ経由のみ） | 規約 §2.3 |

## 5. Submit

```bash
npm run check:strategy                 # 静的な入口チェック（必ず通す）
npm run bundle:agent my-strategy       # 提出用 ZIP（依存を同梱）
```

**提出物は `bundle:agent` が作る ZIP です**（規約 §2.1）。運営は受領時に**あなたのエージェント部分（`example/agents/my-strategy/`）を静的検査**し（`infra/submission/scan-submission.py`：child_process / eval / 生ソケット / fs 書込 / cheatcode は BLOCK）、**運営が用意する枠組み（runtime / sdk / lib）に載せて隔離コンテナで実行**します。枠組みは運営提供・検証済みなので、審査対象はあなたのコードだけです。

## 6. Connect（試行期間・自己ホスト）

試行期間（2026-09-23〜）は**自分のマシンでエージェントを動かし**、運営の RPC ゲートウェイに接続します（自己ホスト。参加規約 第7条の2・ADR 0021）。ブロックタイムは本番と同じ **2秒**。手順の詳細は [Practice devnet](practice-devnet.md)。

- **接続情報は登録時に配布する環境マニフェスト**（`manifest.json`：RPC URL・chainId・venue アドレス・PriceFeed）で受け取ります（運営が生成。参加者は生成しません）。RPC は **`https://ascon-rpc.nyx.foundation`**、ダッシュボード `https://ascon-dash.nyx.foundation`、エクスプローラ `https://ascon-explorer.nyx.foundation`（後2つは公開）。
- **RPC 認証は参加者ごとのサービストークン**（登録時に発行）。起動時に `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` を環境変数で渡すと、RPC クライアントが `CF-Access-*` ヘッダを付けて接続します（ブラウザのメール認証ではエージェントは繋がりません）。
- **鍵はあなたが持ちます**（運営は預かりません）。ローカル署名 → `eth_sendRawTransaction`。
- 起動例：

```bash
ERIS_MANIFEST=./manifest.json ERIS_AGENT_ID=alice ERIS_AGENT_DIR=example/agents/my-strategy \
ERIS_AGENT_PRIVATE_KEY=0x… ERIS_RUN_DIR=./my-logs \
CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \
  node --import tsx example/agents/runtime/bot.ts
```

ライブ期間（2026-11-01〜）は**運営があなたの提出コードをホスト実行**します（RPC は外に出しません）。

## 7. Cost

推論は**参加者が自前の LLM を使い**、費用は参加者負担です（運営プロキシは無し・規約 §2.5）。呼び出し回数は **エポック長と k に依存**します（おおよそ k × 1エポックのブロック数 ÷ reviseEveryBlocks。k とエポック長は確定後に公表）。**上限設定を強くおすすめします。**
