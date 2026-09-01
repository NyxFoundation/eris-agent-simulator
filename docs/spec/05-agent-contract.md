[← 目次](README.md) ｜ [← 04 ストレスイベント](04-stress-events.md) ｜ [06 採点 →](06-scoring.md)

# 05. エージェント契約

出典 `sdk/src/agent.ts`（契約型）、`sdk/src/types.ts`（observation / action）、`example/agents/runtime/`（ランタイム）、`sdk/src/action.ts`（検証）。

## 5.1 1 エージェント = 1 ディレクトリ

`example/agents/<id>/` に置き、ロスターに id を足すだけで参加者が増える。起動は**一律 `runtime/bot.ts`** で、戦略ディレクトリは env `ERIS_AGENT_DIR` で指す。

| ディレクトリの中身 | 種別 | 動き方 |
|---|---|---|
| `agent.ts`（`decide(obs, ctx)` を export） | ルール戦略 | bot.ts が read→decide→send のループで駆動 |
| `agent.ts`（`run(ctx)` を export） | 自走型 | bot.ts はループせず ctx を渡して委譲 |
| `agent.ts` + `prompt.md`（`kind: improve`） | 自己改善型 | decide を毎ブロック駆動しつつ、LLM が**取引経路の外**で戦略コードを書き換える |

`runtime/`（汎用スクリプト）と `lib/`（共有ヘルパ）は**予約名**でエージェント id には使えない。

ロスターの `command` / `args` は完全自前エージェント（他言語等）の override で、read / send / validate をすべて自前で行う（サポート外）。

### 起動時の判定（`bot.ts:200-277`）

```
agent.ts が無い                            → exit 1
  （prompt.md だけある場合は「prompt モードは廃止された」と明示する）
agent.ts が decide も run も export しない  → exit 1
improve.md だけがある                      → exit 1（ADR 0018 Amendment 1 で prompt.md に改名された）
prompt.md に kind: improve が無い          → exit 1（下記）
prompt.md があるのに run(ctx) を export     → exit 1（自己改善は decide 戦略のみ）
ERIS_AGENT_MODE / ERIS_PROMPT_* が設定済み  → exit 1（廃止済み）
```

**`kind: improve` マーカーが必須な理由**：`prompt.md` は同じ名前で意味が逆になっている。旧形式は「この observation でどう動くか」、現形式は「いつ・何を根拠に・どう直すか」。旧形式 19 個は削除済みだが git 履歴と旧 bundle には残っており、**frontmatter のキー（name / description）も同じ**なので区別できるのはマーカーだけ。黙って読むと**取引指示が「改訂方針」として system prompt に入る**。

## 5.2 実行契約

### `decide(obs, ctx)`（ルール戦略）

```ts
type DecideFn = (obs: AgentObservation, ctx: AgentContext) =>
  AgentAction | Record<string, unknown> | null | undefined | Promise<...>
```

- 戻り値 `null` / `undefined` は「見送り」。**プレーンなオブジェクトでもよい**（ランタイムが parse / validate してから送るので、不正なアクションがチェーンに届くことはない）
- 既定の駆動は**新ブロックごとに 1 回**。`export const config = { intervalMs, offsetMs }` でタイマー駆動にもできる
- 再入しない（`deciding` フラグ）
- **見送りもログに残る**。`send.ts` は noop を落とすので、毎ブロック見送る戦略は何も残さず「起動しなかった」と「見て見送った」が区別できなくなる（`bot.ts:392`）

### `run(ctx)`（自走型）

プロセスの寿命 = run の寿命。bot.ts はループせず ctx を渡すだけ。署名・nonce・mempool の自己申告はランタイムが引き続き集中管理する。例：`liquidator`。

### `AgentContext`

```ts
type AgentContext = {
  agentId: string;
  address: Address;
  publicClient / walletClient;      // viem クライアント
  config: SimConfig;                // 同じ YAML から再構築したもの
  latestObservation(): AgentObservation | null;
  onObservation(cb): () => void;    // 購読解除関数を返す
  submit(action): void;             // 検証 → 署名 → mempool（拒否時は rejected をログ）
  log(entry: AgentLogEntry): void;  // runs/<id>/agents/<id>.jsonl へ追記
};
```

`submit` は**fail-closed**：検証に落ちたアクションは mempool ログに `rejected` を残してチェーンには届かない。

## 5.3 observation

`sdk/src/observation.ts` の `observationFor` が構築する。**環境の採点とエージェントの観測が同じ関数を通る**のが要点。

### 構造（`sdk/src/types.ts:634`）

