[← README](../../README.md)

# 戦略の書き方（agent 作成チュートリアル）

新しい戦略は **`example/agents/<id>/` に 1 ディレクトリ**を作り、ロスターに id を足すだけで動く
（ADR 0015。spawn・観測・署名・送信・検証は `runtime/bot.ts` が全部やる）。この文書は
「最小 agent → 観測を読む → action を返す → ログを残す → backtest で回す → 提出」の一本道。

型は 3 つ（詳細は[アーキテクチャ](architecture.md)）。本ページは最も基本のルール戦略
（`decide()`）を軸に進める:

| 型 | 置くもの | 向く用途 |
|---|---|---|
| ルール戦略 | `agent.ts`（`decide(obs, ctx)`） | 大半の戦略。毎ブロック観測→判断 |
| 自走型 | `agent.ts`（`run(ctx)`） | 独自ループ・イベント駆動（例: liquidator） |
| プロンプト型 | `prompt.md` | LLM に毎判断させる（[LLM エージェント](llm-agents.md)） |

## Step 1: 最小の agent

```bash
mkdir example/agents/my-strategy
```

```ts
// example/agents/my-strategy/agent.ts
import type { AgentAction, AgentObservation } from "@eris/sdk";
import type { AgentContext } from "@eris/sdk/agent.js";

export function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): AgentAction | Record<string, unknown> | null {
  return { type: "noop", reason: "まだ何もしない" };
}

// 省略時は「新ブロックごとに 1 回」呼ばれる。間隔を変えるなら:
// export const config = { intervalMs: 5000 };
```

契約はこれだけ:

- 戻り値が action なら runtime が **validate してから**署名・送信する（不正 action はチェーンに
  出ず、`agents/<id>.jsonl` に `rejected` が残る = fail-closed）
- `null` / `undefined` を返せば見送り。**noop は立派な選択肢**（機会が無い市場で取引しないのが正解）
- throw しても run は落ちない（そのラウンドはスキップされ `decide error:` がログに残る）

## Step 2: 観測（AgentObservation）を読む

`obs` は runtime が毎ブロック再構成する「確定済み状態のスナップショット」。RPC を直接叩く必要は
ない（叩けるが、観測にあるものは観測から読むのが速くて安全）。実 run のサンプル（抜粋）:

```jsonc
{
  "round": 610,
  "blockNumber": "610",
  "fairPriceUsdcPerWeth": 2993.27,          // 環境が配布する fair price（1 ブロック遅れ = 仕様）
  "fairPricesUsd": { "WETH": 2993.27, "WBTC": 60065.96 },  // マルチアセット時の base 別 fair
  "balances": { "ethWei": "…", "wethWei": "0", "usdcUnits": "25000000000" },
  "inventory": { "valueUsdc": 339290.8, "weth": 0, "usdc": 25000, "eth": 105.0 },
  "history": [ { "round": 608, "poolPriceUsdcPerWeth": 3000.0, "fairPriceUsdcPerWeth": 3000 }, … ],
  "limits": { "maxWethInWei": "1000000000000000000", "maxUsdcInUnits": "5000000000",
              "defaultPriorityFeePerGasWei": "100000000", "defaultSlippageBps": 50, … },
  "protocols": { "uniswap": { "pool": { "priceUsdcPerWeth": 3000.0, "fee": 3000, … } },
                 "balancer": { "priceUsdcPerWeth": 2991.0 }, "curve": { … }, "aave": { … } },
  "competition": { "maxCompetitorPriorityFeeWei": "0", "recentRevertRate": 0, … }
}
```

読むときの注意:

- **トークン量は decimal 文字列**（`wethWei` は 18 桁 wei、`usdcUnits` は 6 桁）。`BigInt(...)` で
  扱う。`inventory` は人間可読の数値換算（概算）
- `history` は直近 ~20 ブロックの pool/fair 系列（モメンタムや乖離の持続を見る用）
- `limits` は per-round の取引上限と fee の既定/上限。**サイズはここで頭打ちにする**（超過 action
  は validate で弾かれる）
- `protocols.<venue>` の形は venue ごとに違う。**直読みせず、共有ヘルパで正規化するのが安全**
  （Step 4）。過去に `obs.pool` 直読みの TypeError → 全ラウンド noop という事故が頻発している

## Step 3: action を返す

action は JSON（zod スキーマ `sdk/src/actionSchema.ts` が正）。一覧は
[プロトコルとアクション](protocols-and-actions.md)。最小の swap:

