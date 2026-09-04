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
npm run backtest -- --scenarios <公式シナリオセット>.yaml --agents my-roster.yaml  # 全レジーム x シード（公式セットは規約 §3.2/§3.3。詳細は backtest.md）
```

Read `runs/<run_id>/agents/<id>.jsonl` for your decisions and the `submitted`/`rejected` markers the
runtime leaves. See [Run Output and Analysis](run-output.md).

## 4. The competition constraints (know these before you optimize)

**権威ある制約は `docs/competition-rules.md` §2.6 です。**下表は要点で、値が競技規約と異なる場合は規約が優先します。

| 制約 | 値 | 出典 |
|---|---|---|
| 1ブロックの tx 本数 | **最大 3 本**（超過は operator が送信前に reject。運営は per-tx ガス上限も課します） | 規約 §2.6 |
| ブロックガスリミット | **320,000,000 gas** | 規約 §2.6 |
| ブロック内の順序 | **priority fee の高い順**（到着時刻ではない） | 規約 §2.6 |
| ブロックタイム | **規約の現行値（負荷試験に基づき 2026-09-23 に最終確定・公表）** | 規約 §2.6・§2.6.1 |
| リソース割当 | **規約 §2.4 の値に従う** | 規約 §2.4 |
| 推論・外部通信 | **規約 §2.3・§2.5 に従う**（運営で方式を確定中——[[この節は確定後に更新]]） | 規約 §2.3/§2.5 |
| チェーン | **cheatcode は使えません**（`anvil_*`/`evm_*` は RPC ゲートウェイが 403）。`eth_sendTransaction`/`eth_accounts`/`eth_sign*` も不可。**自分の鍵でローカル署名し `eth_sendRawTransaction`** で送ります | docs/24 §4 |
| 他エージェント／anvil 直叩き | 不可（各エージェントは隔離ネットでゲートウェイ経由のみ） | docs/24 §4 |

## 5. Submit

```bash
npm run check:strategy                 # static entry-gate check (must pass)
npm run bundle:agent my-strategy       # self-contained zip for local running
```

**提出物はあなたのエージェント（`example/agents/my-strategy/`）です。**runtime / sdk / lib は運営が
用意する枠組みで、提出物には含めません（`bundle:agent` の zip は「手元で単体実行するため」の形式で、
枠組みごと固めます）。運営は受領時に**あなたのエージェント部分だけを静的検査**し（`infra/submission/scan-submission.py`。
child_process / eval / 生ソケット / fs 書込 / cheatcode は BLOCK）、隔離コンテナに載せて実行します。

## 6. Connect（試行期間・自己ホスト）

> この節は試行環境の設計（ADR 0021「常時稼働の練習用 devnet と自己ホスト型エージェント参加」・docs/adr/）に基づきます。**参加規約の該当条文（第7条の2 等）は現在この設計に合わせて更新中**なので、公表時は規約が優先します。

試行期間（2026-09-23〜）は**自分のマシンでエージェントを動かし**、運営の RPC ゲートウェイに接続します。

- 接続先 RPC URL と chainId、venue アドレス一式は**環境マニフェスト**で配布します（`npm run manifest`）。
  **URL は公開直前に確定・案内します（TBD）。**
- 認証は**参加者ごとのサービストークン**（`CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダ）。
  ブラウザのメール認証ではエージェントは繋がりません。
- **鍵はあなたが持ちます**（運営は預かりません）。ローカル署名 → `eth_sendRawTransaction`。

ライブ期間（2026-11-01〜）は**運営があなたの提出コードをホスト実行**します（RPC は外に出しません）。

## 7. Cost

推論の実行方式（運営経由か自前か）と費用負担は **規約 §2.5 に従います**（運営で方式を確定中）。呼び出し回数は **エポック長と k に依存**します（おおよそ k × 1エポックのブロック数 ÷ reviseEveryBlocks。k とエポック長は確定後に公表）。費用が生じる場合は **上限設定を強くおすすめします。**