| フィールド | 内容 |
|---|---|
| `runId` / `round` / `blockNumber` / `agentAddress` | 同定情報。`round` は**絶対チェーンブロック番号** |
| `fairPriceUsdcPerWeth` / `oraclePrices` | fair price（1 ブロック遅れ） |
| `fairPricesUsd` / `baseBalances` / `baseDecimals` / `markets` | マルチアセット。WETH のみの run では既存フィールドと一致する |
| `blocksRemaining` | **このエージェントが最初に観測したブロックから数えた**残りブロック数。run に上限が無ければ undefined |
| `enabledProtocols` | この run で有効な venue |
| `balances` | `ethWei` / `wethWei` / `usdcUnits` / `stables{}` |
| `inventory` | `valueUsdc` ほか。**評価はこちら**（`balances` は予算） |
| `history` | 直近 20 ラウンドの pool 価格と fair 価格 |
| `limits` | 上限一式（§5.5） |
| `protocols` | venue ごとの観測（`ProtocolObservations`） |
| `competition` | 直近ブロックの入札状況（`economicGas` 用。ADR 0011） |

### 読み方の規律

- **`usdcUnits` は native USDC だけ**（issue #27）。これは*予算*であって評価額ではない。以前は全 active stable の合計だったが、USDT は USDC プールで使えないので**どこでも使えない額**を表示していた。ウォレットの価値は `inventory.valueUsdc`
- **`balances.stables[sym].marketQuoted: false` は「市場が答えなかったので par を仮置きした」**。`priceUsdc: 1` を「ペグが保たれている」と読んではいけない
- **`blocksRemaining` は 1〜2 ブロックの誤差を含む**。エージェントは競技開始ブロックのあたりから観測を始めるので、それより前ではない。LST の出金キューを「形式ではなく判断」にしているのがこの値（run 内に終わらない exit は完了できない）
- LST の `discountBps` は `marketQuoted` を確認してから使う（quote が返らなければ 0 であって「100% ディスカウント」ではない）
- Liquity の `trove.positionKnown: false` のとき `positionFromRiskiest` と `redeemedAheadEusdWei` は無意味

## 5.4 アクション

### 語彙（25 種の leaf + 制御 4 種）

`ACTION_TYPES_BY_PROTOCOL`（`sdk/src/action.ts:42`）が**その run で有効な語彙の単一の出典**。

| protocol | アクション |
|---|---|
| `uniswap` | `swap` / `mintLiquidity` / `removeLiquidity` / `collectFees` |
| `balancer` | `balancerSwap` |
| `curve` | `curveSwap` / `stableSwap` |
| `gmx` | `gmxIncrease` / `gmxDecrease` |
| `aave` | `aaveSupply` / `aaveWithdraw` / `aaveBorrow` / `aaveRepay` |
| `lst` | `lstDeposit` / `lstSwap` / `lstRequestWithdraw` / `lstClaimWithdraw` |
| `liquity` | `liquityOpenTrove` / `liquityAdjustTrove` / `liquityCloseTrove` / `liquityRedeem` / `liquityProvideToSP` / `liquityWithdrawFromSP` / `liquityLiquidate` / `liquitySwapEusd` |

制御系：

| type | 内容 |
|---|---|
| `noop` | 何もしない（`reason` を添えられる） |
| `bundle` | 複数の leaf を 1 tx として不可分に実行。**GMX は入れられない**（keeper の執行が必要なため） |
| `rawTx` / `rawBundle` | 生の calldata。`to` / `data` / `value` |

`test/actionVocabulary.test.ts` が改名・削除を検出する。

### 単位の規約

| 種別 | 単位 |
|---|---|
| base 量 | wei（そのトークンの decimals。WETH=18 / WBTC=8） |
| stable 量 | そのトークンの units（USDC=6 / DAI・eUSD=18） |
| GMX の `sizeDeltaUsd` | 1e30 スケール USD |
| GMX の `acceptablePrice` | 1e(30−decimals) スケール |
| 手数料 | wei/gas |
| スリッページ | bps |

**`stableSwap` の per-round 上限は USDC の 6 decimals 建て**なので、18 decimals の stable では換算が必要。実測でこれを忘れると sell が毎回 reject され、買いだけ通って「閉じられないポジションの含み益」になる（42 reject / 6 accept）。

### 検証（`validateAction`）

`sdk/src/action.ts:190`。順序は次の通り。

1. `noop` は無条件で通る
2. `bundle` は空でないこと・`limits.maxBundleActions` 以内であること
3. 各 leaf について priority fee が `limits.maxPriorityFeePerGasWei` 以下であること
4. アダプタの `validate(action, obs, work)` を通すこと
5. `mintLiquidity` は `limits.maxOpenPositions` を超えないこと
6. **バンドル内の累積残高**を追跡すること