```ts
// fair よりプールが 50bps 以上安ければ USDC で WETH を買う
const pool = obs.protocols.uniswap?.pool?.priceUsdcPerWeth;
if (!pool) return null;
const gapBps = (obs.fairPriceUsdcPerWeth / pool - 1) * 10000;
if (gapBps > 50) {
  return {
    type: "swap",                 // uniswap の WETH/USDC swap
    tokenIn: "USDC",
    amountIn: "500000000",        // 500 USDC（6 桁 units の decimal 文字列）
    slippageBps: 75,
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
  };
}
return null;
// 判断理由は action でなく ctx.log に載せる（Step 4。noop だけは reason フィールドを持つ）
```

複数 leg を 1 tx にするなら `type: "bundle"`（`actions: [...]`。GMX は非同期のため bundle 不可）。

## Step 4: 判断ログを最初から入れる

**これを省くと run 後のデバッグが桁違いに苦しくなる**（判断ログの無い戦略の損失調査は、チェーンの
receipt 精算まで降りることになる）。`ctx.log` で毎ラウンドの判断根拠を
`runs/<run_id>/agents/<id>.jsonl` に残す:

```ts
export function decide(obs: AgentObservation, ctx: AgentContext) {
  const signals = { fair: obs.fairPriceUsdcPerWeth, pool, gapBps };
  const action = pickAction(obs);   // あなたの判断ロジック
  ctx.log({ round: obs.round, action: action ?? { type: "noop" }, signals,
            reason: action ? "gap over threshold" : "no edge" });
  return action;
}
```

mempool 活動（submitted / rejected / submit_failed）は runtime が同じファイルに自動で残す。
読み方は [run 出力と解析](run-output.md)。

## Step 5: ロスターに登録して backtest で回す

```yaml
# my-roster.yaml（スパーリング相手と一緒に）
agents:
  - id: noop
    wallet: AGENT1_PRIVATE_KEY
    baseline: true
  - id: my-strategy          # ← ディレクトリ名がそのまま id
    wallet: AGENT2_PRIVATE_KEY
  - id: multi-arb            # 同梱のライバル戦略
    wallet: AGENT3_PRIVATE_KEY
```

```bash
npm run backtest -- --regime calm-01 --agents my-roster.yaml --repeat 5
npm run backtest -- --regime crash-01 --agents my-roster.yaml   # 別 regime でも見る
```

- 成績は `mean alphaUsdc`（β 除去 PnL）で読む。単発の netPnl は価格ドリフトに汚染される
- `--repeat` の分布で判断する（同一 regime でも tx 着順で僅かにぶれる。[バックテスト](backtest.md)）
- regime を跨いで確認する: calm で撃ちすぎない・crash で機会を取れる、の両立が実力

## 共有ヘルパ（example/agents/lib/）

venue 横断の戦略は `lib/markets.ts` の `marketViews(obs)` を使う。observation を
「base ごとの `{ fair, venues: [{protocol, price, feeBps, swapType}] }`」に正規化してくれる
（venue ごとの観測形の差・fee 込み見積りのミッド補正を吸収済み）:

```ts
import { marketViews } from "../lib/markets.js";

for (const view of marketViews(obs)) {
  // view.base ("WETH" | "WBTC" | …), view.fair, view.venues（価格は mid 相当に正規化済み）
}
```

## 落とし穴（実 run で確認済みのもの）

1. **手数料を無視した裁定は構造的に負ける**。fee-aware な informed flow が乖離を手数料バンド内
   （~30bps）に保つため、「gap > 当該 venue の fee + 安全マージン」を満たすときだけ撃つこと。
   閾値 10bps で毎ブロック撃った同梱戦略が 60 ブロックで −1,650 USDC を垂れ流した実測がある
2. **fair price は 1 ブロック遅れる**（オンチェーン配布の仕様。全員等しく遅れる）。fair が毎ブロック
   大きく動く窓では、古い fair 基準の執行が逆を踏む。乖離の「持続」を `history` で確認してから
   動くと安全
3. **初期資金は USDC のみが既定**（`funding.wethWei: "0"`）。WETH 売りから始める戦略は最初の
   ラウンドでは在庫が無い。`obs.balances` を見てから方向を決める
4. **サイズと fee は `obs.limits` に従う**。超過は validate で弾かれ、そのラウンドが無駄になる

## 提出

```bash
npm run check:strategy        # cheatcode 静的検査（入口ゲート）
npm run bundle:agent my-strategy   # 提出用 zip（runtime + sdk + lib + 対象 agent）
```

`example/agents/` の同梱戦略（noop = 最小形 / arb-bot = 判断ログ付きの手本 / multi-arb =
マルチアセット venue 横断 / liquidator = 自走型）はすべて読める実例として使える。
