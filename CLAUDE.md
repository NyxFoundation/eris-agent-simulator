# CLAUDE.md

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。

## パッケージ構成（core/sdk/example 3 workspace。ADR 0015）

```
sdk/       @eris/sdk — 契約レイヤ（types / action(zod) / chain / markets / protocols / observationFor / SimConfig）
core/      環境デーモン + 採点（realtime coordinator / anvil / flow / stress / vuln / cli）。参加者は触らない
example/   参加者テンプレート。example/agents/ がコピー・提出の単位
deployer/  venue デプロイ（自己完結サブパッケージ。workspace 外）
```

依存方向は **`example → sdk ← core`** のみ（`npm run check:boundaries` が検査）。
旧 `src/` / `examples/` は撤去済み。旧 LLM 自己改善機構（src/llm）と未参照戦略の `_archive/` も削除済み
（復元は `git checkout 4a65a8f -- _archive`）。

## エージェントの書き方（1 agent = 1 ディレクトリ。ADR 0015 §2-4）

`example/agents/<id>/` に次のいずれか 1 枚を置き、ロスターに id を足すだけで agent が増える:

| 中身 | 種別 | 動き方 |
|------|------|--------|
| `agent.ts`（`decide(obs, ctx)` export） | ルール戦略 | runtime/bot.ts が read→decide→send のループで駆動（`export const config = { intervalMs }` で間隔指定可） |
| `agent.ts`（`run(ctx)` export） | 自走型 | bot.ts はループせず ctx（clients/observe/submit/log）を渡して委譲（例 liquidator） |
| `agent.ts` + `improve.md`（frontmatter: name/description 必須） | **自己改善型**（ADR 0018） | decide を毎ブロック駆動しつつ、LLM が取引経路の**外**で戦略コードを書き換える |

`runtime/`（汎用スクリプト: bot/read/send/llm/improve/deploy/agentLog）と `lib/`（共有戦略ヘルパ）は予約名。

**プロンプト型（毎判断 LLM）は ADR 0018 で廃止**。実測で 1 判断 8〜28 ブロック・行動回数がルール型の
1/64 で競技として成立しなかった（ADR 0017 §5 B1）。`ERIS_AGENT_MODE` / `ERIS_PROMPT_*` は fail-fast する。
`improve.md` は prompt.md の改名ではない（前者は「いつ・何を根拠に・どう直すか」、後者は「この observation で
どう動くか」）。ロスターの `env`:

- `ERIS_AGENT_FROZEN: "1"` — improve.md を無視して戦略を固定。**ADR 0018 §5 が要求する frozen 対照**
  （自己改善が効いたかを毎 run 見えるようにする）をディレクトリ複製なしで作る
- `ERIS_LLM_MODEL: "<model>"` — 改訂呼び出しのバックエンド（improve.md の frontmatter が優先）。
  API キー無しでも `codex[:<m>]` / `claude-cli[:<m>]` でサブスク CLI 実行可 = docs/guide/llm-agents.md
- `ERIS_IMPROVE_LOG_CALLS: "1"` — 改訂の生のやり取りを `agents/<id>.llm.jsonl` に残す（既定 off）

改訂は `{notes, executorTs}` か `{notes, revertTo: <version>}` を返し、`executorTs: null` は
「今の戦略を維持」。生成コードは **cheatcode 静的検査 → コンパイル → 2 秒の実行上限**を通ってから設置。
**自動 rollback は無い**（閾値に妥当な値が無いため。旧実装は 18 run 中 0 件発火、逆に「少しでも負けたら」
だと全員が負けるレジームで毎回巻き戻る）。戻すかどうかはモデルの判断で、版履歴を渡して `revertTo` で行う。
LLM バックエンドが無くても run は完走し、改訂失敗が記録されて戦略は無改変で走り続ける。
directShim / relay / stdin-stdout プロトコルは廃止済み（ERIS_AGENT_DIRECT_TX は退役）。

## 設定（YAML 単一ソース。ADR 0013）