**バンドルの累積検証**が重要で、各 leaf を「残高から先行 leaf が消費した分を引いたもの」に対して検証する。さらに**swap の推定出力を戻し入れる** — これが無いと「USDC→WETH で買って WETH→USDC で売る」2 脚の裁定が、売り脚の時点で WETH 残高 0 と判定されて拒否される（USDC-only 配布で純 α を測るという前提が壊れる）。

## 5.5 limits

`observationFor` が config から組み立てて observation に載せる（`sdk/src/observation.ts:94`）。

| limits フィールド | config キー | 意味 |
|---|---|---|
| `maxWethInWei` / `maxUsdcInUnits` | `limits.agentWethWei` / `agentUsdcUnits` | 1 ラウンドあたりの swap 入力上限 |
| `baseLimits[sym]` | `limits.agentBase` / `lpBase` / `aaveSupplyBase` | 追加 base の per-round 上限（`"0"` = 上限なし = 残高律速） |
| `maxLpWethWei` / `maxLpUsdcUnits` | `limits.lpWethWei` / `lpUsdcUnits` | LP 提供の上限 |
| `maxBundleActions` | `limits.bundleActions` | バンドルの要素数 |
| `maxOpenPositions` | `limits.openPositions` | LP 建玉数 |
| `maxGmxSizeUsd` | `limits.gmxSizeUsd` | perp サイズ |
| `maxAaveSupplyWethWei` / `maxAaveBorrowUsdcUnits` | `limits.aaveSupplyWethWei` / `aaveBorrowUsdcUnits` | Aave |
| `maxLstDepositWethWei` | `lst.maxDepositWethWei` | 1 回のステーク上限（`"0"` = 残高律速） |
| `defaultPriorityFeePerGasWei` / `maxPriorityFeePerGasWei` | `limits.priorityFeeWei` / `maxPriorityFeeWei` | 手数料 |
| `defaultSlippageBps` | （固定 50） | 既定スリッページ |

**`economicGas: true` のときは `maxPriorityFeePerGasWei` が実質無制限（10¹⁸ wei/gas）になる**（`observation.ts:103`）。上限強制を退役させた以上、提示側の値も上げないと高額入札が黙って拒否される。実効的な上限は EIP-1559 の残高制約になる。

## 5.6 送信（`runtime/send.ts`）

1. `parseAction` → 失敗なら `bad_action`
2. `validateAction` → 失敗なら `rejected`
3. アダプタの `buildTxs` で tx を組む
4. 署名して送信（**nonce は自己管理**）
5. mempool ログに自己申告（`kind: "mempool"`、`event: submitted` / `submit_failed` / `rejected`）

**自己申告が必要な理由**：direct 送信では coordinator が「提出されたが取り込まれなかった tx」を数えられない。この穴を塞ぐのが自己申告ログ（ADR 0006 §5）。

`economicGas` プロファイルでは**ガスマネージャ**が働く（`maybeRefillGas`）。ETH 残高が閾値を下回ると補充 tx を積む。補充後 3 ブロックはクールダウンする（着弾と残高反映を待つ）。

## 5.7 自己改善（ADR 0018）

**LLM は取引経路にいない。** 戦略は毎ブロック自分で取引し、LLM は定期的に**戦略コードそのものを書き換える**。

> 毎判断 LLM（prompt モード）は ADR 0018 で廃止された。実測で 1 判断 8〜28 ブロック・行動回数がルール型の 1/64 で、競技として成立しなかった（ADR 0017 §5 B1）。

### `prompt.md`

```yaml
---
kind: improve            # 必須。無ければ fail-fast
name: <名前>              # 必須
description: <説明>       # 必須
reviseEveryBlocks: 60    # 任意（既定 60）
model: <モデル名>          # 任意（ロスターの ERIS_LLM_MODEL より優先）
---
本文 = 改訂方針（いつ・何を根拠に・どう直すか）
```

### 改訂サイクル

| 段 | 内容 |
|---|---|
| 発火 | `obs.round − lastRevisionBlock >= reviseEvery`。**最初の観測ではベースラインを設定するだけで発火しない**（`obs.round` は絶対ブロック番号なので、0 起点だと最初の観測が即座に「期限超過」になる） |
| 上限 | **1 run あたり 12 回**（`MAX_REVISIONS_PER_RUN`）。参加者の宣言が `runBlocks/12` より短ければ clamp し、**clamp したことをログに残す**（同居 run は 1 つの LLM 予算を共有するため） |
| 入力 | 現在の戦略ソース・版履歴・各版インストール時の価値・直近 32 件の判断・最新 observation・**この run で有効な venue のアクション語彙** |
| 出力 | `{notes, executorTs}` か `{notes, revertTo: <version>}`。`executorTs: null` は「今の戦略を維持」 |

**アクション語彙を渡す理由**：渡さないと LLM の手掛かりは現在の戦略コードだけになり、**一度も swap したことのない戦略は `swap` の存在を知りようがない**。実測で USDC-only 配布の `lp-provider` が 18/18 シナリオ無取引だった（`improve.ts:328-334`）。

### 3 段のゲート（`compileExecutor`）

```
1. cheatcode 静的検査   findCheatcodeUsage が 1 件でも当たれば拒否
2. コンパイル            vm.Script。sandbox は Math/JSON/Number/String/Boolean/Array/Object/
                        BigInt/Map/Set/isFinite/isNaN/parseFloat/parseInt のみ
                        （require / process / fs / fetch は無い）
3. 実行時間の上限        1 回の呼び出しを 2,000ms で打ち切る
```

**vm はサンドボックスではない**（`improve.ts:228-237`）。`ctx` が渡される以上、生成コードは手書き戦略とまったく同じ自由度でチェーンを触れる。vm が取り除くのは*環境能力*だけで、意図に対処するのは cheatcode 検査の方である。

戻り値は `structuredClone` で自分の realm に持ち帰る（vm 内で作ったオブジェクトは `instanceof Object` に失敗し、検証やログの遠い場所で問題が出る）。

### 自動 rollback は無い

閾値に妥当な値が無いため。旧実装は 18 run 中 0 件発火し、逆に「少しでも負けたら」だと全員が負けるレジームで毎回巻き戻る。**戻すかどうかはモデルの判断**で、版履歴を渡して `revertTo` で行う。revert は履歴を巻き戻すのではなく**新しい版として再インストール**する（何がいつ動いたかの記録を消さないため）。

### frozen 対照

ロスターの `env: { ERIS_AGENT_FROZEN: "1" }` で prompt.md を無視して戦略を固定する。ADR 0018 §5 が要求する**「自己改善が効いたかを毎 run 見えるようにする」対照**を、ディレクトリ複製なしで作るための仕組み。

### LLM バックエンドが無いとき

run は完走する。改訂は失敗として記録され、戦略は無改変で走り続ける。バックエンドは `ERIS_LLM_MODEL` で選ぶ（API キー無しでも `codex[:<m>]` / `claude-cli[:<m>]` でサブスク CLI を起動できる）。`ERIS_IMPROVE_LOG_CALLS: "1"` で生のやり取りを `agents/<id>.llm.jsonl` に残せる（既定 off。全生成戦略が丸ごと入るため）。

## 5.8 cheatcode 静的検査

`sdk/src/strategyStaticCheck.ts`。**入口ゲート**（`npm run check:strategy`）と**LLM 生成コードの設置前**の両方で使う。

| ルール | 検出対象 |
|---|---|
| anvil cheatcode RPC | `anvil_*` |
| evm cheatcode RPC | `evm_*` |
| hardhat cheatcode RPC | `hardhat_*` |
| 環境専用ヘルパ | `setEthBalance` / `dealErc20` / `impersonate` / `stopImpersonate` / `sendAsImpersonated` / `setIntervalMining` / `setAutomine` / `resetFork` |

正規表現によるソース検査であり、**完全ではない**。事後監査（[11](11-invariants.md)）と対で使う。sdk に置いてあるのは core と example の両方が必要とするためで、依存方向（`example → sdk ← core`）の帰結でもある。

## 5.9 外部参加者（自己ホスト）

ADR 0021 §2。環境がプロセスを起動しない登録エントリ。

- ロスターに `external: true` + `address`（参加者が鍵を持つ）または `wallet`（運営が発行して渡す）
- **`command` / `args` / `dir` / `env` は黙殺せず拒否する**（黙って落とすと「運営が動かしている」ように読めるロスターになる）
- 資金配布・tx の帰属・採点・ルール検査は**すべてアドレス基準**なので、鍵は「起動する」ためだけに必要 = 外部エントリには要らない
- **判断ログは参加者のマシンにしか無い。** ダッシュボードは agent ページの判断ログタブを external では出さず、そう書く（空パネルは「このエージェントは何も考えなかった」という別の主張になる）
- `bot.ts` は `ERIS_MANIFEST` から RPC URL と PriceFeed アドレスを読める（環境が注入できない 2 つ）。マニフェストが読めなければ**起動を拒否する**（env にフォールバックすると、シェルにたまたま入っていたチェーンで誰にも採点されない取引をすることになる）
- 自己ホストのエージェントは**自分で venue approve を出す**（`ensureVenueApprovals`）。既に十分な allowance があればスキップするので、再起動しても endowment を削らない

## 5.10 提出

`npm run bundle:agent <id>` が提出用 zip を作る（runtime + sdk + lib + 対象エージェント。ADR 0015 §7）。**エージェントディレクトリがコピーと提出の単位**であり、バンドルされた戦略はその参加者のものになる（[README](../../README.md) の License 節）。