run の設定値とエージェントロスターは **`config/local.yaml` 一本**で管理する（env からの設定読取は廃止）。
解決順は `--config <path>` > `ERIS_CONFIG` > `config/local.yaml` > `config/example.yaml`（committed 雛形 = zero-config 既定）。
**雛形は `run.localDeploy: true` 既定**（README Quick Start と config/regimes/* に揃えた。fork 用フラグは不要になり
`npm run sim:realtime` だけで走る）。fork に戻すには `localDeploy: false` + `run.protocols` から `lst` を外す
（LST の vault は自作で Arbitrum に対応物が無い）+ `ARB_RPC_URL` + 別端末で `npm run anvil`。
キーは**ネスト lowercase**（`run` / `funding` / `limits` / `flow` / `stress` / `vuln` + `agents`）で
`sdk/src/runConfig.ts` の `SCHEMA` が内部キーへ写す。ロスターは規約解決（ADR 0015 §6）:

```yaml
agents:
  - id: arb-bot                # example/agents/arb-bot/ を runtime/bot.ts が駆動
    wallet: AGENT2_PRIVATE_KEY
  - id: clean-arb-wide         # 同一戦略の複数体は dir で実体ディレクトリを指す
    dir: clean-arb
    wallet: AUTO
    env: { ERIS_ARB_SAFETY_BPS: "150" }   # agent プロセスへ渡す戦略パラメータ
```

明示 `command`/`args` は完全自前 agent（他言語等。read/send/validate 全部自前 = サポート外）の override。
**env に残るのは秘密情報（`.env.local`: RPC/鍵/API キー）・agent IPC（`ERIS_AGENT_*`）・設定ファイル選択
（`ERIS_CONFIG`）のみ**。run ノブは CLI フラグ（`--seed` / `--blocks` / `--protocols` / `--agents` 等）で
一回限り上書きできる。

## 実行コマンド

- `npm run anvil` — 別ターミナルで Anvil フォークを起動（sim:realtime の前提。ローカルデプロイモードでは不要）
- `npm run sim:realtime` — 実時間 run を 1 回実行（設定は `config/local.yaml`。`--config <path>` で別ファイル、`--seed`/`--blocks`/`--protocols`/`--agents` 等で一回上書き）
- `npm run build:contracts` — モックオラクル + PriceFeed を forge build（sim:realtime の前提。`out/` 未生成なら最低 1 回）
- `npm run gen:local-constants` — deployments.json → `sdk/src/constants.local.ts` 生成（同梱 `deployer/` のローカルデプロイ出力を読む）
- `npm run gen:state-dump` — 稼働中の deployer anvil から配布用 state dump + manifest（生成元コミット・deployments 同梱・fingerprint）を `backtest/state/` へ生成（ADR 0016。dump 前に `.local-snapshot` のクリーン断面へ revert し、constants.local.ts も同じ deployments から再生成）
- `npm run backtest -- --regime <name> --seed <N>` — シナリオ 1 本を再生（ADR 0016 Phase 0 = B1 実時間再生）。state dump をロードした専用 anvil（既定 port 8547）で `config/regimes/<name>.yaml` + seed を再生する。**シナリオ = (regime, seed)** で regime YAML は seed を持たないので `--seed` は必須（ADR 0017 §1）。`--agents <roster>`（regime 既定ロスターの差し替え）/ `--protocols`/`--blocks`/`--score-every` 等の一回上書き。**override は実効 regime YAML に書き出されて agent プロセスにも伝播**（coordinator だけに効かせると agent が観測で死ぬ）。fingerprint 不一致は manifest 同梱 deployments から constants を自動再生成、genesis 不一致は fail-fast
- `npm run backtest -- --scenarios config/scenarios/public.yaml` — シナリオ行列を 1 つの anvil 上で全部再生し順位を出す（ADR 0017）。`{regimes, seeds}` の直積で、シナリオ間は snapshot/revert。`runs/matrix-<id>/matrix.json`（シナリオ × agent の生スコア。**netPnlUsdc と alphaUsdc の両方**）と `standings.json`（レジーム内 z-score → レジーム等重み平均）を書く。順位は派生物で、採点方法は将来見直す前提（matrix.json から再計算できる）。`--metric netPnlUsdc|alphaUsdc` / `--repeat N`（較正の診断用。採点は 1 回が既定）
  - **公式レジーム**: `calm` / `cex-drift`（OU に drift、kappa 弱化）/ `informed-flow`（相関した方向性フロー）/ `whale`（単発大口の点イベント）/ `lending-incident`（暴落 + victim + 清算）/ `crash`（価格ギャップのみ。流動性引き抜きは issue #52 待ち）。`depeg` は採点方法の見直し待ち。`lst` は競技セット外
  - `--score-every N` は採点断面の間引き。成績は初期/最終断面しか使わない（`alphaByAgent = alphaLast − alphaFirst`）ので**スコアは不変**、equity curve が粗くなるだけ
- `npm run typecheck` / `npm run test` — 型チェック / ユニットテスト
- `npm run check:strategy` — 戦略コードの cheatcode 静的検査（入口ゲート）
- `npm run check:boundaries` — workspace 依存方向（example → sdk ← core）の検査
- `npm run bundle:agent <id>` — 提出用 zip（runtime + sdk + lib + 対象 agent。ADR 0015 §7）

> **deployer は本 repo 同梱**（`deployer/`。旧 `../eris-app-deployer` を統合）。全 protocol を空の anvil へ deploy する自己完結のサブパッケージ（独自の `package.json` / `foundry.toml`）。初回のみ `cd deployer && npm install && forge build && cp .env.example .env && ./scripts/setup-vendors.sh`。以降は `cd deployer && npm run deploy -- --keep-fresh` で anvil 起動＋全 venue deploy。`vendor/` の重いクローン（gmx-src/curve-src/twocrypto-src）は git 管理外で `setup-vendors.sh` が再現する。

> 評価・採点・可視化系コマンド（`sim` 同期ラウンド / `evaluate` / `gate` / `discrimination` / `leaderboard` / `dashboard` / `stress-report`）は撤去済み。run は `sim:realtime` 一本。run 後の解析は `runs/<id>/` の `summary.json` / `events.jsonl` / `blocks.csv` を直接読む。

### 市場ストレスイベント（spike/crash + Aave 清算。ADR 0009。既定 off）

OU の base price はそのまま進め、その上に **SEED 由来でランダム化した決定論オーバーレイ**（`core/src/realtime/events.ts` `EventSchedule`）を重ねて effective price を導出する。effective が PriceFeed・Aave WETH オラクル・GMX・採点へ一貫伝播し、窓外では β≈0 を保つ（ADR 0007 を毀損しない）。清算を成立させる **seed 由来 victim 群**（採点対象外）を建てる。`config/local.yaml` の `stress:` セクションで指定:

- `stress.events` — イベント配列（**値でなくレンジ**を与え過学習を抑制）。YAML 配列で書ける（例: `- { type: crash, magnitudeRange: [0.12, 0.16], windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }`）。`spike`/`crash` の台形（ramp→hold→decay）。要 `run.blocks>0`
- `stress.victimCount`(既定 0=無効) / `stress.victimHf0`(既定 1.10) / `stress.victimWethWei`(victim 1 体の supply)。**較正の連動**: 建てるには `HF0 ≳ LT/(0.97·LTV)`（実測 Arbitrum WETH の LT=0.84/LTV=0.80 で ≈1.08。これ未満は borrow が LTV 縁に張り付くため fail-fast）。割るには crash magnitude `m > (HF0−1)/HF0`（HF0=1.10 なら m>9.1% → 例の [0.12,0.16] で確実に割れる）。breach 不能な設定は `stress_calibration_warning` を emit。borrow がサイレント revert したら setup で fail-fast(debt 検証)
- **victim を建てるには fresh state 必須**（soft-reset だと前 run の victim ポジが残留して HF が壊れる。未満は fail-fast）: fork は full re-fork（`ARB_RPC_URL` 設定 + `ERIS_SKIP_RESET` 不可）、ローカルデプロイは resetFork の snapshot/revert クリーン断面で満たす（ADR 0016。backtest で実証済み）。ローカルでは victim を建てる前に Aave オラクルを初期 fair price へ較正する（fork の「オラクル≈実勢≈fair0」が成立しないため。coordinator が自動実行）
- stress run（events かつ `ERIS_RUN_BLOCKS>0`）は**時間制限を自動無効化**しブロック数で終了する（`ERIS_RUN_SECONDS` が先に切れて crash 窓へ到達しない事故を回避。override は `stress_run_time_limit_disabled` で記録）
- coordinator は `stress_schedule` / `stress_victim_hf` / `stress_liquidation` を events.jsonl へ emit する。liquidator agent には victim アドレスを `ERIS_LIQUIDATION_VICTIMS` で配布する。清算の帰属は agent ログの `liquidationCall`(rawTx) を一次情報にする（events.jsonl を直接読んで解析する。旧 stress-report ツールは撤去済み）

### LST venue（wstETH 風 vault + LST/WETH 二次市場。issue #38 Phase 1。既定 off・**ローカルデプロイ専用**）

利回りで償還レートが上がる非 rebasing の LST（`deployer/contracts/MockLSTVault.sol`）と、その二次市場
（既存 stableswap-ng factory 上の LST/WETH plain pool）。**同じ資産に価格が 2 つある**のが本質:
`redemptionRateWeth`（vault が負う par。ただし出金キュー `withdrawalDelayBlocks` 待ち）と
`marketPriceWeth`（プールが今払う額。discount 付き）。observation は両方 + `discountBps` /
`yieldPerBlockBps` / キュー長 / 自分サイズでの `instantExitWethWei` / pending を別々に出す。

- **Arbitrum に対応物が無い**（vault は自作）ので fork では使えない。`run.protocols` に `lst` を入れて
  ローカルデプロイでないと起動時 fail-fast。**`config/example.yaml` の既定ロスターに入っている**
  （`cd deployer && npm run deploy -- --keep-fresh` → `npm run gen:local-constants` → `npm run sim:realtime`）。
  LST 単独で見たいときは競合参加者と較正ノブを明示した `config/lst.yaml`
- **利回りは EVM 時間でなく経済クロック**（`lst.simulatedSecondsPerBlock` / `lst.apyBps`。既定 1 block=1h・3%/yr
  = Aave WETH supply と同オーダー。速すぎると他 venue が無意味になる）。原資は事前投入 reward reserve に上限され、
  `accrueRewards()` は permissionless（額はブロック数の純関数なので誰が叩いても同じ）。coordinator は毎ブロック
  oracle tx と**同じ admin nonce の直列**で叩く（並列にすると nonce 衝突でレートが凍る）
- **プールの rate oracle 配線が要**（`stEthPerToken()` を asset_type=1 で登録）。未配線だとレート上昇が全員に開かれた
  無リスク裁定になる（ADR 0007 を毀損）。deploy 時 assert + 起動時 `lst_setup` で乖離 200bps 超は fail-fast
- **採点は realizable**（`sdk/src/protocols/lst.ts` `realizableWethWei`）: shares は「今プールで売った額」と
  「run 終了までに finalize するキューの par」の**良い方**。run 終了後にしか claim できない pending は価値から外し
  `reason:"unrealizable"` で `scoring_unpriced_holdings` に報告する（黙って 0 にしない）。#41 の staged-read
  インターフェース（`valueAtBlock` / `liquidatableValueUsdc` / `ValuationContext.horizonBlock`）の最初の消費者
- **Phase 2（選択を非自明にする）実装済み**。`config/lst.yaml` の `lst:` / `stress:` に較正例:
  - **APY 変動** — `lst.apyRangeBps` + `apyStepBlocks` で seed 由来 Rng（独立 salt）から N ブロックごとに再サンプル
    → coordinator が `setRewardRate`。固定利回りだと「block 0 で全ステーク」が恒久最適になるため
  - **キュー混雑 + サイズ依存** — vault の finalize をスループット律速に（`queueThroughputWeiPerBlock`）。
    `claimableAt = max(floor, queueDrainBlock) + ceil(assets/throughput)` = 大口ほど待ち、先客がいるほど待つ。
    観測は実効待ちを `estimatedQueueDelayBlocks`（自分の全保有）と `queueDelayPerWethBlocks`（限界 1 WETH）で分けて出す。
    **採点も実効待ちを使う**（floor で判定すると完了不能な exit を par 評価してしまう）
  - **`lstSlash`** — ADR 0009 と同じレンジ config で `stress.events` に書ける点イベント。1 ブロックで rate を恒久的に下げる。
    **discount は開かない**（プールが rate oracle 追随でリプライスする＝oracle が正しく効いている証拠）。
    slash は「保有者が損をする」リスクであって裁定機会ではない。よって magnitude は利回りスケールで較正する
    （70 ブロック run の利回り ~3-8bps に対し 10-30bps。最初に試した 100-300bps は利回りの 15 倍でステーク自体が常に負けになった）
- **Phase 3（レバレッジ）実装済み**。`run.protocols` に `aave` を足すと有効:
  - deployer が LST を **Aave の担保専用 reserve** として登録（`registerLstReserve`。LTV 70% / LT 75% /
    bonus 7.5%。**borrow は無効**＝現実の LST 上場と同じで、狙いは「LST を担保に ETH を借りる」レバステーキング）。
    Aave 自身の同名 reserve から clone できないため **LTV/LT は明示指定**（issue #38 が指摘した通り）。
    rate strategy のみ WETH から借用
  - **価格は WETH × 償還レート**。専用 MockAggregator を持ち、`sdk/src/protocols/oracles.ts` が
    他の全オラクルと同じ 3 経路（mined / mempool / storage）で毎ブロック書く。よって **1 ブロック遅れ**を継承し、
    slash はまず vault に効き、次ブロックで HF に届く = liquidation cascade の起点
  - `aaveSupply`/`aaveWithdraw` の asset に `"LST"` を指定可能（`TokenKind` に `"lst"` を追加し、
    scorer の spot 掃引から外して二重計上を防いでいる。評価は Aave の totalCollateralBase 経由）
  - `lst-carry` は **`ERIS_LST_LEVERAGE_TARGET_HF` で opt-in**（既定 0=off）。ループは
    stake→collateralize→borrow→stake で、目標 HF に**着地する**サイズだけ借りる（headroom 基準で借りると
    目標も下限も突き抜けて borrow/repay が振動する: 実測 24/22 → 2/0）。HF が下限を割ったら他の何より先に返済。
    prompt 版は spot に専念（LLM に env の opt-in は効かないため、手を出さないよう明記）
  - 市場側の検証は `test/lstLeverage.test.ts`（要 `ERIS_LOCAL_DEPLOY=1` + ローカルデプロイ。実チェーンで
    listing → ETH 借入 → slash 後も HF 不変(=oracle lag) → oracle 更新で HF 低下 を検査。CI では skip）
- **USDC 建て採点では LST 保有戦略は構造的に β で不利**（実測: noop 0 > lst-carry −203 > lst-carry-wide −233、
  一方で WETH を持たない venue-arb は +115）。alphaUsdc は free inventory の β しか除去せず、
  LST ポジションは live mark のため。ETH 建て採点（DAT 型）が issue #38 の motivation で follow-on

実時間化（ADR 0005）の前提: **SEED(=regime) は市場条件のラベル**で価格パスは再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも結果はぶれる。run 長は `ERIS_RUN_BLOCKS` 固定で揃える。run の比較が要るときは同一 config を複数回回してサンプルを貯め、`runs/<id>/summary.json` を集計する（旧 evaluate/gate は撤去済み）。

## アーキテクチャ（環境とエージェント実行の分離。ADR 0006 / ADR 0015）

```
環境プロセス（core/src/realtime/coordinator.ts = 環境デーモン + 採点者）   agent プロセス × N（完全独立）
  ・anvil ライフサイクル（fork/setup/interval mining）                ・spawn は一律 example/agents/runtime/bot.ts
  ・fair price 生成(Rng(seed)) → PriceFeed/oracle 更新 tx を毎ブロック書込   （agent ディレクトリは env ERIS_AGENT_DIR）
  ・flow bot 注文の relay 送信（市場を動かす）                        ・env で受領: RPC URL / 自分の秘密鍵 /
  ・GMX keeper（注文執行）                                             PriceFeed アドレス / runId・ログ出力先
  ・採点: run 後に歴史ブロック読取で価値系列を一括再構成               ・runtime/read.ts が毎ブロック観測を再構成
         └──────────── 同じ mempool。ブロック内順序は anvil --order fees ・runtime/send.ts が署名・直接送信（nonce 自己管理）
```

- **fair price はオンチェーン配布**（`contracts/PriceFeed.sol`。読取は `sdk/src/priceFeed.ts`、書込は
  `core/src/realtime/priceFeed.ts`）。書込 tx は次ブロック着弾なので情報は 1 ブロック遅れる（全員等しく作用。仕様）。
- **採点は run 後再構成**（`core/src/realtime/reconstruct.ts`）: blockNumber 指定の Multicall3 で全 agent 同一断面の
  価値系列を events.jsonl に observation 形で書く（`runs/<id>/summary.json` に集計）。
  resetFork で歴史が消えるため**次 run の前に必ず再構成を終える**（anvil の保持深度 ~1,050 ブロックに注意）。
- **ルール執行は事後検出**（`core/src/postRunCheck.ts`）: blocks.csv（fee はチェーン上の tx フィールド由来）から
  fee 上限超過を検査し違反 run を `violations` に記録。入口側は `npm run check:strategy`
  （cheatcode 静的検査）で戦略コードを通す。
- **orderflow は独立プロセス**（relay のまま = 環境側の市場機構）。生成ロジックは `core/src/flow/logic.ts`（純粋関数）、
  bot 本体は `core/src/flow/market-maker.ts`。bot は自前 `Rng(ERIS_FLOW_SEED)` で決定論的に動く。
  aave flow の reserve は環境が `readAaveFlowReserves` で読んで渡す。
- protocol アダプタ（`sdk/src/protocols/*.ts`）は `readState`/`observe`/`buildTxs`/`valueUsdc` 等を実装。
  環境の採点と agent runtime の観測再構成が同じアダプタ・同じ `observationFor`（`sdk/src/observation.ts`）を使う。

## エージェント行動ログ

各 agent は runtime が渡す `ctx.log`（`example/agents/runtime/agentLog.ts`）で
`runs/<runId>/agents/<agentId>.jsonl` に毎ラウンドの判断（`reason` / `signals` / `state`）を残す。
runtime/send.ts が同じファイルに mempool 活動（`kind:"mempool"`: submitted / submit_failed /
rejected）を自己申告で追記する（coordinator が submitted を数えられなくなる穴を塞ぐ。ADR 0006 §5）。
出力先は coordinator が渡す env `ERIS_RUN_DIR` / `ERIS_AGENT_ID` で決まる。run 後の診断はこれを一次情報にする。
自己改善型は `ERIS_IMPROVE_LOG_CALLS: "1"`（ロスターの env）で LLM との生の対話（system 全文・送信
messages・生応答・エラー）を `agents/<agentId>.llm.jsonl` に残せる（opt-in。プロンプト調整の一次情報）。

## spot EC2 で重い run を回す（ローカル逼迫の回避。spot skills）

ローカルの CPU/メモリが逼迫するときは、**golden AMI の spot EC2** に run を投げる。ローカルデプロイ前提（fork 不要）で
自己完結し、外部依存は LLM(ollama) egress のみ。全 protocol を deploy 済みの anvil state を AMI に焼いてあり、
launch 時は `anvil --load-state` で全 5 venue を ~10 秒復元 → install/deploy なしで run（起動 ~3 分・full venue + LLM が安定 green）。
SSH 一本で結果を手元に回収（S3/IAM ロール不要）。AWS は `eris` profile（account `075096050160`）固定。スクリプトは
user-global の spot skills（`~/.claude/skills/spot-{run,bake,ops}/scripts/`）に同梱（repo の `infra/spot/` から移設）。
poc repo ルートで叩く（スクリプトは `$PWD` を poc とみなす。別パスは `ERIS_POC_DIR`）。設計と学びは memory `spot-ec2-runner`。
**注: ADR 0015 の workspace 化で npm install の対象・パス前提が変わったため、次回 spot 利用時は AMI の焼き直し（/spot-bake）が必要。**

- **`/spot-run`** — golden AMI で run を回し結果を回収（日常ドライバ）。`ERIS_SPOT_AMI=latest` で最新 AMI 自動解決。
- **`/spot-bake`** — 新しい golden AMI を焼く（poc 依存追加 / deployer・constants 変更時。agent config だけなら不要）。~35 分。
- **`/spot-ops`** — 初回セットアップ（鍵 + SG + IAM）/ 状態確認 / 掃除（残骸インスタンス・古い AMI・IP 再許可）。
