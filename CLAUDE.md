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
| `agent.ts` + `prompt.md`（frontmatter: **`kind: improve`** / name / description 必須） | **自己改善型**（ADR 0018） | decide を毎ブロック駆動しつつ、LLM が取引経路の**外**で戦略コードを書き換える |

`runtime/`（汎用スクリプト: bot/read/send/llm/improve/deploy/agentLog）と `lib/`（共有戦略ヘルパ）は予約名。

**プロンプト型（毎判断 LLM）は ADR 0018 で廃止**。実測で 1 判断 8〜28 ブロック・行動回数がルール型の
1/64 で競技として成立しなかった（ADR 0017 §5 B1）。`ERIS_AGENT_MODE` / `ERIS_PROMPT_*` は fail-fast する。

**`prompt.md` は同じ名前で意味が逆になっている**（ADR 0018 Amendment 1。当初は `improve.md` という別名で
分離していたのを、名前を戻した）。旧 prompt.md は「この observation でどう動くか」、今の prompt.md は
「いつ・何を根拠に・どう直すか」。旧形式 19 個は f42fd2a で削除済みだが git 履歴と旧 bundle には残っており、
**frontmatter のキー（name/description）も同じ**なので、区別できるのは `kind: improve` だけ。マーカーの無い
prompt.md は**起動時に fail-fast**（黙って読むと、取引指示が「改訂方針」として system prompt に入る）。
`improve.md` だけがあるディレクトリも fail-fast（黙って無改訂で走ると、LLM が一度も動かなかったことが
どこにも出ない）。ロスターの `env`:

- `ERIS_AGENT_FROZEN: "1"` — prompt.md を無視して戦略を固定。**ADR 0018 §5 が要求する frozen 対照**
  （自己改善が効いたかを毎 run 見えるようにする）をディレクトリ複製なしで作る
- `ERIS_LLM_MODEL: "<model>"` — 改訂呼び出しのバックエンド（prompt.md の frontmatter が優先）。
  API キー無しでも `codex[:<m>]` / `claude-cli[:<m>]` でサブスク CLI 実行可 = docs/guide/llm-agents.md。
  `openai:<m>` / `gpt-*` は OpenAI 互換 chat completions。**本番は運営の推論プロキシ経由**
  （`ERIS_INFERENCE_BASE_URL` + agent ごとの `ERIS_INFERENCE_TOKEN` = HMAC(ERIS_INFERENCE_SECRET, agentId)。
  agent は鍵を持たない。`npm run inference-proxy`、`core/src/inference/proxy.ts`、規約 §2.3/§2.5。
  許可パス 3 本・モデル一覧・保存済み参照の拒否・全記録と `--replay`）。**記録の失敗でプロキシは落ちない**
  （issue #215。以前は `appendFileSync` の失敗が async ハンドラの未処理 rejection になって exit 1 = 全員の改訂が
  止まった）。書けなかった記録は stderr に agent ごと 1 行 + `/healthz` の `recording.failures`、呼び出しは通す。
  記録量は `maxRecordBytesPerAgent`（既定 256 MiB）/ `maxRecordBytesTotal`（既定 8 GiB、プロセス単位）で頭打ち
  （1 call の記録は request 4 MiB + 応答 32 MiB まであり得て、30 call/分なら 1 agent で ~1 GiB/分）。超えたら
  **記録だけ止めて呼び出しは通し**、その agent のファイル末尾に `event: "recording_capped"` の 1 行を残す
  （replay はこの行を飛ばし、以後は 409）。無制限は設定できない。
  **ストリーミングは拒否せず逐次中継する**（issue #166。SSE / Ollama の NDJSON。1 呼び出し 1 記録で全文を残し
  replay も同じ content-type で返す）。待ち時間は非ストリームが `upstreamTimeoutMs`（既定 5 分。Node の fetch が
  応答ヘッダを 300 秒で諦めるので実質の上限もここ）、ストリームは**無音**の `streamIdleTimeoutMs` だけで総時間は
  エポックが決める。**agent が接続を切ったら上流も abort する**（トークン代は参加者持ち = 規約 §2.5）
- `ERIS_IMPROVE_LOG_CALLS: "1"` — 改訂の生のやり取りを `agents/<id>.llm.jsonl` に残す（既定 off）

**改訂呼び出しの入出力に運営は上限を掛けない**（プロキシは body をそのまま転送）ので、効くのはモデル・サービスと
参照ランタイム（`runtime/llm.ts`）が送る値（issue #168）。prompt.md の `maxOutputTokens` / `contextTokens`
（env は `ERIS_LLM_MAX_OUTPUT_TOKENS` / `ERIS_LLM_CONTEXT_TOKENS`、frontmatter が優先）で設定し、既定は
**Claude の `max_tokens` 16,000**（API が必須にしている唯一の family。旧 2,048 は 1 判断 1 行動を返していた頃の値で、
戦略全文がコード途中で切れて parse 失敗と同じ見え方で捨てられていた。16,000 は SDK の非ストリーム上限 ~21,333 の内側。
client に timeout を持たせて SDK の見積もり拒否は外してある）と **Ollama の `num_ctx` 32,768**（未指定だと
非公開のサービス既定になり、はみ出しは**黙って捨てられる**）。上限で止まった応答は使わず
`revision failed: output truncated at N tokens (...)`、Ollama で文脈が窓を超えたら `llm input truncated: ...`
を agent ログに出す。呼び出し 1 回の待ちは既定 5 分（`ERIS_LLM_CALL_TIMEOUT_MS`。旧 60 秒）で、既定の改訂間隔
（60 ブロック = 2 分）より長いので、前の呼び出しが走っている間に来た改訂機会は**飛ばして** `llm call from block N
still running: …` と記録する（以前は無言で飛んでいた）。

改訂プロンプトは**その run で有効な venue の action 名を列挙する**（`ACTION_TYPES_BY_PROTOCOL`。
`sdk/src/action.ts` が単一の出典で、`test/actionVocabulary.test.ts` が改名・削除を検出）。渡さないと
LLM の手掛かりは現在の戦略コードだけになり、**一度も swap したことのない戦略は `swap` の存在を
知りようがない**（実測: USDC-only 配布で `lp-provider` が 18/18 シナリオ無取引 =
`docs/scoring-metric-measurements.md` §5.8）。「持っていないことは何もしない理由にならない」も明記する。
改訂は `{notes, executorTs}` か `{notes, revertTo: <version>}` を返し、`executorTs: null` は
「今の戦略を維持」。生成コードは **cheatcode 静的検査 → vm コンパイル**（関数式の *評価* に 1 秒
= `runInContext(..., {timeout: 1000})`）を通ってから設置される。**vm のコンテキストは空で作る**
（issue #215。`createContext(Object.create(null))`。以前はホストの `Object` / `JSON` / `Math` を渡していて
`Object.constructor("return process")()` でホスト realm に出られ、worker の `process.env` から鍵が読めた。
プロトタイプ無しなのは、`{}` だと `this.constructor` がホストの `Object` になるため）。obs / ctx はコンテキスト
realm へ**コピーして**渡し、`publicClient` の読取結果も戻りでコピーする（`EXECUTOR_BRIDGE`）。生成コードから
辿れるホストのオブジェクトを無くす層であって、ADR 0024 の「封じ込め境界ではない」は変わらない。
**設置前に試運転はしない** — vm の
timeout は式の評価しか覆わないので、無限ループする本体は評価を通ってしまう。だから設置後、
`decide` を **worker thread** で実行し、親スレッドが呼び出しごとに 5 秒を計測する
（`DECIDE_TIMEOUT_MS` = 規約 §2.3、`runtime/strategyRunner.ts` / `decideTimeout.ts`）。
**worker の env は親の env から秘密を落としたもの**（`runtime/strategyEnv.ts`。Python の子プロセスも同じ）:
`ERIS_AGENT_PRIVATE_KEY` / `ERIS_INFERENCE_TOKEN` / `ERIS_LLM_*` / `*_API_KEY` / `*_TOKEN` / `*_PRIVATE_KEY` 等は
届かず、ロスター `env` の戦略パラメータ（`ERIS_ARB_SAFETY_BPS` も `STAT_ARB_Z_ENTER` も）は届く。
署名は親の send.ts、改訂呼び出しも親なので worker に鍵の用途は無い。残すのは読取 transport 自身の
`CF_ACCESS_CLIENT_*` / `ERIS_RPC_HEADERS`（worker は自前の client で読むので、落とすとゲートウェイ越しの
自己ホスト agent が読めなくなる）。
**手書き・生成済みの両戦略に同じ上限**がかかり、await が返らない場合も同期の無限ループも
`decide timeout:` として記録し、その判断の送信予約と返り値を捨てる。次の判断は同じ選択中の戦略を
新しい worker にロードする。worker 内の変数は初期化されるが、親の観測・改訂ループ、nonce、ログ、
版履歴、状態ディレクトリは継続する。**モジュールのロードには別の上限**（`STRATEGY_STARTUP_TIMEOUT_MS`
= 60 秒 = coordinator の agents-ready 上限と同じ）を掛ける。以前は判断の 5 秒をロードにも使っていて、
負荷の高いホストでは tsx のコンパイルがそれを超え、**31 体中 13 体が起動時に exit 1** した
（issue #100）。また**失敗が 3 回続いたら worker を毎ブロック作り直さない**（1 → 2 → 4 … 最大 64 ブロック
の back-off、1 回だけログ、返る判断が 1 つあれば解除）。throw するたびに discard → 次ブロック spawn は
不変条件（失敗した判断のコールバックに取引させない）なので残すが、毎ブロック throw する戦略が
2 秒ごとに tsx を起動して 1 コアを占有していた（`lp-provider`、#93 F-H）。これは生きている agent 内の計算の破棄であり、規約 §2.3 が禁じる
**異常終了した agent プロセスの再起動ではない**。プロセスの異常終了後は従来どおりエポックの残りが行動なし。
`ctx.publicClient` は読取専用、`walletClient` は公開しない（issue #85）。取引は戻り値か `ctx.submit()` に
集約し、`decide` 中の submit は正常完了まで保留する。`run(ctx)` の自走型は従来のライフサイクルを維持し、
`onObservation` は自走型専用。詳しくは ADR 0024。
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
キーは**ネスト lowercase**（`run` / `funding` / `fees` / `flow` / `stress` / `vuln` + `agents`）で
`sdk/src/runConfig.ts` の `SCHEMA` が内部キーへ写す。**`limits` セクションは廃止**（下の「発注上限は無い」）。
ロスターは規約解決（ADR 0015 §6）:

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

### 発注上限は無い（`limits` セクションは撤廃）

**どの venue にも 1 件あたりの金額上限が無い。**swap 1 WETH / 5,000 USDC、GMX 50,000 USD、Aave supply 5 WETH、
LP 建玉 10、bundle 内 action 5 — 全部消した。**引き上げではなく撤廃**なのは、(a) 「無制限」と書かれた数値は
いずれ誰かが設定するから、(b) その上限が規則であると同時に**参照戦略 19 ファイルのサイズ決定式の入力**
だったから。`clean-arb` の 1 取引は `maxUsdcInUnits` の一定割合、`lp-mint` は `maxLpWethWei` の 1/10、
`levered-long` は `maxWethInWei` を supply チャンクと退避準備金の両方に使っていた。**全員が、保有額とも
機会の良さとも無関係に同じサイズで張っていた**（環境がその数値を配っていたので）。

- 今 1 件の取引を縛るのは**自分の残高**と**相手プールの厚み**（大きく出すほど不利な約定）だけ
- `observation.limits` に残るのは fee/slippage の既定値のみ。**サイズの予算は入っていない**
- 各 agent は自分でサイズ比率を宣言する。共通ヘルパは `example/agents/lib/affordable.ts` の
  `sized(obs, token, bps)`（旧 `limitFor` は削除）。`levered-long` は `ESCAPE_RESERVE_WEI` を自分で名前付け
- **上限をスケールとして使っていた非 agent 側 2 箇所**は、今も存在する量へ移した:
  vuln プールの rug 閾値は**配布 USDC の割合**（config の frac を 1/5 にして絶対値 1,000〜2,000 USDC を維持）、
  Aave フローの目標債務は `flow.aaveBorrowUsdcUnits`（agent の規則を消したついでに背景市場を較正し直さないため）
- `npm run manifest` は**「上限は無い」と明記**する（節ごと省くと「未公開」と区別が付かない）
- **CLAUDE.md と `docs/scoring-metric-measurements.md` の実測値は全部上限下で取ったもの**。数字は変わる

### 背景フローと venue 深度の較正（issue #79。2026-09-07 実測の Base / Ethereum / Arbitrum に合わせた）

**2026-09-13 以前に取った実測値は全部旧較正下のもの**（uninformed 0.9/block・σ 1.0・clamp 3・GM pool 200 WETH・
Aave seed 9k USDC・SP 50k）。CLAUDE.md と `docs/scoring-metric-measurements.md` の数字は再計測まで読み替える。

- **config 側（regime YAML + sdk 既定。dump 焼き直し不要）**: `flow.uninformedArrivalRate` 0.9 → **0.45**
  （Base の主要 2 venue が 2 s あたり 0.41〜0.44 swap）/ `uninformedSizeSigma` 1.0 → **1.5**（`Rng.lognormal` は
  平均保存なので平均 0.5 WETH は不変、median 0.30 → 0.16、mean/median 1.65 → 3.1 = 実測 3〜11 の内側）/
  **`uninformedSizeClampMult`**（新設。`Math.min(3, …)` の定数をノブ化、既定 3 = バイト互換、レジームは 10。
  σ 1.5 × 0.45/block で 3 WETH 超が venue・epoch あたり ~4 本、10 WETH 超が 2 epoch に 1 本。**到着を半減した分の
  dislocation をこの tail が肩代わりする**）/ `flow.gmxMaxSizeUsd` 既定 $20k → **$100k**（注文 $500 / 平均 $2.5k /
  最大 $10k = perp は spot の 1 桁上）。whale・Aave actor は据え置き（whale は「プール深度に対する割合」の規則を
  値の隣に書いた）
- **deployer 側（`npm run gen:state-dump` で焼き直し必須）**: GM pool 200 WETH + 600k → **1,500 WETH + 4.5M USDC**
  （spot 比 0.2× → 1.5×。Arbitrum 実測 1.7×。OI/pool = funding skew が小さくなる。impact factor は Arbitrum の値をそのまま写したので、この pool でも約定はほぼ不変）/
  Aave shared seed 9k USDC + 10 WETH → **5M USDC + 2,000 WETH**（Base の 20× は採らない。12 分のエポックで
  利用率と金利カーブは効かず、agent 規模の借入が空リザーブに当たらない深さがあれば足りる）/
  Stability Pool 50k → **125k eUSD** + genesis Trove **350 ETH / 350k eUSD**（上の Liquity 節）。
  WETH 予算は tokens.ts の wrap 10,000 に対し 3,000 + 1,500 + 2,010 = 6,510 で収まる
- **spot 深度（1,000 WETH + 3M USDC / venue）と価格アンカー（$3,000 / $60,000）は据え置き**。深度を倍にして
  件数を半分にすると dislocation は 1/4 になり calm の 39bps が 30bps の informed 帯に入ってしまう
- **受け入れは「レジームが発火する」**（α 予算の保存ではない）。8 regime × 5 seed を rule-based ロスターで 1 回。
  calm の平均乖離と venue-arb の P は報告のみ。乖離が帯の内側に潰れたら clamp か σ を動かす（決定は動かさない）
- **初回実測（2026-09-13、新 dump で calm#101 / crash#101 を 1 本ずつ、regime 既定ロスター noop / venue-arb / multi-arb）**:
  calm の venue 乖離は平均 **40.1bps**（旧較正の 39bps と同水準。中央値 39.0、30bps 帯超が 61%）で、
  到着を半減しても tail が dislocation を保った。uninformed は venue あたり **~0.9/block**（WETH 0.45 + WBTC 0.45 = base
  ごとに Poisson を引くので 2 倍。360 ブロックで base あたり ~162）。venue-arb は net −136 / P −1,105（noop −863）、
  multi-arb は net +23。crash#101 は 15.6% の gap + 59% の liquidityPull が発火・復元し、`stress_calibration_warning` /
  `_capped` は 0。crash 後 ~100 ブロック、WBTC の curve が fair 比 +100〜250bps に居座り `no_arb_persistent_warning`
  （balancer 買い / curve 売り 120bps × 10 ブロック）が 11 回出た。旧較正の crash#101 とは未比較なので、#79 由来かは未確定

### 手数料と採掘（ADR 0011。公式 12 レジームと練習期間は `economicGas: true`）

**priority fee に上限は無い**（2026-10-08。旧 5 gwei は `economicGas: false` = ADR 0010 のプロファイルにだけ残る）。
- **価格は storage 直書き**（PriceFeed・Aave の全 aggregator・GMX の `MockOracleProvider` = `gmxOraclePriceSlots`）。
  **採掘は coordinator**（`core/src/realtime/gatedMiner.ts`）: block pass は終わったときに書き込みを段取りし、miner が
  `blockTimeSec` の固定の格子で「head の価格が段取り済みか」を待って（上限 3 ブロック）、書き込みを適用してから `anvil_mine`。
  tick ごとにチェーンの head を読み直す（見失うと待ちを飛ばす）。遅れは半ブロック間隔で取り戻し、30 ブロック超は張り直す
- **anvil は head に書いた storage をそのブロックの履歴に残す**ので、ブロック B の履歴は B+1 用の価格を持つ。よって
  ライブ採点は境界を 1 ブロック遅れて履歴から読み（`readLagBlocks: 1`）、`close()` は miner の `stop()` が保留中の
  書き込みを適用した後に終了ブロックを読み、セグメントは `bn-1` で切る（ライブと事後 sweep のずれ 0 を維持）。
  帰結: 「ブロック B の価値」は B+1 の取引が約定する価格で評価される。agent の観測は従来どおり 1 ブロック遅れ
- **keeper（GMX の約定・清算）は 50 gwei 固定**（`ECONOMIC_KEEPER_FEE_WEI`）。順序のためではなく、上限なしの
  ブロックで参加者に埋められて締め出されないため。keeper/admin は anvil で 200 万 ETH（`GAS_ONLY_WEI`）
- **環境のイベント取引**（launch の波・depeg の売買・流動性の引き抜き）は `U × V / 150k gas` を入札
  （`core/src/realtime/envBid.ts`。V = 先回りの価値、U ~ lognormal(中央値 0.86, σ 0.6) で P(U<1) ≈ 0.6、鍵付きストリーム
  `env-bid:<種類>`、練習期間のチェックポイントに位置を保存）。数字は参加者に公開しない（更新履歴は仕組みだけ）
- ゲートウェイは `RPC_MAX_PRIORITY_FEE_WEI=0`、マニフェストは `limits.maxPriorityFeeWei: "none"`。起動時に coinbase が
  agent のアドレスなら拒否（anvil は 0x0）

### GMX の funding は localhost でも動く

以前は**構造的に 0** だった。upstream の hardhat 用マーケット設定（localhost はこれを通る）は
`maxFundingFactorPerSecond` しか置かず、`fundingFactor` も `fundingIncreaseFactorPerSecond` も 0 のまま。
実測（485 ブロック）で long OI 74,651 / short 54,752 の偏りに対し全ブロック 0.000 だった。
`deployer/vendor/gmx-localhost.patch` が arbitrum 側と同じ値（100% スキューで年率 ~63%）を入れて解消。

- **2 層あって 1 つの変更で両方直る**: レートが 0 だったのは `fundingFactor` が 0 だから。加えて
  読み側（`marketSeries.ts`）は `savedFundingFactorPerSecond` を読むが、これは**適応 funding 経路の保存値**で、
  `fundingIncreaseFactorPerSecond == 0` だと MarketUtils が早期 return して**永久に 0**。適応 funding を
  有効にすると読んでいるキーがそのまま埋まる
- **手数料・price impact・borrowing・最大レバレッジも同じ穴だった**（同じ patch）。upstream の hardhat 設定は
  `positionFeeFactor*` / `*PositionImpactFactor` / borrowing 系を書かず、`minCollateralFactor` は 1%。
  つまり**サイズにコストが掛からない 100 倍の先物を fair で約定**していて、fair の予測可能な動き（OU の平均回帰の
  中心が開始価格）が全部、配布額の何倍もの期待値になった。今は Arbitrum の ETH/BTC 市場の値を**そのまま写す**
  （position fee 0.04% / 0.06%、impact 9e-11 / 3e-11・指数 2 / 1・上限 0.5% / 0.4%、borrowing は
  `borrowingRateConfig_LowerMax_WithHigherOptimal`）。impact は Arbitrum の OI に合わせた係数なので、この pool では
  $1M の偏りで ~0.9bps しか効かない（**効くのは fee**。深度に合わせて盛るのは較正の仕事として見送った）。
  レバレッジは**建てるとき 5%（20 倍）・清算 1%**。**これが GMX が受け付ける上限**で
  （`ConfigUtils.validateRange` が MIN_COLLATERAL_FACTOR > 5% と _FOR_LIQUIDATION > 1% を revert する。
  10% / 5% を入れたら deploy が落ちた）、Arbitrum の 0.5〜1% よりは厳しい。
  **swap も同じ**: keeper は `OrderCreated` を種類を問わず全部執行するので、`rawTx` の `MarketSwap` 注文が
  fair・手数料 0・impact 0 で通り、AMM-vs-fair の裁定が片側の AMM 手数料で済んでいた。swap fee 0.05% / 0.07%、
  swap impact 3e-10 / 2e-10・指数 2（Arbitrum の値）を入れた。GM の deposit / withdraw は keeper が拾わないので執行されない。
  **清算 keeper がある**（`liquidatePositions`。以前は注文を執行するだけで**清算は一度も起きず**、crash を 20 倍の逆張りで
  抜けても建玉が生き残った）。毎ブロック DataStore の `POSITION_LIST` から全建玉（参加者も背景フローも）を読み、
  `Reader.isPositionLiquidatable` を注文 keeper と同じ fair で判定して `LiquidationHandler.executeLiquidation` を送る。
  1 ブロック 2 件まで（各 6M gas を宣言するので、連鎖で参加者のブロックを埋めない）、送った建玉は 3 ブロック再送しない。
  **採点は床なしのまま**: 清算が無い状態で床を 0 にすると、1 agent が 20 倍のロングとショートを両方持てば負け側が 0 で
  止まるタダのストラドルになる。清算があれば負けは証拠金 1% 付近で止まる。**指値・ストップ注文は今も執行されない**
  （keeper は新しい `OrderCreated` しか見ない。SDK のアクションは成行のみ）`basis-arb` の往復コスト既定は 0 → 12bps。
  **採点は「今閉じたら残る額」**（`positionExitValueUsd`。Reader の `getAccountPositionInfoList` を fair で引き、
  証拠金 + 基準 PnL + 決済時と建玉時に繰り延べた impact − 決済手数料・未払い borrowing・funding + 受け取る funding）。
  建玉時の手数料は証拠金から既に引かれているので、額面（証拠金 + PnL）のままだと**鐘の後まで持ち越した建玉は手数料を
  半分しか払わない**ことになった。額面は `valueUsdc`（= `markedValueUsdc`）に残る。読取に失敗したら額面で数えて
  `read-failed` を報告し、価格の付かない市場に建玉がある agent は読まない（Reader が revert する）
- **値を盛らないこと**。盛ると perp だけ Aave の借入金利と違う時計で回る（LST の APY で一度やった失敗）。
  よって**レートは実物・符号も偏り追随**だが、**数百ブロックで積む額は小さい**（Aave の利息と同じ理由。EVM 時間は warp しない）
- **これ以前に焼いた state dump は旧設定を持つ**ので、そこからの replay は今も 0 を返す。
  その 0 は「板が均衡している」ではなく「この deploy に funding が無い」。`npm run gen:state-dump` で焼き直す。
  **起動時に実測して落とす**（`gmx_funding_check`。`core/src/realtime/gmxFunding.ts`）。anvil では fail-fast、
  `chainMode: external`（練習 devnet）は巻き戻せないチェーンを止めないよう警告して続行
- **BTC/USD 市場も執行される**。以前は keeper が WETH/USDC の価格しか渡さず、BTC 注文は `EmptyPrimaryPrice(WBTC)`
  で執行 tx ごと revert し（GMX はキャンセルせず、keeper は再試行しない）証拠金と 0.03 ETH が OrderVault に残って 0 評価だった。
  価格を渡すトークンは `setupGlobal` が全市場から作る 1 本（`ctx.gmx.oracleTokens`）を keeper・provider 登録・毎ブロックの
  mock 書き込みが共有する。**証拠金は市場の long token か USDC**（ETH 市場 = WETH/USDC、BTC 市場 = WBTC/USDC）
- **keeper の `executeOrder` が申告する gas は `GMX_KEEPER_EXECUTE_GAS` = 6,000,000**（issue #216 (2)。以前は 15,000,000 固定で、
  keeper の fee は参加者上限より上なので注文 2 件で 30M ブロックを丸ごと申告していた）。blocks.csv の `gasUsed` を
  35 run・49,498 件で実測: min 1.15M / p50 2.38M / p99 2.60M / max 2.79M。GMX は申告から 1M（error handling 分）を
  引いて約定に渡し、general プロファイルなら 3.9M + 1M を先に要求するので、6M は両プロファイルで通り約定に最大値の
  1.8 倍残る。`afterMine` の `opts.executeGas` で上書き可。**anvil が収容判定に申告値を使うか実使用量を使うかは未実測**
- **keeper は参加者のコールバックを実行しない**。GMX は注文の `callbackContract` を `executeOrder` の中で呼び
  （`afterOrderExecution` / `afterOrderCancellation` は注文の `callbackGasLimit`、`refundExecutionFee` は DataStore の
  別上限）、keeper の tx はオラクルの直下・全参加者より上に並ぶ。以前は keeper がログの key を読まずに全部実行していたので、
  コールバック付きの注文 = **作成者のコードを次ブロックの先頭で、keeper の手数料・gas・帰属で**動かせた（前ブロックの
  AMM 乖離を先取りし、最低実行手数料 0 なのでコールバックから次の注文を出して毎ブロック続く）。2 層で塞ぐ:
  keeper が実行前に `Reader.getOrder` を読み、`callbackContract != 0` か読めない注文は実行しない
  （`gmxKeeperRefusal`、`keeper_order_refused` イベント。アドレスだけで判定 = GMX はコードの有無を実行時に見るので
  CREATE2 の未デプロイ先も拒否）。patch は `maxCallbackGasLimit` と `refundExecutionFeeGasLimit` を 0 にし、
  `createOrder` が `MaxCallbackGasLimitExceeded` で revert する（**片方だけでは refund 側の 200k が残る**）。
  3 本目の口は**注文の `receiver` への native ETH 送付**（実行手数料の返金・unwrap した出力）で、コントラクトなら
  `receive()` が `nativeTokenTransferGasLimit`（upstream 50k）で keeper の tx 内で動く。patch はこれも 0 にする
  （ETH 付き CALL には EVM が 2,300 を足すので `transfer()` と同じ。SSTORE 不可、足りないコントラクトには GMX が WETH で
  払い直す。EOA は無影響。実測: 50k では receive() がストレージを書き、0 では書けずに WETH で届いた）。
  起動時に 3 つを読んで `gmx_callback_check` に記録するが**落とさない**（callback は keeper 側で既に塞がっており、古い dump
  での差は注文が作成時に revert するか OrderVault に残るかと、receiver の 50k gas = swap 1 回に足りない量だけ。警告で焼き直しを促す）
- **observation にも出る**（issue #78）。`protocols.gmx` の `longOiUsd` / `shortOiUsd` / `fundingPerHourBps`
  （正 = long が short に払う）/ `fundingModeled`、建玉があれば `position.fundingOwedUsd`。
  以前は「チェーン上にも market.json にもあるのに、どの agent からも見えない」状態だった。
  DataStore のキー導出は **`sdk/src/protocols/gmxKeys.ts` が単一の出典**で、marketSeries（報告）と
  gmx アダプタ（観測）が同じキー・同じ式を読む（`example → sdk ← core` なのでアダプタは core を読めない）。
  **読取失敗は 0 ではなく欠落**、`fundingModeled: false` が「この deploy に funding が無い」側の 0。
  **額は取引にならない**: 360 ブロック(2s/block = 12 分)で 100% スキューでも建玉の 0.14bps、
  実測スキューなら ~0.02bps で、AMM 側の 30bps に対して 3 桁小さい。**符号付きのコスト項と偏りシグナル**であって
  carry ではない（`basis-arb` の `fundingCarryBpsPerBlock` がヘッジ側の符号で cost gate に入れる）

### `run.resetUnit` — world のリセット単位（ADR 0020）

`continuous`（既定）/ `scenario` の 2 値。**この run が 1 つの world なのか、(regime, seed) ごとに
world を作り直した中の 1 本なのかというラベル**で、これ自体は何もリセットしない（リセットしているのは
`backtest --scenarios` の snapshot/revert）。**本番競技は `scenario`**（ADR 0020 §2。在庫の持ち越し・
drawdown からの回復・レジームをまたぐ資本配分は競技の対象外になった）。既定が `continuous` なのは
`sim:realtime` との互換であって本番の宣言ではない。

- **`scenario` を宣言できるのは matrix runner だけ**。config に書いて `sim:realtime` を叩くと
  **起動時 fail-fast**（1 つの world を「多数」と名乗る summary.json は、後から検出できない嘘になる）。
  値の綴り間違いも fail-fast（黙って continuous に落ちると、matrix 全体が continuous と名乗る）
- `summary.json` の `resetUnit` と `matrix.json` の `resetUnit` に必ず出る。連続経済の run と scenario の
  run を 1 つの順位に混ぜない（1 world あたりの epoch 数が違う）。フィールドが無い過去 run は
  `continuous` として読む（軸ができる前の run は全部 1 world だった）
- **採点は規約 §4.4 の偏差値方式で確定**（ADR 0023、2026-09-06）。λ の較正も集約方式の選択も無い

### `run.chainMode` — ノードを誰が持っているか（ADR 0021 §7 / issue #33）

`anvil`（既定）/ `external` の 2 値。**`external` は cheatcode が一つも無い実クライアント**（#35 の OP Stack
devnet）を指す。cheatcode 関数はそのまま残り、external では**呼ばれた瞬間に拒否して代替機構を名指しする** —
実チェーンでは未知 RPC がエラーオブジェクトを返すだけで、~30 箇所ある呼び出し側の多くがそれを飲み込むので、
拒否しないと「誰にも資金を配らず、何もマイニングせず、完走した競技として summary.json を書く」run になる。

- **funding は treasury EOA からの実送金**（`TREASURY_PRIVATE_KEY`。genesis が prefund する）。**代入ではなく
  差分補填**する — 練習 devnet は同じ admin/keeper を毎セグメント補充するので、有限口座から 2,000,000 ETH を
  二度は配れない。token は mint できるなら mint、できなければ transfer。**鍵を持っていない参加者の address へも
  配れる**（`fundAddress`。WETH だけは本人しか `deposit` できないので treasury が wrap して送る）
- **ブロックはシーケンサが作る**。`setIntervalMining`/`setAutomine` は無く、`sendAndMine` は receipt を待つだけ
  （setup の各段は自分が書いた state を読み返すので、着弾前に返すと前の世界を見て動く）。coordinator は
  **実 cadence を計測**する（`run.blockTimeSec` とズレると評価区間の長さが全部狂う）
- **リセットは無い**。練習場ではそれが設計（ADR 0021 §1）
- **起動時に落とす組み合わせ**: treasury 鍵なし / `localDeploy: false` / `economicGas: true`（storage 書き込みで
  価格を確定する＝実チェーン不可）/ `stressVictimCount > 0`（victim は run ごとの fresh state が要る）/
  `prewarmBlocks > 0`。さらに **scored token が誰でも mint できるなら落とす** — "cheatcode-free" は RPC の話だが、
  同じ穴が contract 側にあった（`MockERC20.mint` は permissionless だった。minter ゲートを追加済み）
- `run.readRpcUrl` で read を replica へ分離できる（#36 の判断待ちだが、口だけ先に開けてある）
- **ローカル ⇄ devnet の切り替えは 2 軸**で、別々の場所にある。**チェーン**（`.env.local` の
  `ANVIL_RPC_URL`/`CHAIN_ID`/`TREASURY_PRIVATE_KEY` + `--chain-mode external`）と**アドレス**
  （`sdk/src/constants.local.ts`。`DEPLOYMENTS_JSON=<path> npm run gen:local-constants` で切替）。
  config ファイル自体は共通。**アドレス overlay は同時に 1 つ**なので、deployment を移るたびに再生成が要る。
  片方だけ動かすと以前は setup の数分後に `Cannot decode zero data ("0x")` と生アドレスが出るだけだったので、
  **起動時に deployment の有無を実測して落とす**（`deployment_check`。何が無いかと再生成コマンドを出す）
- **`ERIS_MANIFEST` は chainId と localDeploy も運ぶ**（issue #84 X3）。`sdk/src/constants.ts` は
  **import 時**にアドレス overlay を決め、config は `CHAIN_ID` を読むので、マニフェストの値は
  sdk が 1 つも読み込まれる前に env へ入れる必要がある。よって `example/agents/runtime/bot.ts` は
  **prelude だけ**（`manifestEnv.ts` を呼んで `botMain.ts` を動的 import する。sim-realtime.ts と同じ形）で、
  ランタイム本体は `botMain.ts`。env が優先なので coordinator 起動は無改変。これが無いとガイド記載の
  コマンドが chain id（`configured for 42161`）→ アドレス（`7 of 7 contracts hold no code`）の順で 2 回落ちた
- **agent プロセスも取引前に同じことを確かめる**（`example/agents/runtime/preflight.ts`。検査本体は
  `sdk/src/deploymentCheck.ts` = coordinator と同じ 1 本。`example → core` は禁止なので sdk に置いてある）。
  **失敗メッセージは「誰が指したか」で変わる**（`via: "manifest" | "env"`）: 自己ホスト参加者は
  `ANVIL_RPC_URL` も `gen:local-constants` も持っていないので、運営語彙で答えるのは行き止まり。
  RPC 疎通（5 回リトライ = 自己ホストの起動レース用）→ chain id が `run.chainId` と一致するか →
  venue アドレスに bytecode があるか、の順に見て、駄目なら **exit 1**。coordinator は `onExit` で拾い
  `agent_process_exited` と summary の `processExitedEarly` / `stderrTail` に残す。
  **落とすのは、落とさないと区別が付かないから** — チェーンに届かない agent は生きたままループし続け、
  `summary.json` には `includedTxCount: 0` / `netPnlUsdc: 0` / `violations: []` だけが残る。これは
  「何もしないことを選んだ agent」の記録と同一で、事後に見分ける材料がどこにも無い（実測: コンテナ内の
  agent が起動 10 秒で 25 行書いた後、100 ブロック run の残り 2 分 48 秒を無言で過ごし、idle として採点された）

### 練習 devnet（ADR 0021。止まらないチェーン + 自己ホスト参加者）

**公式採点ではない**。公式競技は提出バンドル × シナリオ行列（ADR 0017 / 0020）で、練習期間の結果は一切
反映されない。順位表は `resetUnit === "continuous"` を見て `practice` バッジを常設する（**「scenario でない」
ではなく「continuous である」で判定** — ADR 0020 以前の matrix.json は当該フィールドを持たず、あれは公式形だった）。

- **練習期間の順位は日次リターンの偏差値**（`core/src/scoring/practiceReturn.ts`）。1 セグメント（1 日）= 1 エポック、
  P = V_K / V_0 − 1、重みは全日 1（`scoreCompetition({ weighting: "equal" })`）、始値が場の中央値の 1/10 未満の
  agent はその日 placed しない。**USDC の P をやめたのは world がリセットされないから** — 本番は全員同じ V_0 から
  始まるので USDC と比率で T は完全に一致するが、連続経済では元手がずれ、USDC だと「序盤に稼いだ資本」を採点する。
  判定は `isPracticePeriod`（`resetUnit: continuous` かつ `segmentHours > 0`）で、**単発の `sim:realtime` run は
  従来どおり USDC**（全員同じ配布なので同じ順位になる）
- **`config/practice.yaml` は競技環境と同等**（規約 §2.7）: 7 venue・バスケット配布・公式レジームの flow 較正・
  毎日 10 個のエピソード（crash/spike（各 pull 付き）/cexDrift/flowTrend/whale×2/DAI depeg/eusdDepeg）。`npm run gen:practice-episodes -- --start <起動時刻>` が日数分を生成する（`windowFrac` は run の割合なので、**再起動の直前に作り直して PR でマージ**。起動が ±1.5h ずれても各日に 1 つずつ = `core/src/practiceEpisodes.ts`）。
  入れられないのは victim・vuln・`persist`・`repriceAnchor`（1 world だと 6 週間残る/複利になる）。複数の crash に
  pull を揃えるため、`alignWith` は**リスト上で直前の同種イベント**に揃う（以前は最初の 1 個に全部揃っていた）
- **seed は公開 config に置かない**。価格 walk・flow・全イベント窓は seed の純関数なので、`seed: 1` が公開されて
  いると crash のブロックを誰でも計算できる。hosted period は `.env.practice`（gitignore）の `ERIS_PRACTICE_SEED`
  を systemd が `--seed` に渡し、無ければ起動しない。**期間の scenario key も同じ**（ADR 0027）: `.env.practice` の
  `ERIS_SCENARIO_KEY_FILE`（`npm run competition -- keygen` で作った鍵ファイルのパス）が無い・読めないと起動しない。
  **財布の秘密も同じ**（issue #189）: `ERIS_WALLET_SECRET_FILE`（`npm run competition -- wallet-keygen`）が無いと起動しない
- **環境が作る財布の鍵は seed から作らない**（issue #189。`core/src/walletKeys.ts`）。AUTO agent・flow / whale /
  launch・Aave / Liquity victim・vuln プールの owner（`vuln-pools`）・check:ordering / stress:rpc のプローブは全部 `environmentKey(kind, id)` =
  `HMAC-SHA256(secret, ["eris-wallet/v1", kind, id])`。以前は `keccak("auto-wallet:<seed>:<id>")` 等で、自分の AUTO 鍵から
  seed を総当たりで逆算でき、そこから他の agent・環境ウォレットの鍵が全部計算できた（ゲートウェイは送信者を検査しない）。
  secret は**既定でプロセスごとの乱数**（どこにも書かない。run・同一プロセスの行列内では同じアドレス、次のプロセスで変わる）、
  練習期間だけ `ERIS_WALLET_SECRET_FILE`（再起動しても同じ財布に戻るため）。**scenario key とは別物**で、同じ値なら起動時に落とす
  （scenario key は結果発表後に公開するので、それから導出すると全部の鍵が公開される）。財布の秘密は**結果発表後も公開しない**
  （再現に要らない: ADR 0027 (c) が再現するのはシナリオと、アドレスで読む採点だけ）。agent の env には渡さない
  （`ERIS_WALLET_SECRET*` は環境専用）。`npm run manifest -- --participant` は AUTO の鍵を出すのにこのファイルが要り、
  無ければ拒否する（config だけの manifest では AUTO の `address` が欠落する）。`run_started_realtime.walletKeys` が出所を記録
- **ロスターは登録リストであって起動リストではない**。`external: true` + `address`（参加者が鍵を持つ。**運営が
  作った鍵は運営が持っている鍵**なのでこちらを推奨）/ `wallet`（運営が発行して渡す）。`command`/`args`/`dir`/`env`
  は**黙殺せず拒否**する（黙って落とすと「運営が動かしている」ように読めるロスターになる）。
  `participant`（任意）は規約 §2.2 の**参加単位**で、同じ値の 2 体はその単位の 2 提出（高い方が最終スコア）。
  `agents_registered` / manifest / summary.json / matrix.json の agent レコードに**そのまま載る**だけで、
  採点の算術は agent 単位のまま（単位への畳み込みは読む側 = dashboard の仕事）
- **再起動は期間を再開する**（`core/src/realtime/periodResume.ts`）。coordinator は毎パスの終わりに
  `<期間>/resume/state.json`（+ 30 ブロックごとの履歴を 40 個）へ、チェーンにも成果物にも無い状態 = 価格 walk の
  水準と乱数の位置・期間の時計（runStartBlock / runBlocks / 日次グリッドの起点）・ロスターと配布額（V_0 の床）・
  採点の帳簿・depeg / 引き抜きが開始時に測った基準値・成果物のサイズを書く。境界の値は intervals.jsonl に
  あるので入れない。起動時に開いている期間があれば**チェーンを戻さず**続きから再開する。どの checkpoint からかは
  「ブロックハッシュがチェーンと一致する最新のもの」: coordinator が死んだだけなら state.json、anvil がダンプから
  戻ったら履歴から選び、成果物をそこまで切り戻す（切った分は `resume/cut-*`）。どれも一致しなければ拒否。
  **新しい期間は `--new-period` か `runs/NEW_PERIOD` のときだけ**（チェーンを戻すのはこれだけ。起動 = 新期間
  だった頃、ENOSPC 後の自動再起動が 2.5 日分を戻した = 2026-10-08）。期間も要求も無ければ拒否。再開時に変えて
  よい config は `MUTABLE_CONFIG_KEYS`（fees・economicGas・flow.topUpEveryBlocks・registrationsFile・agent の
  待機 / quota / sandbox）だけで、それ以外（seed・endsAt・エピソード・ロスター・鍵）が違えば差分を名指しで拒否。
  SIGTERM はチェーンの採掘を止めてから終了する（止まっている間に価格更新の無いブロックが進まない）。
  **持ち越せないもの**: anvil 再起動後の state 履歴（間に来た境界は `interval_boundary_failed`）、
  `agentMarkets` / `tokenLaunch` / vuln / victim / prewarm のある期間（`period_not_resumable`、再起動で拒否）。
  実測（ローカル anvil、2026-10-08）: kill -9 → 再開、SIGTERM → `economicGas: true` に変えて再開、anvil を
  ダンプから 26 ブロック戻して再開の 3 通りで、blocks.csv の重複 0・ブロックの欠落 0・depeg / 引き抜きは par まで戻った
- **登録は再起動なしで追加する**（`run.registrationsFile`。ADR 0021 §2 / 規約 §2.7）。ロスターは起動時に 1 回しか
  読まず、期間の一部なので再開時に変えられない。ファイル（YAML/JSON。`external: true` +
  `address` エントリと同形。`config/registrations.example.yaml`）を **~30 ブロックごとに stat** し、変わっていれば
  読み直して新規分を setup と同じ経路で登録する（鍵なし runtime・address 帰属・同額 funding = `fundAddress`・
  `LiveScorer.addAgent` で**次の境界から**評価・`agents_registered` と manifest を再発行 + `agent_external_registered`）。
  純関数は `core/src/realtime/registrations.ts`。重複 id/address は `registration_ignored`、壊れたファイルは
  編集 1 回につき 1 回 `registrations_reload_failed`（run は止まらない）。**日の途中で登録された agent はその日の
  P を持たない**（測られた V_0 が無い。翌セグメントから）。**それを「持たない」まま記録する**（issue #84 X2）:
  segment の summary.json / 期間 index の agent レコードは `scored: false` + `unscoredReason` を持ち、
  `netPnlUsdc` / `pnlUsdc` の**フィールド自体が無い**。以前は欠損 P を `netPnlUsdc: 0` に潰しており、
  採点側はそれを P = 0 として読んで**負けた全員に勝っていた**（実測: 期中登録の carol が 5 体中 4 位）。
  書き手は `core/src/segments.ts` の `segmentAgentRecord` / `segmentIndexAgent`、読み手は
  `dashboard/src/data/scenarioP.ts` の 1 本（**境界系列が agent を持つならそれが答え、
  「系列はあるが P が作れない」は「系列が無い」とは別**）
- **参加者の登録は Discord の `/faucet` でも受け付ける**（`infra/discord-faucet/`。box 上の systemd ユーザーユニット）。
  `register.sh` と同じ手順（検査 → 控え → `config/registrations.yaml` に追記 → `events.jsonl` で coordinator の判定 →
  チェーンの残高）を box の中で行うので SSH も新しい入口も要らない。使えるのは参加者ロールを持つ人だけで、ロールは
  参加登録スプレッドシートの Discord ユーザー名と定期的に同期する（規約 §2.7。付与のみで剥奪はしない）。
  **1 アカウント 1 体**（`~/.local/state/ascon-faucet/claims.json`）。2 体目と同じ参加単位の紐付けは運営が `register.sh` で行う
- **未登録の送信者も blocks.csv に残す**（role `external`、ownerId = 送信者アドレス小文字）。以前は
  「run の外の tx」として捨てていたが、試行環境ではそれが参加者の tx そのもので、「自分の tx は載ったか」に
  答える唯一の成果物から消えていた。`method` は calldata から。採点・規則検査は `agent` 行しか読まないので対象外。
  **ただし agent のウォレットが資金を渡した先からの tx は agent の行**（issue #212。`core/src/realtime/derivedSenders.ts`）:
  ETH 送金・価格のある token の Transfer・自分が deploy したコントラクトを推移的に追い、そこから出た tx は
  role `agent` + ownerId = その agent、末尾列 `derivedFrom` に資金元。以前は第 2 EOA から出すだけで fee 上限・
  ガス予算（per-agent-per-block の合計はゲートウェイでは見えない）・未ログ検査の全部を外れた。3 検査は
  `external` 行も derived map で読む（資金が着く前に tip 0 で送った行の分）。summary の `agents[].derivedSenders`・
  `derived_senders` イベント・matrix の `flags` に出る。**追わないもの**: 他人の tx が allowance で agent の token を
  引いた場合（追うと誰にでも違反を着せられる）、価格の無い token の Transfer（偽 token の log は何とでも言える）、
  call 内部の ETH 転送（trace が要る）。判定は運営（規約 §8）。
  **環境自身の鍵 4 本（admin / keeper / setup / deployer）は既知側に載せる**（`core/src/realtime/environmentSigners.ts`。
  `roleKeyGuard` の `RoleKeys` と同じ 4 本に型で縛ってある）。載せないと二重に間違う — 環境の tx が `external` 行に
  なり、しかも agent が 1 回送金するだけで**その鍵が送った全部**がその agent の行になる（setup ならレジストリ登録、
  deployer なら `depeg` / `liquidityPull` の売買）。depeg / pull が有効な run は後から deployer 行を機構名で上書きする
  （こちらが具体的なので正しい）。この 4 本は下限
- **セグメントを切るたびに `stress_schedule` も再発行する**（`run_started_realtime` / `agents_registered` /
  manifest と同じ扱い。ADR 0021 §6）。以前は 2 日目以降の全セグメントが「予定なし」に見えた。ディスク上の記録は
  窓込みで完全（規約 §7.2 の監査用）。**未来の窓を公開側から隠すのは runs API（dashboard 側の audience mode）の仕事**
- **自己ホスト agent の run 長はマニフェストの `period` が決める**（`endsAt` / `startBlock` からの `blocks` /
  `seconds` / `startedAt` / `dayHours`。式は `sdk/src/periodClock.ts`、優先順位は `example/agents/runtime/runClock.ts`）。
  以前はマニフェストに run 長が無く、ガイドのコマンド（`ERIS_CONFIG` 無し）では env 既定の「ブロック上限なし・20 秒」になり、
  `blocksRemaining` が起動 20 秒後から期間の 5 週間ずっと 0 だった。今は YAML の run 長にも env 既定にも**明示 override で**勝つ
  （YAML の source は secret env しか取り込まないので env では届かない。`run.blocks` / `run.endsAt` は片方を空にする）。
  `ERIS_CONFIG` は**設定されたときだけ**読む（`config/local.yaml` は拾わない。雛形は GMX 無し・LST 1 時間/block で
  devnet と別の世界）ので、参加者は `ERIS_CONFIG=config/practice.yaml`。**`dayBlocksRemaining`**（練習期間 =
  continuous かつ `segmentHours > 0` のときだけ）は採点中の 1 日の残りで、参加者の時計から計算する。そのため
  **セグメントは `startedAt + (k+1) × segmentHours` の固定格子で切る**（以前は前回 roll の `segmentHours` 後で、
  roll が遅れた分だけ日がずれていった）。coordinator は run の開始を宣言した時点でマニフェストを書き直し、
  run-start.json にも `startedAt` を載せる。**配布用マニフェストは `npm run manifest -- --from-run runs/<period>`**
  （config だけから作ると PriceFeed も期間の開始も入らず、agent は起動できない）
- **判断ログは参加者のマシンにしか無い**。dashboard は agent ページの判断ログタブを external では**出さず**、
  そう書く（空パネルは「このエージェントは何も考えなかった」という別の主張になる）。送信フィードは「何名が
  ここに出ないか」を明示する。**submitted-but-not-included は諦める**（運営が動かしていない agent では元々検証不能）
- **メソッド名は calldata デコード**（`sdk/src/methodSelectors.ts`）。agent ログ join は coordinator が agent を
  起動している間しか成立せず、外部参加者の tx が全部 `direct` になる＝トラフィックが最も多いところで最も情報が無い
- **採点は評価区間の境界をその場で読む**（`core/src/realtime/liveScoring.ts`）。事後 sweep は「終わり」が来ないチェーンと
  ノードの履歴保持深度の両方に当たる。同じ reader・同じブロック・同じ G7 median 窓なので**一致する**ことを毎 run
  検査する（`interval_series_agreement`）。sweep は equity curve / alpha / market.json のために残るが、履歴深度を
  超える窓では**明示的にスキップ**（そこで sweep すると 0 を読んで「崖のある完全な系列」になる）
- **成果物は日次セグメント**（`run.segmentHours`）。チェーンは連続のまま、run ディレクトリだけを切る。
  `competition ⊃ scenario` にセグメント列として載り、`resetUnit` は正直に `continuous`。**評価区間は厳密に分割
  される** — 境界上で始まるセグメントは繰り越さず、途中で始まるものは直前の境界を繰り越す（前者を繰り越すと
  同じ評価区間が 2 セグメントで数えられ、後者を繰り越さないとセグメントごとに 1 区間消える）
- **評価区間の長さは実時間で書く**（`run.intervalSeconds`。ADR 0021 §3 が単位を確定した）。ブロック数は cadence から
  導出。秒とブロックを両方書くと fail-fast。旧名 `run.epochSeconds` / `run.epochBlocks` は結果発表まで警告付きで
  読む（同じキーを新旧両方で書くと fail-fast。issue #140）。設定例は `config/practice.yaml`、運用手順は `docs/guide/practice-devnet.md`
- **1 か月走る期間の 5 点**（issue #129/#130/#134/#135/#136。4 時間の EC2 soak で実測）: ①**期間の終わりは日時**
  （`run.endsAt`。起動時に残りブロックへ換算。`run.blocks` と両方は fail-fast、CLI の `--blocks` は上書き。
  以前は 42 日のブロック数で、9/23 起動なら本番週にはみ出し、再起動のたびに 42 日延びた）。42 日の `seconds`
  上限は `setTimeout` の 32bit を超えて 1ms に化けていた（イベント無しの run が 0 ブロックで終了）→ `setLongTimeout`。
  ②**背景フローの財布は補充する**（`flow.topUpEveryBlocks`、練習は 300。公式は 0 = 1 回配り）。実測で
  1 財布の在庫が 1 日に元の数倍揺れ、合計価値は 1 日 1 割強減る。`flow_balances` / `flow_guard` /
  `flow_wallet_topped_up` が記録。**GMX の flow は自分の建玉を cap の一定割合までに抑える**（`flow.gmxOiTargetFrac`、
  既定 0.4、0 = 閉じない旧 flow。期間中も変更可）。以前は開くだけで、2026-10-08 開始の練習期間では WETH 市場の
  両側が reserve 上限（プール価値 × 0.5）まで flow の建玉で埋まり、参加者はどちら向きにも開けなかった。目標を超えた側に
  引いた注文は同じ乱数のまま close になる（担保は比例分）ので、**目標未満なら flow は乱数単位で以前と同一**。
  360 ブロックのエポックは目標の 1/6 程度しか積まないので公式レジームでは発火しない。③**LST の利回りはチェーンの時計**（ADR 0028。旧既定 1 時間/ブロックだと 35 日が 170 年分で
  原資 50 WETH が 3.3 日で尽き、#129 で 30 秒/ブロックにしていた）。尽きたら観測の `apyBps` は 0、`lst_reward_reserve_exhausted`。
  ④**coordinator の送信記録は flush で消す**（`SubmittedLedger`。以前は 1 日 ~200MB 増えた。soak で 180MB 一定）。
  ⑤**練習チェーンの anvil は `--transaction-block-keeper 300 --prune-history 300`**。無いと全 tx（1 件 ~37KB、
  レシート・トレース込み）をメモリとダンプに持ち続け、**5 分ごとのダンプの間ブロック生成が止まる**（2 時間で
  18 秒、伸び続ける）。履歴は直近 10 分しか読めない。ブロックヘッダはどのフラグでも消えないので
  `ascon_anvil_mem_growth` が 1 週間先を予測して警告する
- **評価区間の数はセグメントで頭打ちになる**（期間の長さでは増えない）。30 分の評価区間・24h セグメントで
  **48 区間/セグメント**が定常状態。dashboard はセグメントを読むのでバーもそこで止まる。
  セグメントを切ると期間全体が 1 本になり、1 週間で 336 区間・events.jsonl 435MB・blocks.csv 221MB
  （実測 1.4KB/block・0.7KB/block からの外挿）。**11 時間相当を超える非セグメント run は起動時に警告**する

### 参加者コードを動かす側の境界（issue #214。公式競技 = `agentSandbox: docker` 前提）

- **書込量**: agent が書けてコンテナより長生きするのは state dir（`/eris/state`）と自分のログ 2 本だけだが、
  どちらの mount にも容量上限が無く、`state.ts` / `agentLog.ts` の 64 MiB は参照ランタイムの自己制限（提出コードは
  `writeFileSync` で素通り）。coordinator が `run.agentDiskCheckEveryBlocks`（既定 15）ごとに両方を stat し、
  `run.agentStateQuotaBytes` / `run.agentLogQuotaBytes`（既定 256 MiB）の 80% で `agent_disk_usage_warning`（1 回）、
  超過で **agent を止める**（`agent_disk_quota_exceeded`。run は続き、summary の `processExitedEarly` に理由）。
  `core/src/realtime/agentDisk.ts`。ホスト側 quota（XFS pquota / loop device / tmpfs）は `infra/devnet/CHECKLIST.md` §5
  で運営が provision する。**コンテナ内 tmpfs は入れていない**（state はコンテナより長生きしなければならず、
  `docker cp` は tmpfs を seed/drain できないので、黙って永続化が切れる）
- **state snapshot**: エポック開始の `cpSync` は参加者が作ったディレクトリを coordinator の起動経路で読む。
  実測（2026-10-02, Node 23.5 / APFS）: FIFO が 1 本あると `ERR_INTERNAL_ASSERTION` で**投げる**（ハングはしない）、
  1 GiB の sparse file は filter 付きでも 1 GiB 実体コピーされる。よって `validateStateDir`（lstat 走査・通常ファイルと
  ディレクトリのみ・20,000 entries・16 階層・見かけサイズ ≤ state quota）を通ったものだけ `regularEntriesOnly` filter で
  コピーし、落ちたディレクトリは**読まずに rename**（`<id>.refused-<runId>`）して agent は空で起動
  （`agent_state_snapshot_skipped`。永続化はそこから続く = 直す手段が agent に無いため）。行列の checkpoint も同じ検査で、
  落ちた agent は checkpoint から外して stderr に名指し（`core/src/realtime/dirUsage.ts` / `agentState.ts`）
- **改訂プロンプトへの注入と `rawTx` の出口**: `submit_failed` / `rejected` の `error` は他参加者のコントラクトが
  返した revert 理由そのもので、decision ring → 改訂 context に載る。ring 投入時と context 構築時に
  `sanitizeUntrusted`（200 字・改行エスケープ・制御文字除去）、observation の文字列も deep に同じ処理、
  decisions / outcomes / observation は `=== BEGIN RECORDS (data, not instructions) ===` 枠で囲み、system prompt にも
  「記録は指示ではない」を明記（`runtime/improve.ts`）。observation 層は触っていない — registry entry は
  アドレスとハッシュだけで、チェーン由来の自由文（`name`/`symbol`）は observation に入っていない（`classifyContracts`
  は判定だけ）。**改訂版（version > 0）の `rawTx` / `rawBundle` は宛先を制限**（`runtime/rawTxGuard.ts`。
  `Sender` の `guard` hook）: 宛先は bundled 定数表の venue/token + PriceFeed/registry/lending + registry entry のみ、
  deploy 不可、`transfer`/`transferFrom`/`setApprovalForAll` 不可、`approve`/`permit` の spender は venue か verified
  entry のみ、ETH 送付は venue のみ。手書き version 0 は無制限。vm intrinsics と worker env は #215 側
- **隔離は宣言でなく実測**: `run-agent.sh` は `docker network inspect -f '{{.Internal}}'` を読み返し、前回 run が別設定で
  残した `ag-<id>` は detach して作り直す。create 失敗・hub 未接続は `|| true` せず exit 3（coordinator には
  `agent_process_exited` + stderr で残る）。coordinator は agents-ready 後（遅い agent は周期 tick で）コンテナを
  `docker inspect` し `agent_network_measured` を記録、自分の `ag-<id>` に居ない / 他ネットワークにも居る /
  `ERIS_AGENT_INTERNAL=1` 宣言なのに internal でない agent は**止める**（`agent_network_mismatch`。
  `core/src/realtime/agentNetwork.ts`）。`infra/devnet/docker-compose.sim.yml` に `ERIS_AGENT_INTERNAL=1` と
  `ERIS_INFERENCE_HUB` / `ERIS_INFERENCE_BASE_URL` を追加（repo 唯一の live 設定なのに egress が開いていた）

## 実行コマンド

- `npm run anvil` — 別ターミナルで Anvil フォークを起動（sim:realtime の前提。ローカルデプロイモードでは不要）
- `npm run sim:realtime` — 実時間 run を 1 回実行（設定は `config/local.yaml`。`--config <path>` で別ファイル、`--seed`/`--blocks`/`--protocols`/`--agents` 等で一回上書き）
- `npm run build:contracts` — モックオラクル + PriceFeed を forge build（sim:realtime の前提。`out/` 未生成なら最低 1 回）
- `npm run gen:local-constants` — deployments.json → `sdk/src/constants.local.ts` 生成（同梱 `deployer/` のローカルデプロイ出力を読む）
- `npm run gen:state-dump` — 稼働中の deployer anvil から配布用 state dump + manifest（生成元コミット・deployments 同梱・fingerprint）を `backtest/state/` へ生成（ADR 0016。dump 前に `.local-snapshot` のクリーン断面へ revert し、constants.local.ts も同じ deployments から再生成）
- **anvil はブロックごとの state を `~/.foundry/anvil/tmp/anvil-state-*/` に ~2 MB ずつ書く**（`--load-state` の run で実測: 360 ブロック run 1 本で 3,600 ファイル ≈ 7 GB、プロセス終了後も残る）。2026-09-10 にこれが 61 GB 溜まってディスクが満杯になり、run が `ENOSPC` で落ちた。run の後は `rm -rf ~/.foundry/anvil/tmp/anvil-state-*`（動いている anvil が無いとき）。本番 box でも同じ。**macOS の anvil 1.7.1 では 1 ブロック ~6 MB（2026-09-26 再測定）、Linux の 1.8.1 では同じ負荷で 1 ファイルも書かなかった**（issue #135）。`--prune-history` を付ければ版に関係なくディスクには書かない
- `npm run backtest -- --regime <name> --seed <N>` — シナリオ 1 本を再生（ADR 0016 Phase 0 = B1 実時間再生）。state dump をロードした専用 anvil（既定 port 8547）で `config/regimes/<name>.yaml` + seed を再生する。**シナリオ = (regime, seed)** で regime YAML は seed を持たないので `--seed` は必須（ADR 0017 §1）。`--agents <roster>`（regime 既定ロスターの差し替え）/ `--protocols`/`--blocks`/`--score-every` 等の一回上書き。**override は実効 regime YAML に書き出され coordinator はそれで走る。agent には届くが、その YAML ではなく coordinator が解決済みの値から書く agent 用 config 経由**（下の「agent が見るもの」。coordinator だけに効かせると agent が観測で死ぬ）。fingerprint 不一致は manifest 同梱 deployments から constants を自動再生成、genesis 不一致は fail-fast
- `npm run backtest -- --scenarios config/scenarios/public.yaml` — シナリオ行列を 1 つの anvil 上で全部再生し順位を出す（ADR 0017）。`{regimes, seeds}` の直積（実行順が回次 s）か、`{k, epochs: [{s, regime, seed}]}` の順序付きプラン（`npm run competition -- plan` の出力）を受ける。シナリオ間は snapshot/revert。`runs/matrix-<id>/matrix.json`（schema 2: シナリオ × agent の P = `pnlUsdc` / `pnlSource` / `netPnlUsdc` / `alphaUsdc` / 端点 / `baseline` / `flags`）と `standings.json`（`computeStandings` の出力）を書く。順位は派生物で matrix.json から再計算できる。`--repeat N`（較正の診断用。採点は 1 回が既定。P の中央値の repeat を採る）
  - **`--resume <matrix-dir>` で同じ行列を続ける**（規約 §4.7.1。ライブ週の k エポックは複数回の起動にまたがる）。
    格納済みの `agents` を持つシナリオは skip（`skipping s=…, already complete`）、無い・`error` のものだけ再実行し、
    `matrix.json` / `standings.json` を**同じディレクトリに**回次順で書き直す（`createdAt` は初回のまま、`resumedAt` を追加）。
    `scenarioSet` / `k` / `resetUnit` / `repeat` が違えば fail-fast、同じパスで中身が変わったセットも回次単位で拒否
    （`core/src/backtest/resume.ts`）。summary.json → AgentScore の変換は `core/src/backtest/scenarioScores.ts` に分離
  - **agent にはエポック番号を渡す**（issue #167）。env `ERIS_EPOCH_INDEX`（プラン上の s）/ `ERIS_EPOCH_COUNT`（k）と
    `obs.epoch = {index, count}`（`sdk/src/epoch.ts`）。重み w_s が s で変わるのに、毎エポック同じ初期状態から再起動される
    agent には今が何本目か知る手段が無かった。s は**この起動で何本目かではなくプランの値**なので `--resume`・再実行・
    部分リハーサルでも元の s（= 元の重み）。漏れるのは重みだけで regime / seed は伏せたまま。行列以外（`sim:realtime`・
    単発 `--regime`・練習期間）では env も field も**無い**（1 of 1 ではない）。運営シェルに残った値もロスターの env も
    agent には届かない（環境が決める値なので spec.env の後に上書き・無ければ削除）。`run_started_realtime.epoch` にも残る
  - **公式レジームは `agentSandbox: docker`**（規約 §2.3 の 2 vCPU / 4 GiB は `infra/docker-agent/run-agent.sh` でしか掛からない）。docker が無ければ `--agent-sandbox process`（無制限。`agent_sandbox` イベントにそう出る）。綴り間違いは fail-fast。
    docker でも `ERIS_AGENT_ISOLATE=1` + `ERIS_AGENT_INTERNAL=1` が無い agent は host のサービスへ直接届くので、coordinator は
    **止めずに警告する**（`agent_sandbox_warning` イベント + 起動時と完走時の stderr バナー。audience には配信しない）。
    ライブ週の設定は `infra/docker-agent/ISOLATION.md` 冒頭
  - **鍵ファイル付きの順序付きプラン（= ライブ週）では、警告止まりだった 2 つを拒否にする**（`core/src/realtime/liveWeek.ts`）。
    運営の鍵（admin/keeper/setup/deployer、または Aave admin が anvil のテストアカウント = 既定 mnemonic の dump）が
    公開鍵 / `agentSandbox: process` / `command` の agent / `ERIS_AGENT_ISOLATE=1` + `ERIS_AGENT_INTERNAL=1` の無い
    docker agent / bind-mount / **anvil の公開テストアカウントに ETH が残っているチェーン**（鍵は anvil のバナーに出ていて、ゲートウェイは送信者を見ないので、誰でも自分の財布へ送金して P を足せた。backtest の anvil は以前 `--accounts 10 --balance 1000000` で毎エポック 1,000,000 ETH ずつ持たせていた。今は `--accounts 0` で、残高（ETH + レジストリの全トークン。base fee 0 なので ETH 0 でもトークンは送れる）は起動時と各エポックの funding 後・agent 起動前に実測する = `publicAccountRefusal`。**既定 mnemonic で焼いた dump は state 自体に公開アカウントを持つ**ので、`gen:state-dump` が dump から実測して manifest の `publicTestAccounts` に書き、ライブ週は空でない・フィールドが無い manifest を拒否する = `stateDumpRefusal`。直すには秘密 `MNEMONIC` で deploy し直して焼く）。以前は `roleKeyGuard` が「参加者が送れるチェーン」を登録ファイルか `external` でしか
    判定せず、運営が起動する本番エポックはどちらも持たないので素通りしていた。隔離も警告だけで、host network の
    agent はゲートウェイを通らず anvil の cheatcode に届く。規約 §3.1 の一覧が「禁止」と書くものを「届かない」に
    するのはこの 2 つ。最初の待機の前にレジームごとに検査し、拒否は除外エポックにせず週ごと止める。
    `ERIS_ALLOW_PUBLIC_ROLE_KEYS` は効かない。リハーサルは `--scenario-key public`
  - **エポック開始時に全署名者の nonce を床まで上げる**（`core/src/realtime/nonceFloor.ts`、`epoch_nonce_floor` イベント）。
    行列は 1 プロセス・1 snapshot で回り、鍵はエポック間で変わらない（agent / flow は `walletKeys.ts` がプロセスで 1 回、
    運営鍵は env）。revert で nonce が戻るので、**前のエポックの署名済み tx がそのまま有効**だった。state dir
    （`--agent-state-root`）を持つ agent はエポック中にブロックから他人の tx を読んで保存し、次のエポック頭で再送できる。
    実測（anvil 1.7）: 運営の前エポックのオラクル更新を先に入れると採掘され、coordinator 自身の同 nonce の更新は
    `replacement transaction underpriced` で拒否される（オラクルの手数料は毎エポック同じ定数）。床は
    `Date.now() × 1000` で、プロセスをまたぐ `--resume` と除外エポックの再実行でも前の nonce より上になる。
    対象は agent・flow 財布・運営鍵 4 本・victim・vuln factory の owner 財布。reset した run（`!external && !skipReset`）だけ、funding の前に掛ける。
    PR #230 の gateway の送信者検査は X-ASCON-Key で呼び出し元を識別するが、運営が起動する agent はキーを送らないので
    ライブ週のこの穴は塞がない
  - **採点は規約 §4.4 の偏差値方式**（ADR 0023。`core/src/scoring/deviationScore.ts`）。1 シナリオ = 1 エポックで、P = V_K − V_0（境界系列の両端、5 ブロック中央値マーク。`epochPnl.ts`。**V_0 は配布額を下限にする** = issue #207: agent プロセスは最初の競技ブロックより前から動いていて tx を送れるので、境界 0 のチェーン状態は agent が下げられた（第 2 EOA や自作コントラクトへ退避して運用中に戻すと P が配布額ぶん膨らむ）。`core/src/scoring/endowmentV0.ts` が `agent.initial` をその境界のマークで評価し `max(配布, 実測)` を V_0 にする。**ただし `resetUnit: scenario`（本番の行列）では配布額に固定する**（`v0RuleFor`。上側を信じると「贈り物」攻撃が通る: 開始前に自作トークンとの LP NFT を被害者へ送って V_0 を W 膨らませ、競技中に抜けば被害者 P ≈ −W・攻撃者は自分の床に吸収されて P ≈ 0。ERC-721 は `rosterTransfers` の対象外。fresh world には持ち越しの建玉が無いので上側は要らない。max は continuous だけ）。live scorer と事後 sweep が同じ規則なので `interval_series_agreement` は変わらない。実測が上回る分（練習期間の再起動で持ち越した建玉）はそのまま数える。`summary.json` の `agents[].v0Source`（`endowment` / `measured`）/ `v0Usdc` / `v0MeasuredUsdc` / `v0EndowmentUsdc`、`intervals.jsonl` の先頭行、`interval_v0_endowment_gap` イベントに記録。matrix は実測が配布から 0.1% 超ずれた agent を `flags` に出す。**`pnlUsdc − netPnlUsdc` の場の定数からの外れは検出器にしない** — netPnlUsdc は額面、P は換金可能額なので差は純 spot 以外で定数にならない。最初のブロックが読めず床が掛からなかったエポックは `interval_v0_floor_skipped`）→ 全員横断で T = 50 + 10 (P − μ) / σ（ベンチマーク除外、破産は負のまま、床も凍結も無し）→ w_s（回次に線形 1 → 1.5）で加重平均。σ = 0 と summary の無いシナリオは全員について S から外し他の重みは動かさない。順位は小数第 2 位、同点は T の標準偏差 → 最悪エポック → 提出時刻。**失格は無い**（プロセス死亡・fee cap 違反・未ログ tx は `flags`）。**`--metric` と `npm run metrics`、M9 / λ / aggregate / `epochScores` は削除済み**
  - **5 ブロック中央値は市場由来の全マークに掛かる**（規約 §4.1。以前は stable の probe だけで、LP・LST・Liquity は
    境界 1 点だった）。対象は各アダプタが `medianSurfaces` で宣言し（LST のプール売却 quote /
    Liquity の自分サイズ quote / Aave の LST 担保 haircut）、summary の `markMedian.surfaces` に出る。**保有量は境界で固定し
    価格だけ中央値**。参照価格（fair と、それを配る Aave・GMX のオラクル）は市場由来ではないので対象外。
    **LP の分割比（Uniswap の tick・Balancer/Curve の持分あたり準備金）は保有量の側**で、境界ブロックの値を使う。
    #144 で一度中央値にしたが、自分しか LP のいないプールを窓の 3 ブロックだけずらして境界前に戻すと、同じ流動性が
    ずらした側の分割で評価され、預けた額の数十 % が架空の価値になった（fair からずれたプールの持分は fair で評価すると
    必ず大きい）。境界ブロックの分割なら同じブロックの swap は財布と LP で相殺される
  - **エポック順序は抽選 seed から導出**（`npm run competition -- plan --hidden <hidden.yaml> --lottery <lottery.yaml> --k 60`。`core/src/competition/schedule.ts` = SHA-256 カウンタ + 棄却法 + Fisher-Yates、レジームはエポックごとに独立・一様（issue #186）。`--starts-at <ISO> --every-minutes <N>`（または `--ends-at <ISO>` で窓に均等配置）で各エポックに `startsAt` を付けると matrix.json の `schedule` 経由で dashboard が「次のエポック開始予定」を出し、`backtest --follow-schedule` がその時刻を待って各エポックを始める。コミットメントには入らない）。`npm run competition -- commit <file>` が正規化 JSON の sha256 を出す（非公開 seed は 9/23 前、抽選 seed は 10/31 に公表。原本は結果発表後）。形は `config/competition/*.example.yaml`
  - **ライブ週の編成は [ADR 0026](docs/adr/0026-live-week-schedule.md)（Proposed）**: k = 60（レジームはエポックごとに i.i.d. 一様に引く = issue #186。平均 5 回 ± 2.1、どれかが 0 回になる確率 6.4%）・1 エポック 360 ブロック・ガス用 ETH 3（ベンチマークも同額。公式レジームの `funding.ethWei` は別変更）・168 時間に 168 分おきで均等配置し `--follow-schedule` の 1 プロセスで走らせる。**60 エポックはブロック時間で 12 時間 = 週の 7%**。週を埋めるなら「360 ブロックのままエポックを増やす（非公開 seed の追加 commit が要る）」が推奨で、エポックを伸ばすのは全 12 レジームの再較正になる（ADR の §5）
  - **公式レジーム（12 本）**: `calm` / `cex-drift` / `informed-flow` / `whale`（単発大口の点イベント）/ `lending-incident`（暴落 + victim + 清算 + 同じ窓の引き抜き）/ `crash`（価格ギャップ + 同じ窓での引き抜き。3 venue が同時に薄くなる）/ `depeg`（レジストリの stable が $1 でなくなる。issue #27）/ `vuln`（run 途中にプールが湧き過半が rigged。ADR 0014）/ `spike`（crash の鏡像 = 上方向のギャップ + 同じ窓の引き抜き。バスケットを持っているだけの側が報われる唯一のレジーム。issue #105）/ `depeg-persist`（`depeg` の `persist: true` 版。ディスカウントが最終採点ブロックまで戻らず、買い戻しは teardown。「戻ると信じて持つ」が構造で勝てない唯一のレジーム。issue #106）/ `cdp-incident`（Liquity victim = ICR 1.20 の Trove 2 本 + 12〜16% 暴落 + 同じ窓の `eusdDepeg` と引き抜き。清算・償還・借り手防御の 3 skill。issue #107。victim は `core/src/liquityVictims.ts`、`stress.liquityVictimCount` / `liquityVictimIcr` / `liquityVictimCollWethWei`、`stress_liquity_*` イベント）/ `launch`（run 途中に 2〜3 の新トークンが環境の Uniswap V3 factory 経由で USDC の薄いプールに上場し、トークンごとに需要の波が来るか dud かをシードが決める。鐘の時点の保有は 0 = ADR 0022 公理 2。issue #29。下の「新規トークンの上場」節）。**Liquity の 14 日 bootstrap 期間**: deployer は deploy 時に warp するが、state dump を新しい anvil に `--load-state` すると時計が実時間に戻って期間内に逆戻りし、**全 backtest run で `liquityRedeem` が revert していた**（実測: redemption-arb が 8 ブロック連続で redeem を決めて全部 `Redemptions are not allowed during bootstrap phase`）。`setupLiquity` が期間内なら `evm_increaseTime` で飛ばす（`liquity_bootstrap_warped`）。**抽選はエポックごとにレジームを独立・一様に引く**（`schedule.ts`、issue #186。以前は各レジーム k/R 回をシャッフルしていたが、それだと状態を引き継ぐ agent が既出レジームを数えて残りを推測できた）。非公開セットは**各レジーム k 本以上**の seed が要る（全エポックが同じレジームを引きうる）。**乱数ストリームはレジーム名でも分かれる**（`run.regime` → `setScenarioRegime`、flow bot へは `ERIS_SCENARIO_REGIME`。issue #186。以前は同じ seed の calm と crash が同じ価格ショック・フローを引いていた。backtest が自動で書く。agent には渡さない）
  - **`cex-drift` / `informed-flow` は窓イベント**（`cexDrift` / `flowTrend`）で表現する（issue #56）。run 全体設定だった頃の `cex-drift` は**宣言長 360 ブロックで壊れていた** — 実測でプール乖離が平均 1,055bps（10%）に居座り fair が +34.6% 暴走、venue-arb が +8,458 を無条件に得ていた。60 ブロックでは 55bps に見えるので発覚が遅れた。窓化後は 461bps・+1,191（calm 基準は 39bps・−289）。`informed-flow` は窓化しても 45.0 → 42.7bps でほぼ中立（この regime はもともと calm と識別しにくい）
  - **`vuln` を公式化するにはフィールド側の追加が要る** — 悪意あるプールは factory 購読で発見するので、`discovery-arb` / `discovery-arb-verify` を `config/rosters/full-field.yaml` に入れないと**誰も見つけられず何も測れない**（`liquidator` が victim 無しでは遊ぶのと同じ形）。実測: 無検証は −5,306、検証側は +721、新プールを見ない venue-arb は −220（calm と同じ）
  - **7 本とも全 venue（`lst` / `liquity` 含む）をデプロイし、配布は ETH/BTC/USDC バスケット**（8 WETH + 0.4 WBTC + 25k USDC。issue #54）に**ガス用 1 ETH**（2026-09-28。規約 §4.2 の公表値で、公式レジームと `practice.yaml` に明記。sdk の既定も全モード 1 ETH。以前の既定 100 ETH はバスケットの 4 倍で、その値動きが P の大半を占めていた。ガスマネージャは全 run で動き、足りなくなれば自分の WETH から補充する）。**flow wallet には 0.5 WBTC も配る**（`funding.flowBase`。issue #99）— 以前は flow の財布に WBTC が無く、しかも `flow/logic.ts` の売り側ガードが全 base で `wethWei` を見ていたので、WBTC の売り注文が残高 0 に対して送られて informed 行の 27〜38% が revert し、WBTC プールが fair の +110bps に張り付いていた。ガードは base ごとの残高（`flowBalances[*].bases`）を読むようになった。WETH は従来どおり flow が買って調達する（1,012/1,012 成功の実測があるので触らない）。以前は 5 venue・USDC-only 版と `full-*` の 7 venue 版が並立していたが、**5 venue 版は撤去した**（「競技とは何か」に 2 つ目の答えを残さないため）。`full-8h` / `full-boxA` は `public.yaml` と同内容になったので統合済み。`config/regimes/{lst,liquity,liquity-crash}.yaml` は venue 単体検証用として競技セット外に残る。USDC-only を保つのは `metric-*` だけで、理由は別（ADR 0019 §6。`genMetricRegimes.ts` が `funding.base` ごと落とす）
  - `--score-every N` は採点断面の間引き。成績は初期/最終断面しか使わない（`alphaByAgent = alphaLast − alphaFirst`）ので**スコアは不変**、equity curve が粗くなるだけ
- `npm run explorer` — sim anvil を索引するローカル Blockscout（issue #31。stock イメージ pin、`infra/blockscout/`）。UI は http://localhost:3100。**チェーンをリセットしたら `npm run explorer:reset`**（resetFork/snapshot-revert の巻き戻しに indexer は追従できないので DB を消して再索引するのが正規のライフサイクル）。`npm run explorer:tag` が最新 run の `summary.json` から agent アドレスに名前タグを付ける（reset で消えるので run ごと）。接続先・chain id・fork 用 `FIRST_BLOCK` は `infra/blockscout/explorer.env`
- `npm run dashboard` — run を描画する web UI（`dashboard/` workspace = issue #63。Vite dev サーバー http://localhost:5173）。`runs/<id>/` を選び、`summary.json` / `events.jsonl` / `blocks.csv` / `agents/*.jsonl` / `market.json` から全ビューを構成する。**実行中の run は `● (live)` として現れ観戦できる**（events/agent jsonl の tail + agent ログの `runtime_start` から発見した anvil RPC の現ブロック読取。採点・venue 系列は完走時に自動で archived 表示へ切り替わる）。Blockscout が起動していれば tx/block/address が deep link になり indexer 高さも併記される（落ちていればリンクだけ消える）。UI 開発用の seed データは `VITE_DATA_PROVIDER=seed`
  - **選択は `competition ⊃ scenario ⊃ interval`**（UI から "matrix" という語は消した。ディスク上の
    `matrix.json` は core の出力なのでそのまま）。UI 表示は「評価区間」/ "Interval"（issue #140 までは
    「ラウンド」/ "Round"）。dashboard のコード内の識別子（`roundCursor` / `RoundsBar` / `round`）は round のままで、
    `dashboard/` の中では常に評価区間を指す。既定の着地点は `/` = **Overview**（issue #183。下の項目）で、
    競技の順位表は `/standings`。着地点を 1 シナリオにしないのは、1 シナリオは分布からの 1 ドローであって結果ではない（`config/scenarios/public.yaml`:
    "the published seeds are five draws from it, **not the target**"）ので、そこを既定にすると
    「読んではいけない単位」を最初に見せることになる。picker は competition →（`regime#seed` 表示の）
    scenario の順。**「competition に属さない run」という第 2 のモデルは無い** — `sim:realtime` の
    1 run は「1 シナリオの競技」で、picker の **— single run —** はその run を外側の単位にする
    （`competitionFromRun`。データ層の入口 1 箇所で正規化し、以降のページは 1 種類の型しか見ない）。
    **ルートは `/`（= Overview）・`/standings`・`/scenario` + `/agent/<id>`**。参加者向けに整理した際
    `/leaderboard`（scenario 内順位と重複）・`/archive`（未到達の seed 遺物）・`/run` エイリアスは削除した
    （`/standings` も一度消したが、#183 で `/` を Overview にしたときに順位表の置き場所として戻した）。`/markets` と `/explorer` は 1 world の中でしか意味を持たないので
    scenario 層のまま。**`/scenario` は world の盤面そのもの**（2026-09-07。旧 `/world` タブを統合し、`/world` は
    `/scenario` に着地する）: RoundsBar（replay transport 無し）+ ブロック軸 + 盤面 + シナリオ内順位 / Agent Log /
    venue 価格・口座価値の履歴。ブロック軸の head はページのローカル状態で、**途中で離れるときだけ replay head に
    1 回渡す**（`/markets` `/explorer` が同じブロックで開く。armed で開けばその head から始まる）。盤面のフレームは
    replay で clamp せず、順位パネルは head 時点で閉じた評価区間までの順位（`standingsThroughRound`）。旧 top-page
    snapshot（ティッカー・テープ・ブロックプレビュー）は削除。**順位が存在しない 2 ケースはそう言う**: live run（`summary.json` は完走時に
    書かれるので結果がまだ無い）と seed プロバイダ（フィクスチャ）。どちらも scenario ビューに着地する
  - **ヘッダ + Overview（`/`）が参加者の入口**（issue #183）。**ヘッダ**（`components/SiteHeader.tsx`、全ページ・sticky）:
    ASCON ロゴ / ナビ 5 本 / **参加登録**（Google Form 直結、？ に「先に Discord #ascon」、**10/25 00:00 JST 以降は出さない**）/
    その右に **提出**（エージェント提出フォーム直結、**提出期間 9/23〜10/31 だけ**。430px 以下はロゴのワードマークを省く）/
    日英トグル。860px 以下はナビをメニューに畳む（参加登録とトグルはバーに残る）。ページ内の sticky バーは
    `top: var(--header-h)`。**Overview** は上から
    日程（ブラウザの時計で「開催中」と次の締切までの JST 暦日数。ascon.dev は静的なので「今ここ」はここにしか出せない）/
    **提出の手順**（参加登録 → API キー → 作る → 手元で確かめる →（任意）練習環境 → ZIP → 提出 → 凍結。期間のある段に
    「受付中 · あと N 日」等。参加者の進み具合は分からないので「あなたの段」は指さない。提出フォームは受付期間中だけ直接リンク
    （`SUBMISSION_FORM_URL`）、API キーのフォームは載せず Discord 案内。10/31 以降は 1 行に畳む）/ 評価・賞金・提出と制約の 3 カード（要点を常時表示、全文は ？、
    ascon.dev の規約の節へリンク）/ 上位 5 名（順位・エージェント・平均得点・採点数 + 何の数字か・何日分・更新時刻の 1 行。
    `standings: false` では出さない。完走済みでも結果発表日（12/7）前は「最終」と名乗らない — 参加者の手元の
    backtest も同じ形だから）/ リンク集。**規約の値は `dashboard/src/data/competitionInfo.ts` 1 ファイル**
    （各値に ascon-web `content/legal/rules.md` の節番号）で、規約改定時はここだけ直す（文言は `messages.ts` の `overview.*`）
  - **サイドバーは無い**（全モード・全ページ全幅 + 1 行のフッタ）。**競技セレクト**（`components/CompetitionPicker.tsx`）は
    概要の上位 5 名の見出しと `/standings` の競技名の横で、**手元で選択肢があるときだけ**（競技 2 つ以上、または
    1 つ + 競技外の run）。**公開ビューでは出さず、ブラウザに保存された選択も無視して最新の競技を出す**
    （`effectiveSelectedCompetitionId`。無視しないと、以前別の競技を選んだ閲覧者が戻れないまま固定される）。
    世界の切替（`components/WorldSwitcher.tsx`、「変更 ▾」）は scenario 層のページの評価区間バーの世界名の横で、
    選択中の run を今の競技の中に保つ役も持つ
  - **日本語 UI の呼び方**: エポック（練習期間は 1 日）ごとの偏差値 = **得点**、順位を決めるその加重平均 = **平均得点**
    （規約の「スコア」は平均得点。評価カードに「規約では『スコア』」と添える）。英語は score のまま
  - **説明文は ？（`design-system/InfoTip.tsx`）に入れ、見出しと数字だけを常時表示する**（全ページ）。
    クリック/タップ/キーボード（Enter・Space で開閉、Esc で閉じてボタンへ戻る）、外側を押すと閉じる、1 度に 1 つ、
    `position: fixed` なので横スクロールする表の中でも切れない。`Panel` の `info` prop が入口。**ネイティブの `title=` は
    説明に使わない**（スマホで出ない・キーボードで届かない）— 切り詰めた名前の全文やデータの読み値だけに残す。
    空状態の文（「なぜ何も無いか」）は ？ に入れない（入れるとパネルが空に見える）
  - **`/standings`** は順位表 + Find your agent + **シナリオ一覧**（1 行 1 世界 = `regime#seed` / 評価区間の数 /
    首位 / 環境イベント種別。行クリックで開く。`dashboard/src/data/scenarioList.ts`）。**単位の梯子**（競技 › シナリオ ›
    評価区間 › ブロック）はタイトル横の ？。旧 **InfoTabs は解体**: 採点 → Overview の評価カード、概要・環境 →
    該当箇所の ？（Overview の見出し・シナリオ一覧）、データ（`npm run explorer` など運営者向け）→ `/explorer` の ？ で
    公開ビューでは出さない。以前は「シナリオとは何か」の説明が 35 世界の 1 つの末尾にあり、その世界固有の説明に
    読めた。イベント列の空欄は「予定なし」であって「calm」ではない
    （cex-drift は窓を開けず run 全体を曲げるし、窓化以前の run はそもそも schedule を持たない）
  - **評価区間は UI の時計**（`dashboard/src/data/roundCursor.ts` に位置が 1 つだけ存在する）。
    途中経過の価値も順位変動も環境イベントも評価区間単位なので、全ビューはこの軸に対して読む。
    **以前はこの軸を 3 回別々に実装していた**（評価区間の選択 / replay head / live head）。
    カーソルは competition 全体を張る = **評価区間 k では 35 シナリオが各自の評価区間 k にいる**。再生は
    カーソルを進めるだけで、独立した「リプレイモード」ではない
    - **順位は "through interval k"**（先頭 k 評価区間で再計算。完走結果を読まない）+ 評価区間 k−1 からの移動
    - **シナリオ長は揃っていない**（full-8h では depeg が 9、他は 29。最終区間を採点していなかった頃の記録）。最終評価区間を過ぎた
      シナリオは**世界が終了した**扱いで順位に残す（除くと「結果でない理由」で場が動く）。
      帯に `30 of 35 still running · 5 ended earlier` と出す
    - **net PnL は評価区間で絞れない**（両端を run 最終価格で評価するので評価区間 k の値が存在しない）。
      順位表の参考列としてだけ出し、スクラブ中は灰色で提示して完走値を評価区間名で出さない
    - **評価区間 k のパネルがその窓を出す**（seed から引かれた計画。実測 seed 101: whale 5/13/19/24-25、
      crash 14-15、lending-incident 15-16、depeg 4-7、calm/cex-drift/informed-flow は無し）。
      **だから評価区間 7 の順位は最終順位の予告ではない** — 評価区間 7 では裁定勢が首位で、
      その座を奪う crash 窓はまだ開いていない
    - ブロック単位の細かい移動（1 シナリオ内）は `replay.ts` に残る。これはこの位置の**細分**であって
      対立する概念ではなく、シナリオを 1 本開いているときにだけ存在する
  - **順位表はルール固定**（参加者向け）。規約 §4.4 の偏差値方式そのもの（ADR 0023）: シナリオ = エポックごとに
    P = V_K − V_0 → 場全体で T → 回次に線形な w で加重平均した Score を 2 桁で表示し、tooltip に採点エポック数と
    §4.6 のタイブレーク（T の標準偏差・最悪エポック）。レジーム列はそのレジームでの T の平均（説明であって別の
    順位ではない）。参考列として net PnL(final marks) の合計を 1 列だけ併記（β が相殺され `noop` がきっかり 0 に
    なる方の量。評価区間のスクラブ中は灰色）。**採点は `core/src/scoring/deviationScore.ts` を dashboard が直接
    import する**（`@core/*` alias。採点ロジックを 2 箇所に置くと CLI と画面で順位が食い違ったとき、どちらが本物か
    分からなくなる）。振る指標は無い（`npm run metrics` は削除）
  - **表示名の原則**: 内部 ID を UI に出さない。競技名は scenarioSet + 実施日から自動導出
    （`dashboard/src/data/competition.ts` の `competitionName`。h1 に `full-8h`、picker に
    `full-8h · 8/29`、生の ID は tooltip）。シナリオは常に `regime#seed`（表示では `full-` 接頭辞を
    剥がす）。**runs/ ディレクトリの通し番号「Run N」は全廃**（開発機ローカルの座標で参加者に無意味）
  - **UI は日英対応**（`dashboard/src/i18n/` = locale ストア + 全文言辞書 `messages.ts`。ヘッダの
    トグルで切替、localStorage 永続、既定はブラウザ言語、`<html lang>` も追従）。**データ層のビルダー（venuePanels /
    runsProvider の tape・建玉表）も `t()` を呼ぶ**ため、useSnapshot が key に locale を含めて
    言語切替でスナップショットを再構築する。文言の規律: 実装語彙（ファイル名・ADR 番号）は
    運営者向けの ？（`/explorer` のデータの出所。公開ビューでは出さない）以外に出さない / 単位は必ず添える（bps・USDC）/
    状態語は live・finished の 2 語 / `npm run` コマンドは explorer 起動などローカル運用文脈のみ
  - **順位の理由は agent ページの Standing タブ**（順位表の行クリックで飛ぶ既定タブ）。その agent が採点された
    全エポック（s / シナリオ / P / T / w）、T の平均・標準偏差・最悪値（= §4.6 のタイブレーク）、T の分布、
    レジーム別内訳、破産（≤ 0 で終えたシナリオ）を出す（Score が順位を決めるので、これは別の順位ではなく説明）。
    1 つのレジームで大勝ちして他で負ける戦略が安定した戦略の下に来る理由が、レジーム別 T で見える
  - **評価区間 = 規約の評価区間**（run ではない。採点はエポック = run につき 1 つ、評価区間は途中経過）。上部の帯は選択中 run の評価区間の系列そのもの
    （`valueSeries.intervalSeries.boundaryBlocks`。issue #140 以前の run は `epochSeries` で、どちらも読む）で、セグメントを押すとその評価区間の per-agent 結果
    （Δ value / 対数リターン / 順位と変動 / その窓に落ちた環境イベント）が開き、`/explorer` の
    ブロック窓もそこに絞られる。**`Δ value` と `log return` は別物**（前者は β 込みの生の資産変化なので
    noop も動く。後者は同じ変化を ln(後 / 前) で表したもの。**どちらもスコアではない** = スコアはエポックにつき P が 1 つ）。live run は採点系列が無いので
    `run_started_realtime.intervalBlocks`（古い run は `epochBlocks`）から枠だけ引いて進捗を出し、結果は完走時に入る
  - **`/markets` は価格ではなく venue の状態**。有効な protocol ごとに 1 タブ（AMM / Perp / Lending /
    Stablecoin / LST）。AMM・Perp・Lending・stable 価格は `market.json`、**LST と Liquity の
    「市場全体の状態」は `events.jsonl` の `lst_block` / `liquity_block`**（coordinator が毎ブロック
    出しているので二重に再構成しない＝古い run でも描ける）。パネルの構築は
    `dashboard/src/data/venuePanels.ts`
  - **リプレイ**: 完走した run を「ブロック B 時点」として前に歩かせる（評価区間バーの `▶ replay`
    → play/pause・スクラバ・1x/2x/4x）。live モードは run したマシンでしか成立しない（tail は dev
    サーバーのファイルシステム、チェーン読取は agent の anvil）ので、**完走済み run と spot で回して
    回収した run を観るにはこれが唯一の手段**。archived は live より情報が多い（market.json・採点済み
    評価区間系列・完全な blocks.csv）ので、劣化版ではなく上位互換。**未来を見せないのが要件**で、閉じていない
    評価区間は結果を持たず、順位も閉じた評価区間までの P = V_k − V_0 から T を計算し直す（完走時の数字を
    読むと毎フレームに答えが出てしまう）。run 終端の建玉断面も head が終端に届くまで落とす。
    **spot から回収した run はそのまま開ける** — `spot-run` は box の `runs/` 丸ごとを tar で持ち帰り
    `runs/<回収ID>/runs/<runID>/` に展開するので、dev サーバーの index は 2 階層下まで走査し、
    `runs/` からの相対パスを id にする（picker には `<runID> ← <回収ID>` と出る）
  - **`Scenario` タブが run の履歴**（既定タブ）。`stress_schedule`（seed から引かれた台形の計画）を
    絶対ブロック窓・またがる評価区間・実際に発火したブロック・終わり方（restored / failed）に変換し、
    清算・償還・slash・開いた arb 窓を時系列で並べる。**`crash`/`spike`/`cexDrift`/`flowTrend` は
    毎ブロックの記録を残さない**（価格の walk 自体を変えるので）ため「never fired」とは書かず
    「price chart を見よ」と出す。**seed は `run_started_realtime` に記録**（無い古い run は stat 自体を出さない）
  - **パネルは選択中の評価区間にスコープされる**（`scopeRunToRound` が run 自体を窓で絞るので、
    ビルダー側に第 2 の経路を作らない）。ヘッダに窓を明示し、全体に戻すリンクを出す。
    **例外は run 終端の 3 表**（GMX 建玉 / Aave 口座 / reserve）で、これは run 終了時の 1 断面なので
    タイトルに "at the run's final block" と書く。評価区間別 volume の合計が run 全体と違うのは
    最初のブロック（境界 0）の分だけ（評価区間は `(from, to]` で、最終境界は run の最終ブロック）
  - **agent の建玉は全 venue 分が `market.json` に入る**（`gmxPositionsAtEnd` / `aaveAccountsAtEnd` /
    `lstPositionsAtEnd` / `liquityPositionsAtEnd`）。**以前は GMX だけを見ていたので、run 中ずっと
    ステークや借入だけしていた agent は空表になり「壊れている」と見分けがつかなかった**。表は perp 形
    ではなく venue / kind / size / **何に対してマークしているか**（entry 価格・償還レート・ICR・HF）/
    detail。本当に建玉ゼロで終わった場合はその旨を文章で出す
  - `/explorer` は Blockscout の接続状態を明示し（indexed 高さ併記 / 落ちていれば起動コマンド）、
    検索が tx hash・block・address・**agent 名**（→ wallet address。Blockscout は名前を知らない）を
    解決して deep link する。Blockscout が無くてもローカル一覧のフィルタとしては効く
- `npm run manifest` — **環境マニフェスト**を書く（ADR 0021 §2。自己ホスト参加者に配る唯一の資料 = RPC/chainId/全 venue アドレス/PriceFeed/評価区間の長さ（`round.intervalBlocks`。旧名 `epochBlocks` を結果発表まで併記）/run の長さと採点日の格子（`period`）/action 語彙/limits/登録アドレス）。**走っている期間の配布物は `--from-run runs/<period>`**（coordinator の manifest.json に `--public-rpc` を差す。config だけからだと PriceFeed も期間の開始も無い）。**鍵は入らない**（coordinator が run ディレクトリに書き、dashboard がそれを HTTP で配る＝入れたら公開）。個別の鍵は `--participant <id>` で **stdout にだけ**出す。**ストレスイベントは種類と件数だけ**で窓は入らない（§1。resolved schedule ではなく config のイベント列から作るので構造的に漏れない）
- `npm run check:ordering -- --live` — **ビルダーが手数料順に並べるかを自分で入札して測る**（#35 の load-bearing assumption）。`economicGas: false` のプロファイルは oracle を全員より高く積んで txIndex 0 に置くので、順序が守られないチェーンでは環境の価格が front-run 可能になる（公式・練習の既定の economicGas では価格は storage 直書きで、この前提を使わない）。**入札は昇順に送る**ので到着順と手数料順が逆になり、到着順を保つだけのビルダーは降順プローブなら通ってこれで落ちる。引数なしは従来どおり blocks.csv の事後検査。
  **anvil が並べるキーは tip ではなく maxFeePerGas**（1.7.1 で実測。base fee 0 で払うのは min(maxFee, tip)）なので、
  tip 0.1 / maxFee 7 gwei の tx が 6 gwei のオラクルより前に入って 0.1 しか払わなかった。**`maxFeePerGas ≤ tip ≤ 上限`**
  （legacy は `gasPrice ≤ 上限`）を 1 本のルール（`sdk/src/feeRule.ts`）でゲートウェイ（403）・ランタイム（maxFee = tip で署名）・
  事後検査（blocks.csv 末尾の `maxFeePerGasWei` 列）が強制し、`--live` は maxFee ≠ tip のプローブで並べ替えのキーを判定する。
  legacy tx は以前 `priorityFeeWei` が 0 と記録されて上限検査を素通りしていた（今は gasPrice を記録）
- `npm run stress:rpc` — **Eris 形状の read 負荷**で RPC 容量を測る（#36）。`reconstruct.ts` と同じ read 集合の Multicall3 を agent × block で撃ち、cold/warm 別の p50/p99・ブロック間隔ジッタ（負荷有無）・`eth_call` の到達可能深度・sequencer-only か replica かの判定を出す。**読む対象が無いチェーンでは測る前に落ちる**（空アドレスへの call はノードが実残高より速く断るので、全滅が巨大な容量に見える。実際に「何もデプロイされていない anvil に 3,360 obs/s・sequencer-only で十分」と報告した）
- `npm run dashboard:build` / `npm run dashboard:serve` — 運営 hosted のダッシュボード（ADR 0021 §5。既定 :5174）。`/runs` ハンドラは dev サーバーと共有（`dashboard/server/runsApi.ts`）。**既定は運営ビューで `runs/` 配下が全部公開になる。**試行期間・ライブ週の公開（2026-09-06 決定）は **`ERIS_DASHBOARD_AUDIENCE=1`**（allowlist 配信 + **`events.jsonl` も種別 allowlist**（issue #210。`AUDIENCE_EVENTS`。載っていない種別・将来足される種別は出さない。`liquity_liquidation`/`_redemption`/`lst_slash` は continuous のみ = scenario ではレジームを名指す）+ **`tx_submitted`/`tx_submit_failed` は採掘後まで保留**（送信時に書かれるので live tail が pending tx を 1 ブロック先に名指していた。`headBlock` + 2 ブロック、tail は保留行の手前で止まり次回再配信 = 欠落しない）+ scenario では `flow-whale…`/`flow-launch…`→`flow`・oracle/keeper 以外の system→`system`（events と blocks.csv）+ seed / `stress_schedule`（continuous な run は未来の窓だけ、scenario の run は全部）/ **他の `stress_*` 全部も同じ規則**（scenario は全部落とす = どれもレジームを名指す。continuous は所属する窓が閉じたものだけ: `eventIndex` か `blockNumber` で判定、どちらも無い setup/funded 等は出さない。以前は `stress_event_applied` が oracle tx の**送信時**に書かれるので live tail から 1 ブロック先の価格が読め、`_summary` と summary.json の `stressEvents` からレジームが、`stress_token_launch_setup`/`_funded` から未来の窓と dud が分かった）/ calibration warning / vuln 正解 / stderrTail を落とし、scenario matrix の `regime` を `hidden`・**`seed` を `null`** に。`agents/*.jsonl`・`.llm.jsonl`・`disclosures/` は 404）、`ERIS_DASHBOARD_STANDINGS=0` は順位を一切出さないスイッチ（規約 §4.7 の「試行環境は順位を掲示しない」用に作ったが、**練習期間は日次リターンの練習順位を出す方針に変えた**ので hosted period では付けない。規約側は ascon-web で改訂）。`/runs/mode.json` で UI が理由を表示する。結果発表後はフラグを外すだけで §7.2 の全量公開。Cache-Control / gzip / index 3 秒キャッシュ付き（`docs/guide/dashboard.md` "Public view"）
  - **`ERIS_DASHBOARD_COMPETITIONS=<id>[,<id>…]` で配信する competition を限定する**（issue #84 K）。運営 box の `runs/` には smoke / test run が全部残っており、picker はそれを内部名のまま参加者に並べていた。通すのは **listed な competition と、その `matrix.json` が指す run と、その配下だけ**（index・ファイル・tail すべて）。未設定なら全部。
    **「今 live なもの」は通さない** — 実行中のエポックは完走まで matrix.json に入らないので、そこを推測で通すと
    「未完了の matrix がある間は runs/ 配下の live な run が全部通る」= 競技期間中ずっと運営の smoke run まで
    公開される（レビューで実証。60 エポックの matrix は最初から最後まで「未完了」）。練習期間は影響なし
    （segment は competition ディレクトリの**中**にあるので包含で通る）。scenario matrix の実行中エポックだけが
    完走まで出ない。「進行中」の表示はプランのエポック数から出しており、live run を見つけたかどうかではない
  - **`seed` の伏せ方は `null`**（`0` ではない）。伏せた seed・segment の連番プレースホルダ・本当に seed 0 の run は別物で、`seed 0` と印字するのは誰も引いていない draw を名乗ること
  - **mode 未取得中は両方の制限を掛ける**（issue #84 U）。`/runs/mode.json` が取れないブラウザに運営ビューを既定で見せると、試行環境で順位が出る
  - **公開ビューも run 中に読むものがある**: `blocks.csv` / `intervals.jsonl`（issue #140 以前の coordinator は `epochs.jsonl`。どちらも読み・配信する）/ `market.jsonl`（どれも coordinator が逐次追記し、サーバーも配信済み）。これを読まなかったせいで `/explorer` と盤面が期間中ずっと `blocks 0–0`・venue 全部 `—` だった（issue #84 A）。**ブロック行は coordinator の記録が先、チェーンはその先だけ**で、**カバーしている範囲を一緒に運ぶ** — 範囲より前に始まる評価区間は tx 数が「0」ではなく**「数えていない」**
  - **schedule の非公開はサーバーと同じ規則で表示する**（issue #84 D）。scenario の 1 エポックは「§3.3 により非公開」、continuous な run は「既に閉じた窓」。`0 件` と描くのはサーバーがしていない主張。公開ビューは `events.jsonl` の head を定期的に読み直す（閉じた窓は後から配信されるので、tail が通り過ぎていると二度と見えない）
- `npm run gen:method-selectors` — venue ABI から selector→関数名テーブルを再生成（ADR 0021 §4）。生成物にしてあるのはブラウザに ABI パーサと keccak を積まないため（実測 +15kB gzip）。ABI とのズレは `test/methodNames.test.ts` が落とす
- `npm run typecheck` / `npm run test` — 型チェック / ユニットテスト
- `npm run check:strategy` — 戦略コードの cheatcode 静的検査（入口ゲート）
- `npm run check:boundaries` — workspace 依存方向（example → sdk ← core）の検査
- `npm run bundle:agent <id>` — 提出用 zip（runtime + sdk + lib + 対象 agent。ADR 0015 §7）。**`kind: improve` の prompt.md が無いディレクトリは拒否**（規約 §2.5 が全提出 agent に戦略改訂を要求する。起動時ではなく提出物の段で止めるのは、example の 17 agent が prompt.md 無しの教材だから）

> **deployer は本 repo 同梱**（`deployer/`。旧 `../eris-app-deployer` を統合）。全 protocol を空の anvil へ deploy する自己完結のサブパッケージ（独自の `package.json` / `foundry.toml`）。初回のみ `cd deployer && npm install && forge build && cp .env.example .env && ./scripts/setup-vendors.sh`。以降は `cd deployer && npm run deploy -- --keep-fresh` で anvil 起動＋全 venue deploy。**焼き直すときは anvil ごと立て直す**（`--keep-fresh` が消すのは deployments.json だけ。全 venue の seed で deployer アカウントは 100 万 ETH のうち ~99.9 万を使うので、同じ anvil に 2 回目を流すと WETH の wrap で `insufficient funds` で落ちる）。`vendor/` の重いクローン（gmx-src/curve-src/twocrypto-src）は git 管理外で `setup-vendors.sh` が再現する。

> **Aave 自前のテスト market は閉じてある**（issue #190）。`@aave/deploy-v3` は自前のテストトークンで 8 reserve
> （WETH $4,000 / WBTC $60,000 等の固定価格）と、既定で誰でも 1 回 10,000 枚 mint できる `Faucet` を作る。競技は
> 共有 reserve しか使わないが Pool は同じで、**Aave の採点 `getUserAccountData` は全 reserve を合計する**ので、
> 放置すると faucet のトークンを supply するだけで P が増え、それを担保に共有 USDC/WETH も借りられた（実測）。
> deployer は `PERMISSIONED_FAUCET=true` で deploy し、`closeVendorTestMarket` が Faucet を owner 限定にして
> 8 reserve を `setReserveActive(false)`。**Aave が無効化を許すのは aToken も `accruedToTreasury` も 0 のときだけ**で、
> 一度でも借りられた reserve は全員が返済・引出しても treasury の利息の取り分が残り、**永久に無効化できない**。
> その場合は freeze して「treasury の残りのみ」と報告し、参加者の供給・債務が残っていれば freeze + 警告。
> **稼働中のチェーンは `cd deployer && RPC_URL=<node> npm run close:aave-vendor`**（冪等。参加者の残高が残れば
> exit 2、tx 自体が失敗した reserve があれば exit 1。1 本の失敗で後続を止めない）。閉じる対象は coordinator と同じく
> `getReservesList()` − (deployments.json の全 token + LST)（`deployer/src/protocols/aave-reserves.ts`。以前は vendor の
> deployment ファイルから列挙し、別 deploy のファイルを読むと「全部 not-listed」で exit 0 だった）。共有 reserve が
> Pool に無ければ deployments.json が別チェーンのものなので何も送らずに落ちる（共有 reserve まで閉じないため）。
> **ローカルの anvil では `.local-snapshot` より上に送った close は次の `sim:realtime` / `gen:state-dump` が巻き戻す**
> （resetFork が close 前の断面へ revert する）。ファイルがこのチェーンを指していれば closer は何も送らず exit 1 で、
> `npm run close:aave-vendor -- --revert-local-snapshot` が「pin へ revert → close → 取り直して書き戻す」
> （直前 run の残りは捨てる = 次の run も捨てる）。pin の無いチェーン（`chainMode: external`）は revert しない。
> **練習 devnet には pin がある** — unit は `sim:realtime --config config/practice.yaml` を `localDeploy: true` で
> 起動し `localSnapshotFile` の既定が `.local-snapshot` なので、coordinator は他のローカル run と同じく
> resetFork の snapshot/revert を通る。期間の途中で `--revert-local-snapshot` を打つと**その期間が巻き戻る**
> （pin は参加者が取引した全ブロックより前）。devnet では coordinator を止めて pin を**削除**し、close して再起動する。
> coordinator はローカルデプロイ + aave の run で `Pool.getReservesList()` を列挙し、registry + LST 以外の
> **active な reserve が 1 本でもあれば全 chainMode で起動時に落ちる**。例外は freeze 済みで参加者の aToken
> （treasury 保有分を除く）も債務も 0 のものだけ（`aave_reserve_check`。
> `core/src/realtime/aaveReserveGuard.ts`）。**これ以前の state dump は全部これで落ちる**ので `npm run gen:state-dump` で焼き直す。

> **deploy 鍵は `MNEMONIC`**（既定は anvil の**公開**テスト mnemonic。issue #74）。index 0 の deployer は Aave の
> POOL_ADMIN・GMX の CONFIG_KEEPER・LST vault の owner・seed した LP 全部・genesis Trove の余剰 eUSD を持ち、
> しかも全アドレスが `CREATE(deployer, nonce)`。**参加者が tx を送れるチェーンでこの既定を使ってはいけない**
> （mnemonic は anvil のバナーに出るので「deployer」は全員が持つ鍵になる。gateway の allowlist では塞がらない）。
> 秘密 mnemonic は `deployer/.env`（gitignore 済み）か `MNEMONIC="$(cat ~/…)" npm run deploy -- --keep-fresh`。
> `npm run anvil` も同じ値を読む（`src/anvil-cli.ts` 経由で `--mnemonic` を渡す）。**鍵を変えると全アドレスが動く**ので
> `npm run gen:local-constants` → 必要なら `npm run gen:state-dump` まで必ずやる（古いアドレスを読むと GMX が
> `getMarkets returned no data ("0x")`。deploy 側がそう名指しで落とすようにした）。**deployer の鍵は poc 側の秘密にもなる** —
> 環境として売買する stress（`liquidityPull` / `depeg` / `eusdDepeg`）は deployer から送るので `.env.local` に
> `DEPLOYER_PRIVATE_KEY`（既定 = anvil account 0）。**既に起動している anvil の第 1 アカウントが `MNEMONIC` の派生と
> 違えば deploy は起動時に落ちる**（既定 mnemonic の deploy で秘密チェーンを上書きする逆向きも同じ穴）。
> **coordinator 自身の鍵も同じ**: `admin`（PriceFeed の owner・Aave aggregator の書き手）/ `keeper` / `setup` の既定は
> anvil の公開鍵か `keccak256("eris-role:<role>")`（公開コードから計算できる）。参加者が送れるチェーン（登録ファイル
> か external のロスター）では、この 3 本（setup は agentMarkets が有効なときだけ）と deployer のどれかが公開鍵、または venue の管理者が anvil のテスト
> アカウントなら**起動時に拒否**する（`core/src/realtime/roleKeyGuard.ts`）。非公開のリハーサルだけ
> `ERIS_ALLOW_PUBLIC_ROLE_KEYS=1`（`public_role_keys_allowed` が記録される）。
> hardhat 側 2 本（`vendor/aave/hardhat.config.js` と `gmx-localhost.patch` の localhost）も同じ `MNEMONIC` から
> accounts を引く（既定の `accounts: "remote"` はノードが unlock している鍵で署名するので、この 2 venue だけ
> 別の owner になる）。patch を更新したら `npm run clean:vendors && ./scripts/setup-vendors.sh`。

> 評価・採点・可視化系コマンド（`sim` 同期ラウンド / `evaluate` / `gate` / `discrimination` / `leaderboard` / `stress-report`）は撤去済み。run は `sim:realtime` 一本。run 後の解析は `runs/<id>/` の `summary.json` / `events.jsonl` / `blocks.csv` / `market.json`（venue 別価格・depth・GMX OI・Aave 残高・tx notional。採点には不使用の報告用 = issue #63 Phase 2）を直接読む。可視化は `npm run dashboard`（`dashboard/` workspace。run picker で run を選ぶ。seed データに戻すには `VITE_DATA_PROVIDER=seed`）。

### 市場ストレスイベント（spike/crash + Aave 清算。ADR 0009。既定 off）

OU の base price はそのまま進め、その上に **SEED 由来でランダム化した決定論オーバーレイ**（`core/src/realtime/events.ts` `EventSchedule`）を重ねて effective price を導出する。effective が PriceFeed・Aave WETH オラクル・GMX・採点へ一貫伝播し、窓外では β≈0 を保つ（ADR 0007 を毀損しない）。清算を成立させる **seed 由来 victim 群**（採点対象外）を建てる。`config/local.yaml` の `stress:` セクションで指定:

- `stress.events` — イベント配列（**値でなくレンジ**を与え過学習を抑制）。YAML 配列で書ける（例: `- { type: crash, magnitudeRange: [0.12, 0.16], windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }`）。`spike`/`crash` の台形（ramp→hold→decay）。要 `run.blocks>0`
- `liquidityPull`（issue #52。uniswap / balancer / curve・**ローカルデプロイ専用**）— 同じ台形で**プールの depth を引き抜き、窓が閉じたら戻す**。`venue:` 省略で**有効な全 venue**（1 つだけ薄くしても執行が他所へ移るだけ。narrowing が opt-in）。magnitude は「抜く割合」（1.0 は禁止＝板が消えると全 swap が revert して「薄い板」でなく「停止」になる）。価格 overlay ではなく coordinator が毎ブロック**目標 depth へ reconcile** する（一撃 removal だと dropped block で取り残される。`pointEventsAt` が同じ理由で一度壊れた）。**両側比例**で抜くので mid は動かず無リスク裁定は開かない。環境が seed した LP（deployer = anvil account 0）を動かすので、ロスターが `AGENT0_PRIVATE_KEY` を使っていると nonce 衝突で fail-fast。fork では seed した LP が存在しないので同じく fail-fast
- **`cexDrift` / `flowTrend`**（issue #56）— **run 全体の config だった 2 レジームを窓イベント化したもの**。
  連続経済では「run 全体がドリフトしている週」を注入できない（週は 1 本で、その中に複数のエピソードが
  非公開スケジュールで入る）。`cexDrift` は**価格の walk 自体**を変える（drift を足し `kappaMultRange` で
  平均回帰を弱める。overlay と違い窓が閉じても価格は戻らない = ドリフトの意味）。`flowTrend` は
  uninformed フローを窓の間だけ傾ける（`magnitudeRange` = サイズ倍率、`trendCorrelation` /
  `persistBlocks` は窓が開いている間フル適用。「ramp 中は相関 0.5」は弱いレジームではなく別のレジーム）。
  較正元は `config/regimes/cex-drift.yaml`（drift 0.0015 / kappa 0.004 = 既定 0.02 の 0.2 倍）と
  `config/regimes/informed-flow.yaml`（サイズ 3x / persist 12 / correlation 1.0）。**単一種のイベントで
  埋めた週は特定の戦略にしか仕事を作らない**（実測: depeg だけの週では venue-arb が 5 seed 中 3 本で
  無取引 = `docs/scoring-metric-measurements.md`）
- **`persist: true`**（depeg / eusdDepeg）/ **`repriceAnchor: true`**（cexDrift）— **戻さない**（issue #56）。
  既定では窓が閉じると環境が買い戻し、OU も初期 anchor へ引き戻すので、**どの価格変動も一時的**になる。
  すると「par に戻るか」の答えが常に yes になり、粘る戦略が判断ではなく構造で勝つ。`persist` は水準を
  run の最後まで保持（`decayBlocks: 0` 必須。decay を黙って無視しないため fail-fast）、`repriceAnchor` は
  OU の anchor をドリフト分だけ動かして新しい水準を常態にする。**teardown の買い戻しは残る**
  （起動チェックがデペグ済みプールを拒否するので、次の run が始められなくなる。最終採点ブロックより後）
- **`alignWith: <type>`** — 窓の開始位置を他イベントと共有する。**同じ `windowFrac` レンジでも draw は独立**なので、360 ブロック run では crash と liquidityPull が平均 ~160 ブロック離れて落ちる。「gap の最中に板が薄い」は組み合わせの性質なので明示が要る（`config/regimes/crash.yaml` が使用例）
- **窓の数・形・向き・戻り方も seed が引く**（2026-09-27）。以前は magnitude と開始位置しか引いておらず、本数・バンド・台形の長さ・crash の向き・必ず全部戻ることは YAML に書いてあった。
  `count: [min, max]`（0 可。重ならず、開始は `windowFrac` 内で一様。follower は anchor の本数を窓ごとに対で継ぐ）/ `minGapBlocks` /
  `rampBlocks` 等の `[min, max]` / `flipProb`（crash・spike。解決済みは `type: spike, flippedFrom: crash`。victim のあるレジームでは使わない）/
  `recoverFrac`（crash・spike。戻らない分は run 終了まで残る = 「急変に逆張りして窓で手仕舞う」の構造的正解を消す。**練習期間では使わない**。残差が複利になる）/
  `venue: random`（whale）/ `repriceAnchorProb`（cexDrift）。公式 10 本に適用済み（calm・vuln は無変更。lending-incident / cdp-incident は暴落 1 本・下落固定で、形と回復だけ）。
  **これらを 1 つでも使うスケジュールはイベント列（FNV-1a）も stream の salt に混ぜる**（イベント列を混ぜないと crash#s と spike#s、depeg と depeg-persist、
  lending-incident と cdp-incident が同じ draw を引き、同じブロックに開いて反転も連動していた）。使わない config は seed だけの stream。
  **公式レジームの実現値は全部変わった**ので、それ以前の matrix とは比べられない（ADR 0027 の鍵付きストリームで、もう一度全部変わった）
- `stress.victimCount`(既定 0=無効) / `stress.victimHf0`(既定 1.10) / `stress.victimWethWei`(victim 1 体の supply)。**較正の連動**: 建てるには `HF0 ≳ LT/(0.97·LTV)`（実測 Arbitrum WETH の LT=0.84/LTV=0.80 で ≈1.08。これ未満は borrow が LTV 縁に張り付くため fail-fast）。割るには crash magnitude `m > (HF0−1)/HF0`（HF0=1.10 なら m>9.1% → 例の [0.12,0.16] で確実に割れる）。breach 不能な設定は `stress_calibration_warning` を emit。borrow がサイレント revert したら setup で fail-fast(debt 検証)
- **victim を建てるには fresh state 必須**（soft-reset だと前 run の victim ポジが残留して HF が壊れる。未満は fail-fast）: fork は full re-fork（`ARB_RPC_URL` 設定 + `ERIS_SKIP_RESET` 不可）、ローカルデプロイは resetFork の snapshot/revert クリーン断面で満たす（ADR 0016。backtest で実証済み）。ローカルでは victim を建てる前に Aave オラクルを初期 fair price へ較正する（fork の「オラクル≈実勢≈fair0」が成立しないため。coordinator が自動実行）
- stress run（events かつ `ERIS_RUN_BLOCKS>0`）は**時間制限を自動無効化**しブロック数で終了する（`ERIS_RUN_SECONDS` が先に切れて crash 窓へ到達しない事故を回避。override は `stress_run_time_limit_disabled` で記録）
- coordinator は `stress_schedule` / `stress_victim_hf` / `stress_liquidation` / `stress_liquidity_pull`（+ `_setup` / `_failed`）/ `stress_liquidity_restored`（残差が閾値超なら `_incomplete`）を events.jsonl へ emit する。depth の帰属は `stress_liquidity_pull` の `poolLiquidityBefore`（実測）と `targetLiquidity` を読む。liquidator agent には victim アドレスを `ERIS_LIQUIDATION_VICTIMS` で配布する。清算の帰属は agent ログの `liquidationCall`(rawTx) を一次情報にする（events.jsonl を直接読んで解析する。旧 stress-report ツールは撤去済み）

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
- **利回りはブロックごとに積むが、時計は Aave・GMX と同じ EVM 時間**（ADR 0028。`lst.simulatedSecondsPerBlock`
  の既定は `run.blockTimeSec`、`lst.apyBps` 既定 3%/yr）。**以前の既定は 1 block = 1 時間**で、公式 12 本でも
  1 エポック = 15 日分 = 12.3bps の利回りが Aave の借入コスト（EVM 時間で ~0）に対して無リスクで付き、
  「block 0 で全額ステーク + Aave でループ」が恒久最適だった。今は 1 エポック ~0.007bps でガス未満。
  `config/lst.yaml` / `config/regimes/lst.yaml`（venue 単体検証、公式セット外）は 3600 を明示して圧縮したまま。原資は事前投入 reward reserve に上限され、
  `accrueRewards()` は permissionless（額はブロック数の純関数なので誰が叩いても同じ）。coordinator は毎ブロック
  oracle tx と**同じ admin nonce の直列**で叩く（並列にすると nonce 衝突でレートが凍る）
- **プールの rate oracle 配線が要**（`stEthPerToken()` を asset_type=1 で登録）。未配線だとレート上昇が全員に開かれた
  無リスク裁定になる（ADR 0007 を毀損）。deploy 時 assert + 起動時 `lst_setup` で乖離 200bps 超は fail-fast
- **マークが 2 本ある**（`sdk/src/protocols/lst.ts`）。**採点が合計するのは `valueUsdc` = face value**
  （`shareAssets + claimable + reachable + unreachable` × WETH fair = vault が負う par）。
  `realizableWethWei`（「今プールで売った額」と「run 終了までに finalize するキューの par」の**良い方**）は
  `liquidatableValueUsdc` に入り、**マークと差が出た agent だけ報告される診断値**。run 終了後にしか claim
  できない pending は realizable 側からは外れて `reason:"unrealizable"` で `scoring_unpriced_holdings` に
  報告されるが、**採点側の par には含まれている**。#41 の staged-read インターフェース
  （`valueAtBlock` / `liquidatableValueUsdc` / `ValuationContext.horizonBlock`）の最初の消費者。
  **決着済み（issue #40 / ADR 0022 Amendment 1）: 採点は realizable**。#38 の意図どおり。
  ADR 0019 §3 が par を選んでいたのは「決める場が無かった」からで、issue #40 の公理 3
  （額面で評価すると攻撃が捏造された価値として記録される）がその場を作った。
  **採点系列は全 venue で `liquidatableValueUsdc` を合計する**。報告の向きは反転し、
  額面のほうが `markedValueUsdc` として出る
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

### CDP stablecoin venue（Liquity V1 フォーク = eUSD。issue #39。既定 off・**ローカルデプロイ専用**）

Liquity V1 の core を**無改変**でフォークした CDP（`deployer/src/protocols/liquity.ts`）。Recovery Mode・
再分配・sorted list・2 本の動的手数料がそのまま入っているので、他 venue に無い skill が 4 つ増える:

- **redemption arb** — eUSD は常に「最もリスクの高い Trove に対して $1 分の担保」と交換できる。よって
  eUSD/USDC プールのディスカウントは**プロトコルが強制する価格に対する乖離**であって価格予想ではない（ADR 0007 の α 方向）
- **Stability Pool** — eUSD を預けて清算債務を吸収し担保を割引で受け取る
- **Recovery Mode** — system TCR が CCR(150%) を割ると清算閾値が MCR でなくなり、**その時点の TCR** を
  下回る Trove が清算対象になる（SP がその債務を全額吸収できる場合のみ。押収は債務の 110% で頭打ちで、
  余剰は借り手が claim できる）。全員の線が同時に動くのが Aave の per-position HF と対照的
- **sorted list 上の位置** — 償還は最下位 ICR から walk するので、借り手は「自分の前にどれだけ債務があるか」を守る

ours なのは 2 つだけ（core は無改変）:
- `LiquityPriceFeedAdapter` — Liquity は wiring 後に ownership を renounce するのでオラクルアドレスは永久固定。
  一方 run は毎回新しい PriceFeed を deploy するので、その間に挟んで admin key で毎 run 差し替える
- `LiquityRedemptionHelper` — **部分償還のヒントは実行時価格に依存する**（`_redeemCollateralFromTrove` が
  執行価格から NICR を再計算してヒントと一致しなければ partial を cancel）。環境はブロック毎にオラクルを
  書き、しかも agent より先に入るので、オフチェーンで計算したヒントは構造的に必ず陳腐化する
  （venue の初回 live run で全償還が `Unable to redeem any amount` で revert して判明）。helper は
  `fetchPrice()` で価格を確定させた同一 tx 内でヒントを計算する。periphery であって core の改変ではない

- **eUSD は TOKENS レジストリに入れない**……**だったが issue #27 (b) で昇格した**。外していた理由は
  「レジストリが stable を $1 で値付ける」だけで、それが消えたため。今は**市場価格 stable**（下の節）で、
  価格の所有者は共通 probe = `sdk/src/stables.ts`。**spot の eUSD 残高は scorer の spot 掃引が値付け、
  liquity アダプタは値付けない**（二重計上の回避）。アダプタに残るのは Trove と Stability Pool で、
  債務は get_dx で買い戻しコスト。SP 預入の eUSD は**財布の eUSD と合算して scorer が売る**（`stableLongs`。
  別々に自分サイズで quote すると「それぞれ最初に売る」2 回の売却になり、財布で押し上げた分だけ預入が高く見えた）。gas compensation 200 eUSD は
  借り手の負債ではないので差し引く。ICR<100% の Trove は 0 で clamp（担保を捨てて歩き去れる = CDP の
  実際の性質）
- **担保は native ETH**（core が `msg.value` で受ける）。action 側は WETH wei 建てで、`buildTxs` が
  `WETH.withdraw` を前置する。**検査は WETH 残高に対して行い、unwrap した分だけを value に載せる**ので
  ガス用の ETH は正味で減らない（以前ここに「ガスと同じ残高なので閉じる tx すら送れなくなる」と書いてあり、
  それが参加者ガイドにそのまま写っていた）。逆向きが落とし穴で、閉じる・引き出す・償還・SP の gain は
  **native ETH で戻る**（WETH に戻すアクションは無い = `rawTx` で `WETH.deposit()`）。
  observation に `ethBalanceWei` / `suggestedGasReserveWei` を出すが**強制はしない**（self-stranding は正当な負け）
- **open/adjust の ICR 検査は composite debt**（要求額 + 借入手数料 + gas compensation 200。チェーンの
  `_computeCR` と同じ分母）。要求額だけで割っていた頃は 110% 付近が検査を通ってチェーンで revert した
- **CollSurplusPool の余剰担保も数える**（`liquity.collSurplusWei`。全額償還や RM の上限つき清算で残る分）。
  claim すれば native ETH になるので realizable = WETH fair。請求は `rawTx` で `claimCollateral()`（action は足さない）
- action は 8 つ: `liquityOpenTrove` / `liquityAdjustTrove` / `liquityCloseTrove` / `liquityRedeem` /
  `liquityProvideToSP` / `liquityWithdrawFromSP` / `liquityLiquidate` + `liquitySwapEusd`。
  最後の 1 つは issue #39 の列挙には無いが、**venue 自身の α（デペグを買って償還する）が届かなくなる**ため追加
- **`eusdDepeg` ストレスイベント**（`stress.events`）— プールは par で seed されるので、放っておくと
  redemption arb は「何もしないのが正解」になる。環境（deployer アカウント = genesis Trove の余剰 eUSD 保有者）が
  窓の間だけ eUSD を売り、閉じたら買い戻す。liquidityPull と同じ**毎ブロック目標へ reconcile** 方式
  （一撃だと dropped block で取り残される）。magnitude は「プールの seeded eUSD depth の何割を売ったか」
- **較正**（実測。100k/100k・A=100 のプール）: 40k 売却で 114bps / 50k で 175bps / 60k で 282bps。
  償還手数料 floor 50bps + 償還 ETH を USDC に戻す ~30bps を超えて初めて α になる。
  プールの A は 2000 ではなく **100**（A=2000 だと半分売っても 4.4bps しか動かず、償還手数料を永久に超えない）。
  eUSD 供給 350k に対し baseRate は 5k 償還ごとに約 +71bps 上がるので、**先に償還した者が後続の価格を決める**
  （issue #79 以前は供給 250k・+100bps。genesis Trove 250 ETH / 250k eUSD → 350 ETH / 350k eUSD、Stability Pool
  50k → 125k = Liquity 実測の供給比 50%。deployer の余剰 = 環境が `eusdDepeg` で売る在庫は 100k → 125k で、
  cdp-incident の 85% 売却も cdp-recovery の `liquitySpSeedEusdWei` 100k も cap されない）
- coordinator は `liquity_setup`（オラクル差し替えと drift 検証。Recovery Mode 開幕やデペグ済みチェーンは fail-fast）/
  `liquity_block`（毎ブロックの peg・TCR・手数料・最下位 ICR）/ `stress_eusd_depeg`（+ `_setup` / `_capped` /
  `_failed` / `_restored`）を emit する
- **オラクル順序の実測**（issue #39 の Open point「清算は Aave より順序に敏感か」への回答）: 敏感だが
  **特別扱いは不要**。実測（`config/regimes/liquity-crash.yaml`, seed 501）では、Trove が MCR を割った
  ブロック 982 → agent が観測した 983（観測は 1 ブロック遅れ）→ 清算が着弾した 984 で **2 ブロック遅延**。
  内訳は「観測遅れ 1 + mempool 1」で、これは全 venue 共通。**部分償還のヒントと違い、`liquidate()` には
  実行時に一致しなければならない値が無い**（執行価格で ICR を再判定するだけ）ので、価格が戻れば単に
  revert して gas を捨てるだけ＝構造的な破綻ではない。よって helper のような仕組みは清算側には不要
- 参照 agent は 3 体: `redemption-arb`（α 側）/ `trove-manager`（借り手側。清算・償還・Recovery Mode に
  対する防御）/ `sp-underwriter`（Stability Pool で清算を吸収し、自分で `liquidate` を叩いて担保を取る）。
  借り手の防御が効くかは**借りた eUSD を使ったかどうか**で決まる（`ERIS_TROVE_SPEND_DEBT`）。実測で
  200% 保持組は無傷、125% で全額 post して eUSD を売った組は清算され −13,140（担保 20 ETH を失い USDC を残す）
- **Recovery Mode は公式レジームの較正では到達不能**（実測: seed 501 で最小 TCR 2.244 対 CCR 1.5）。genesis Trove
  が 350 ETH / 350k eUSD（300%。#79 以前は 250 / 250k）で TCR を支配するため。**到達させるのは victim cohort の仕事**（issue #59 →
  `config/regimes/cdp-recovery.yaml`、公式セット外）: `stress.liquityRecoveryTcr` を書くと coordinator が seed の引いた
  crash magnitude と現状の system から各 victim の担保を逆算し（`recoveryCohortCollateralWei`）、届かなければ setup で
  fail-fast。RM の清算（MCR〜TCR 帯）は SP が債務を全額吸収できる場合しか執行されないので `stress.liquitySpSeedEusdWei`
  で環境が deployer の eUSD を SP に入れる。genesis を下げないのは償還順序と SP 相対深度を全レジームで壊すから。
  手数料カーブの希釈（供給に反比例）は不可避で、この regime の償還較正は別に測る。sp-underwriter は RM 帯でも
  清算する分岐を持つ（SP が全額吸収できる Trove だけ）
- **環境が LQTY を 200 万ステークしている**（`stakeEnvironmentLqty`。bounty 枠を mnemonic index 100 の staker に
  mint してそのままステーク）。LQTYStaking は借入手数料（eUSD）と償還手数料（ETH）をステーク量で按分するが、
  multisig 枠は 1 年ステーク不可・残りは SP の emission なので、**放置すると SP で数 LQTY を得た最初の agent が
  以降の全手数料を取り、自分の償還・借入も実質無料**になっていた。ステーク量 0 の間の手数料は元々コントラクトに
  宙に浮いていたので、お金の流れは変わらず持ち主ができただけ。staker の鍵は deployer と同じ秘密（公開 mnemonic の
  deploy は role-key guard が deployer 側で拒否）。**ステークが 100 万未満の deployment は起動時に落ちる**
  （`lqtyStakeProblem`。これ以前の state dump は全部焼き直し）。agent 自身のステークの未請求手数料は採点に入り
  （SP の ETH gain と同じ扱い。eUSD は stableLongs）、ステーク中の LQTY は `liquity-lqty-staking` で unpriced 報告。
  観測は `lqtyBalanceWei` / `lqtyStakedWei` / `stakingEthGainWei` / `stakingEusdGainWei`
- **LQTY は意図どおり「値付けしないが見える」**: SP 預入で LQTY gain が付き、run 後に
  `scoring_unpriced_holdings` に `erc20-unaccounted` として 61.3 LQTY が報告された（黙って 0 にしていない）
- 設定例は `config/liquity.yaml`、レジームは `config/regimes/liquity.yaml`（α 側）と
  `config/regimes/liquity-crash.yaml`（借り手 / 引受側）、参照 agent は
  `example/agents/redemption-arb/`（`agent.ts` + `prompt.md`）。issue #39 は「agent.ts と prompt.md を
  両方積め」と書いているが、その理由（既定ロスターが prompt モード = LLM が毎判断する）は ADR 0018 で
  消えている。今の prompt.md は改訂方針であって毎判断プロンプトではない

### エージェントが作る市場（MarketRegistry + 許可不要レンディング。issue #40 / ADR 0022。既定 off・**ローカルデプロイ専用**）

参加者が**自分のコントラクトをデプロイでき**、環境がそれを検出して全員に配る。`agentMarkets.enabled: true`
で有効（既定 off。毎ブロックの getLogs と block 取得が増えるので、誰もデプロイしない run に払わせない）。
`run.protocols` に `lending` を入れるなら必須で、入れて false だと**起動時 fail-fast**。

- **採点はラウンドトリップ規則**（ADR 0022 §1）。**環境が評価できないコントラクトの中に残った価値は
  エポック最終ブロックで 0。ただし通り抜けた利益は満額数える。** deposit 10,000 → withdraw 11,000 なら
  +1,000 は計上され、計上されないのは鐘が鳴った時点でまだ中にあるものだけ。**あらゆる罠クラスが
  「時間内に抜け出せなかった」1 つに潰れる**ので、honeypot にも proxy 差し替えにも個別の防御機構が要らない
  - **「0 にした」のではなく「報告するようにした」**。EOA 掃引はもともとそこを見ず、どのアダプタも
    請求しないので値は元から 0 だった。`scoring_unpriced_holdings` に `reason:"unrealizable"` で出す
    （`unknown-contract:<addr>`）。出さないと「置き忘れ」と「取引の損」が summary.json で区別できない
  - 数え方は **Transfer ログのネット**（`sdk/src/agentMarkets.ts` の `StrandedLedger`）。残高ではない —
    プールの 1,000 USDC は LP 保有者のものなので、預けた側にも足すと同じリザーブを 2 回数える
- **`MarketRegistry` は PriceFeed パターンの 2 例目**（`contracts/MarketRegistry.sol`）。owner-gated write、
  1 エントリ 1 イベント、`count`/`all`/`isRegistered`。**1 ブロックの配布遅延を継承する**ので作った本人が
  1 ブロック早く知る＝作る誘因。**dedup キーは `(market, extra)` の対**（貸出市場は全部シングルトンの
  アドレスに乗り、`extra` = marketId で区別する）
  - **codehash は登録時のものだけ。更新しない。**ラウンドトリップ規則の下では差し替え proxy は
    「抜け出せなかった」の一形態なので環境が取り締まる必要がなく、気づくかどうかが技能差になる
  - **登録は毎ブロック上限つき・環境負担**（`agentMarkets.registrationsPerBlock`、既定 8）。あふれは
    次ブロックへ繰り越し、factory 由来を先に。**書き込みは admin ではなく setup 鍵**（oracle 更新が
    毎ブロック admin から出ているので、同じ鍵に 2 送信者を置くと nonce を奪い合う）
  - **読み手は `all()` を呼ばない**（`count()` + `entriesFrom` を 256 件ずつ。`sdk/src/marketRegistry.ts`）。
    `all()` のガスは件数に比例し（cold storage で 1,500 件 ~29.5M、**1,600 件で 30M の call 上限を超えて out of gas**）、
    件数は誰でも安く積める（`createMarket` は permissionless、環境は毎ブロック 8 件登録 = 200 ブロック）。以前は全 agent の
    観測が毎ブロック `all()` を読んでいたので、そこを超えると**全員の観測が毎ブロック失敗**した。watcher は追記専用の
    リストを一度だけ読んで保持し、毎ブロックは新規分だけ読む。読取に失敗しても観測全体は落とさず、前回の section に
    `registry.error` を付けて返す
  - 発見は **factory ログ + `to === null` の top-level CREATE スキャン**。**内部 CREATE は取りこぼす**
    （対称なので受容。誰にも見えないものは誰も釣れない）。ERC-20 判定は name/symbol/decimals の
    static call ヒューリスティック
- **`SimpleLending.sol` = 許可不要の貸出シングルトン**（Morpho Blue 風。`ProtocolId: "lending"`）。
  **配置されるのは `run.protocols` に `lending` がある run だけ**（2026-10-05、ascon-web#18）。以前は agentMarkets が
  on なら無条件に配置していたので、公式 12 レジーム全部に「規約 §3.1 に無く、呼べて、registry が `verified` と
  表示し、鐘の時点で 0 に数える venue」が立っていた。公式レジームは 1 本も `lending` を持たない（`agent-markets.yaml`
  だけ）。manifest の `lending` と `market_registry_deployed.lending` は未配置なら無い / `null`
  市場は `(loanToken, collateralToken, oracle, irm, lltv)` で `createMarket` は誰でも呼べる。
  **Aave にできないのはここ** — reserve を開くのは `PoolConfigurator` で `POOL_ADMIN` 専用だから、
  Aave をエージェントへ開くには admin を渡すしかない
  - **オラクルは任意アドレス。作成者が握っていてよい**（ADR 0014 が先送りした偽オラクルクラス）。
    Verifier の仕事は `owner()` を読むこと。`ConfigurableOracle`（owner あり＝罠）と
    `PriceFeedOracle`（owner なし・immutable＝正直）を両方同梱してあるので、
    「オラクルが動かせるか」は本物の識別子になる
  - **採点は回収可能額**（`backedFraction`）。供給側は「残っている loan token ＋ **借り手ごとの**
    `min(その借り手自身の担保の環境価格, その借り手の債務)` の合計」への持分（`recoverableDebt`）、
    借り手側は `max(0, 担保 − 債務)` で**床は 0**（担保を捨てて歩き去れる＝Liquity の
    ICR<100% clamp と同じ規則）。**市場自身のオラクルは清算だけを決め、マークは書かない**。
    **市場全体の担保合計で相殺してはいけない** — 清算が差し押さえられるのはその借り手の担保だけなので、
    以前の規則では 1 体の余剰担保（債務 0 で預けた担保）が本人の資産と他人の焦げ付きの裏付けとに
    二重に数えられ、同じ参加者の 2 体で約 +27k の架空利益が出た（監査 M1）。借り手は
    コントラクトの `borrowerPositionsFrom`（今債務を持つアドレスの一覧。swap-and-pop）から読み、
    1 市場 `BORROWER_SCAN_LIMIT`（1,024）を超えた分の債務は回収 0 として数える（安全側）。
    **借り手の一覧を読むのは「誰かの index に載っていて、かつ債務がある市場」だけ**（下の per-user index
    と組み合わせる。供給していない市場の裏付けは自分の評価額を変えないので読まない）
  - **金利は装飾**。エポック 12 分で 3%/年は 0.00007%。効く餌は**レバレッジ（高 LLTV）と清算ボーナス**で、
    貸出の罠の被害者は**借り手か清算人**であって供給側ではない。IRM は正直にそう書いて同梱
  - **建玉はコントラクトの per-user index から読む。市場一覧の切り出しでは読まない**（issue #212 / #216 項目 1）。
    `marketIds()` のガスは件数に比例し（~1,500 件で 30M の call 上限）、しかも採点は**最新 512 件に切ってから**
    空市場を除いていたので、被害者の市場より新しい空市場を 512 件作ると（1 件 ~17 万 gas = 1 ブロックの予算で
    ~170 件）建玉が評価から消え、警告も出なかった。今は `supply`/`supplyCollateral`/`borrow` が `(market, user)` の
    初回に `_userMarketIds[user]` へ追記し（建玉を作る呼び出しはこの 3 つだけ。清算は他人の建玉を減らすだけ）、
    採点（`valueAtBlock` / `valueUsdc`）は agent ごとに `userMarketIdsFrom` を 1 回読む。伸ばせるのは本人だけなので
    `USER_MARKET_LIMIT`（128）は自分の建玉しか切らず、超過は `lending-unscanned`、読めなかった市場・建玉は
    `lending-market:` / `lending-position:` の `read-failed` で `scoring_unpriced_holdings` に出る。観測は
    `marketCount` + `marketIdAt` を 256 件ずつ新しい順に 512 件まで歩き、**自分の市場は窓から落ちても index から戻す**。
    SDK の ABI に `marketIds` は無い（`test/lendingMarketIndex.test.ts`）。コントラクトは run ごとに `out/` から
    deploy するので state dump は無関係で、`forge build` だけ要る。**その `out/` が古いと静かに壊れる**ので
    deploy の前に ABI を実測する（`assertArtifactHasFunctions`。`userMarketIdsFrom` / `userMarketCount` /
    `expectedPosition` が無ければ `npm run build:contracts` を名指しして落ちる）。黙って通すと per-user index の
    読取が空で返り、**全 lending 建玉が 0 のまま run は採点も順位も出す**
- **アクション**: `createPool`（uniswap 所有。NPM の `createAndInitializePoolIfNecessary`）/
  `createLendingMarket` + `lendingSupply`/`Withdraw`/`SupplyCollateral`/`WithdrawCollateral`/`Borrow`/
  `Repay`/`Liquidate`（lending 所有）。**デプロイは `to` を省いた `rawTx`** — ランタイム経由なので
  nonce 管理・本数上限・ガス予算を取引と共有する（自前署名すると同じ鍵に 2 送信者ができる）。
  ヘルパは `example/agents/lib/deployContract.ts`
- **承認は必要額ちょうど**（`exactApproveTx`）。無制限 approve で抜くコントラクトは規約の範囲内なので、
  参照ランタイム自身がその穴になってはいけない。observation は registry エントリへの未消化 allowance を出す
- **ガス予算（T0）**: **per-tx 10,000,000 / per-agent-per-block 10,000,000**（2026-10-03。30M / 30M から下げた。
  30M だと 1 体がブロック全体を正当に使えた = 背景フローの tip（0.1〜0.2 gwei）の少し上で 28M を燃やすと 360 ブロックで
  ~1 ETH、他の参加者と背景フローを毎ブロック締め出せた。10M は正当な最重量 = Uniswap V3 の `createPool`（~5M、申告 ~6.5M）と
  24KB の deploy（申告 ~8M）が通る値。local run の agent tx 31,454 件は p99 0.9M・最大 0.95M。
  **anvil は申告 gas ではなく実使用量でブロックに詰める**（1.5.1 で実測: 申告 29M × 5 本が 30M のブロックに全部入った）ので、
  申告だけで占有はできない。本番の anvil の版では未実測）。
  規約 §2.6 は tx の**本数**を縛らないので、自分で書いた高価なコードへの 1 呼び出しでブロックを飢えさせられる —
  他参加者だけでなく**環境のオラクル更新**も。1 つの数字を 3 か所が読む（ゲートウェイが RLP で
  gas limit を読んで **403 入口拒否** / ランタイムが自己制限 / run 後に blocks.csv の `gasUsed` 列で検出）
- **owner ガードは実測する**（`core/src/realtime/ownerGuards.ts`）。役割のないアドレスから特権書き込みを
  `eth_call` で模擬し、**revert しなければ穴**。`agentMarkets` が on の run では 1 つでも残れば起動時に落とす。
  **実際に 2 件見つかって塞いだ**: `MockAggregator.setAnswer` と `MockOracleProvider.setPrice` が
  permissionless だった（＝ Aave 全借り手の清算と GMX 全建玉のマークが誰でも動かせた）。
  owner は `immutable` なのでスロット 0 は `_answer` のままで economic-gas の直書きは不変
- **環境はエージェント製市場に手を出さない。**`noArb` は有効アダプタの state（= `MARKET_LEGS`）しか
  読まないので構造的に対象外で、`test/agentCreatedMarkets.test.ts` がその境界を検査する。
  帰結: **罠を仕掛ける者は他のエージェントからしか収穫できない**
- **参加者製コードを実行する read は gas 上限付き**（issue #213。`sdk/src/untrustedRead.ts` が単一の出典、
  `UNTRUSTED_READ_GAS` = 200,000 = `SimpleLending.EXTERNAL_CALL_GAS` と同じ値で `test/untrustedRead.test.ts`
  が一致を検査）。対象は lending 市場の oracle `price()` / `owner()`（観測・採点・清算の approve 見積り）、
  registry エントリの `owner()`、coordinator の ERC-20 判定（`name`/`symbol`/`decimals`）、launch token の
  `balanceOf` と QuoterV2 経由の見積り（pool の swap 内で token の `transfer` が走る。こちらは
  `UNTRUSTED_SIMULATION_GAS` = 2M）。**`gas` を付けないと `eth_call` はブロックガスリミット（30M）で走る**ので、
  ループするコントラクト 1 つで読む側全員が毎ブロック巻き込まれる（実測 anvil 1.7.1: keccak ループ 1 回
  ~280ms → 上限付き ~3ms）。**Multicall3 には入れない** — aggregate は内側の CALL に残りの 63/64 を渡すので、
  1 つの罠が同じ batch の後続（正直な oracle）まで欠落させる。1 アドレス 1 `eth_call`（transport の JSON-RPC
  batching で 1 HTTP）+ batch ごとの期限 `UNTRUSTED_READ_TIMEOUT_MS` = 1 秒。**読めなかった値は欠落**
  （`price` / `oracleOwner` が無い。0 ではない = 0 価格は全借り手を清算可能に、0 owner は「誰も動かせない」に読める）。
  coordinator は答えなかったアドレスを `unknown` として登録し `agent_market_read_failed`（out-of-gas / timeout /
  error。revert は「token でない」の通常回答なので出さない）を**アドレスごとに 1 回**出す。ただし timeout / error は
  ノードが答えなかっただけでコントラクトの答えではないので、**次の sweep で再判定**し（`CLASSIFY_ATTEMPTS` = 3 回まで。
  `seen` にはまだ入れない）、1 sweep の判定は `MAX_CLASSIFY_PER_SWEEP` = 64 件まで（残りは繰り越し。期限は batch 全体で
  1 つなので、CREATE を大量に積んだブロックで同じブロックの正直な token まで `unknown` に固定されていた）。singleton 経由の
  `isHealthy` / `expectedPosition` はコントラクト側の staticcall 上限で既に守られているので multicall のまま
- 参照 agent は 6 体: `market-launcher`（正直な作成者。immutable オラクルで作って鐘の前に withdraw）/
  `market-taker`（利用者。`oracleOwner` を読んでから入る）/ `trap-launcher`（自分が握るオラクルで
  90% LLTV の市場を作り、供給された分を借り出す）/ **`vault-keeper`**（正直だがバグ持ちの作成者。
  `rescue()` を gate し忘れた `LeakyVault` を deploy して USDC を入れる）/ **`exploit-hunter`**
  （Hacker。他人の `unknown` コントラクトのバイトコードから selector を復元し、`Exploiter` 経由で
  atomic に drain する）＋ `discovery-arb` / `discovery-arb-verify` を registry からも引くよう拡張。
  レジームは `config/regimes/agent-markets.yaml`（**公式セット外**。`lst`/`liquity` と同じ venue 単体
  検証用）。**hunter は「honest but buggy」を狙う**（trap-launcher の敵対コントラクトではなく）。
  実測: hunter +9,999.9 / vault-keeper −10,000.2 の移転（10,000 USDC の預けを丸ごと。sum ≈ ガス）
- **公式セットは 7 本のまま。**8 本目にするかは live run を見てから（→ その後 `vuln` / `spike` / `depeg-persist` /
  `cdp-incident` / `launch` が入って 12 本。上の「公式レジーム」）

### 新規トークンの上場（`launch` レジーム = `tokenLaunch` イベント。issue #29。**ローカルデプロイ + `agentMarkets.enabled` 必須**）

#40 の上に載る。環境が窓の開始ブロックで **2〜3 の新 ERC-20 を自分の Uniswap V3 factory 経由で上場**
（`AgentERC20` を deploy → NPM へ approve → `createAndInitializePoolIfNecessary` を 1.00 USDC で → full-range
mint。**1 鍵から nonce 連番の 5 tx を 1 ブロックに積む**。approve は存在しないトークン宛に署名するので
gas は全部 pin する = `eth_estimateGas` は今の state で失敗する）。翌ブロックにレジストリへ `uniswapV3Pool` +
`erc20`（`creator` = launch wallet。隠さない = 決定 3「常に正直」）。

- **需要はトークンごとに独立に引く**（`core/src/realtime/events.ts` の `drawTokenLaunches`）: 本数 1 回 +
  トークンあたり固定 5 回（liquidityUsdc / dudProb / dud の目 / waveUsdcMult / sellBackFrac）で、**dud でも
  waveUsdcMult を引く**ので RNG 消費が事象列の純関数のまま。dud は **0 の質量**（`dudDraw < dudProb`）。
  連続分布の下端 0 は 0 に当たらない
- **目標は累積で毎ブロック reconcile**（`tokenLaunchTargetsAt`）: 買いは ramp で 0→1 に上がって以後 1 のまま
  （波は買い戻さない）、売り戻しは decay で 0→sellBackFrac に上がって以後そのまま。**ramp は窓の開始から
  `TOKEN_LAUNCH_LEAD_BLOCKS`（= 2、上場 tx の着弾 1 + レジストリ公開 1）だけ遅れて始まる**。5 seed の受け入れ
  （2026-09-13）で、窓の先頭から数えていた頃は波の初手がプールが live になった同じブロックに 2 段分まとめて
  落ち（+32%〜+100%）、agent が見る前に板が動いていた。**レンジも較正済み**: `waveUsdcMult` [0.25, 1.0]・
  ramp 20 ブロック（issue の提案 [0.5, 2] / 9 ブロックでは 1 ブロックに片側の 2/9 が入り、10% slippage の
  買いが全部 `Too little received` で revert した）。1 ブロックの上げ幅は最大で片側の 1/20 ≈ +10%。driver は
  `core/src/realtime/tokenLaunch.ts`。wave wallet は USDC → token を SwapRouter `exactInputSingle` で、
  QuoterV2 の見積もりに 15% の slippage 枠。**settled した tx から集計**（`grossBuyUsdc` / `tokensSold` /
  `sellUsdcReceived`）し、`stress_token_launch_summary` で帳簿を閉じる
- **wallet は launch / wave をトークンごとに 1 つずつ** flow map に載せる（`launch:<e>:<i>` /
  `launch-wave:<e>:<i>`。whale と同じく funding ループの後に正確な額を入れ直す = launch は USDC 片側ちょうど、
  wave は倍率分、dud は 0）。blocks.csv では role `uninformed-flow`・ownerId `flow-launch…`
- **評価は ADR 0022 公理 2 のまま**: 鐘の時点のトークン残高は全員 0（`erc20-unaccounted`）。通り抜けた USDC
  だけが数える。**環境側の teardown は無い**（プールは snapshot revert で消え、残りは採点外の flow wallet）
- 参加者側は `example/agents/lib/launchSwap.ts`（USDC と未価格トークンの registry プール抽出 / slot0 価格 /
  Swap ログの純フロー / QuoterV2 / **exact approve + exactInputSingle の rawBundle**。登録 `swap` action は
  market set の外に届かない）。参照 agent は `launch-sniper`（見た瞬間に買い固定ホールド）と
  `launch-confirm`（連続 N ブロックの純買いで入り純売りで出る）。`full-field.yaml` に frozen で入っている
  （vuln の教訓: 読める agent が居ない regime は何も測れない）。**`launchPools` は環境の上場の形をしたプールだけ返す**
  （issue #216 (4)。以前は USDC × 未登録トークンの registry プールを全部返し、参加者が自作プールを置けば frozen の
  参照 agent 2 体が買って μ/σ が動いた）: トークン自身の `erc20` エントリがあり、プール作成者がそのトークンを
  deploy し、登録後にコードが動いておらず、`launchTokenCodehash`（repo の `AgentERC20` artifact を `to` 無しの
  `eth_call` で走らせた runtime code の keccak。artifact が無ければ null = 形だけで判定し agent ログに 1 回残す）
  が取れていれば codehash も一致するもの。launch wallet のアドレスは観測にもマニフェストにも無い（seed 由来で、
  公開すると窓の前に上場数が漏れる）ので作成者照合はできない。**同じ bytecode を同じ鍵から deploy した参加者の
  プールは通る**（固定供給・owner 無しの同種トークンで、リスクは価格だけ = 戦略の判断に委ねる）
- **実測（seed 101, 2026-09-12, main + PR #81 の burst 吸収を手元適用）**は PR #29 の本文。**main の anvil backlog
  burst（PR #81 で修正中）がある環境では最初の ~200 ブロックが 1 秒で流れて窓ごと飛ぶ**。この regime だけの
  問題ではなく windowFrac を持つ全イベントが同じ目に遭う

### 市場価格 stable（レジストリの stable を $1 断定でなく市場から値付ける。issue #27）

**「stable = $1」はコードがそう書いていたから**だった。`chain.ts` が active stable を全部足して
`usdcUnits` 1 本に潰し、`valuation.ts` が `kind === "stable"` を無条件に 1 と値付けていたので、
デペグした stable も par で採点されていた（#39 が eUSD をレジストリの**外**に置いて避けていた
phantom value そのもの）。issue #27 でこれを 3 段階で外した:

1. **観測に内訳を出す** — `obs.balances.stables[<symbol>] = {token, decimals, balance, priceUsdc,
   marketQuoted}`。`marketQuoted: false` は「市場が答えなかったので par を仮置きした」で、
   **`priceUsdc: 1` を「ペグが保たれている」と読んではいけない**
2. **`usdcUnits` を native USDC だけに narrow** — 9 箇所の参加者向け用途は全部**予算**であって評価では
   ない（評価は `inventory.valueUsdc`）。合計値は予算として元々間違っていた（USDT は USDC プールで
   使えないし、funding は stable ごとに同額を配るので実際に使える額の約 2 倍を表示していた）
3. **market から値付ける**（`sdk/src/stables.ts`）— **両側の executable probe の幾何平均**
   `sqrt(sell × buy)`（片側だけだと売り側に張り付いて過小評価する。LST / Liquity と同じ規律）。
   両側とも固定 notional なので**1 stage で済み**、採点断面の 1 multicall に相乗りできる。
   quote が返らなければ **par に落として `par-fallback` で報告**（黙って par が最悪、黙って 0 は
   「100% ディスカウント = 無限の裁定」に読めてもっと悪い）
4. **採点は自分サイズで売った額**（規約 §4.1 の「実効価格」を保有量で測る）— probe は $1,000 の取引なので、
   mid × 枚数だと薄いプールで買い占めて持ち続けた stable が売れない値段で数えられた（100k/100k・A=100 の DAI
   プールに 70k USDC で probe 1.05、69,090 DAI が mid で 72,532・売れば 69,986。DAI は配られず背景フローも
   取引しないので売り戻す人がおらず、5 ブロック中央値も効かない）。scorer（`ownSizeStableAdjustments`）が
   agent ごとに財布 + 各 venue が申告した枚数（`AgentProtocolValue.stableLongs` / `stableShorts` = Uniswap・
   Balancer・Curve の stable 脚、SimpleLending の供給・担保と債務、Liquity の SP 預入）を合算し、get_dy（債務は
   get_dx）の窓中央値で評価し直す。face mark（`markedValueUsdc`）は mid のまま。quote が返らなければ mid の
   まま `mid-fallback` で報告。Liquity の Trove 債務は従来どおりアダプタ自身の get_dx

- **USDC は numéraire で $1 固定**（issue #27 "Settled"）。全 metric が USDC 建てなので、ここを
  浮かせると過去 run の数字の意味が変わる。`marketPricedStables()` は USDC の leg を無視する
- **market を持つ stable は funding で配らない**（`fundWallet` は par stable にだけ配る）。cheatcode で
  eUSD を湧かせるのは Trove が発行していない stablecoin を流通させることだし、これから割れる stable を
  全員に配ると損が「誰も選んでいないポジションの β」になる。**買って初めて持てる**のがこの regime の要
- **α でも live mark**（base の fair と違い、peg の乖離は protocol が強制する価格に対する dislocation で、
  それを閉じるのが venue の存在理由。固定参照で評価すると測りたいものが打ち消える）
- `STABLE_MARKET_LEGS`（`sdk/src/constants.ts`）が「どの stable がどのプールで値付くか」の単一ソース。
  leg は `venue` を持ち、**その protocol が有効な run にだけ**その stable が入る（sweep されるが取引
  できない stable は無い方がまし）。eUSD → `liquity` / DAI → `curve`
- **eUSD はレジストリに昇格**（(b)）。#39 が外していた理由（レジストリが stable を par で値付ける）は
  消えたので、**価格の所有権を移した**（二重計上の回避 = `TokenKind: "lst"` と同じ論点）。
  liquity アダプタは spot eUSD 残高を**もう値付けない**（scorer の spot sweep が値付ける）。Trove の
  債務と Stability Pool 預入は venue のものとして残り、価格は `ctx.stablePrices()` から読む
- **DAI が 2 つ目の市場価格 stable**（(c)）。deployer の USDC/DAI stableswap-ng plain pool（100k/100k）を
  使う。**A は 2000 → 100**（#39 と同じ較正: A=2000 だと半分売っても 4.4bps しか動かず、永久に
  コストを超えない）。eUSD と違い**償還フロアが無い**ので、ディスカウントは「戻ると信じるかどうか」で
  あって行使できる請求権ではない = 別のスキル
- **`stableSwap` action**（curve アダプタ所有。プールが Curve stableswap-ng だから）—
  `{type, stable, tokenIn, amountIn, slippageBps?}`。無いとデペグは「見えるだけ」になる
  （#39 が `liquitySwapEusd` を足したのと同じ理由）。発注上限の撤廃前は、この上限が USDC の 6 decimals 建て
  だったため 18 decimals の stable で換算漏れを起こし、sell だけ毎回 reject されて「閉じられないポジションの
  含み益」になっていた（42 reject / 6 accept）。上限そのものが無くなったのでこの罠は消えた
- **`depeg` ストレスイベント**（`stress.events`。`stable:` 必須）— 環境が窓の間だけその stable を
  プールへ売り、閉じたら買い戻す。機構は `core/src/realtime/stableDepeg.ts` に共通化してあり、
  `eusdDepeg` も同じ実装を通る（イベント名は #39 の `stress_eusd_depeg*` のまま。他の stable は
  `stress_depeg*` + payload の `stable`）。**毎ブロック目標へ reconcile**（一撃だと dropped block で
  取り残される）で、売却量はチェーンから読み直す（revert しても窓がずれない）
- Aave の aggregator にも伝播する（`sdk/src/protocols/oracles.ts`。3 経路すべて）。ただし
  **今どの market-priced stable も Aave reserve ではない**ので現状は no-op で、listing した日に効く
- レジームは `config/regimes/depeg.yaml`（公式セット入り = ADR 0017 の 7 本目）、参照 agent は
  `example/agents/peg-arb/`。実測（seed 701）: 環境が depth の 59% を売って最大 89.5bps のディスカウント、
  peg-arb +139.6 / peg-arb-eager +195.7 / noop 0。**買い手が反対側を取ったぶん、環境が買い戻すと
  プールは stable 不足になって par を超える**（裁定側が解消できていれば −6bps 程度で収まるが、
  解消できないと大きく行き過ぎる。上限バグで sell が全 reject された run では −143bps まで振れ、
  「閉じられないポジションの含み益」が +439 と表示された）

実時間化（ADR 0005）の前提: **SEED(=regime) は市場条件のラベル**で価格パスは再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも結果はぶれる。run 長は `ERIS_RUN_BLOCKS` 固定で揃える。run の比較が要るときは同一 config を複数回回してサンプルを貯め、`runs/<id>/summary.json` を集計する（旧 evaluate/gate は撤去済み）。

**seed から Rng を作るのは `Rng.fromSeed(seed, salt)`**（`sdk/src/rng.ts`。消費者ごとに salt: 価格 `price:<symbol>` / flow / prewarm / LST / vuln / stress）。**ADR 0027 でこれは鍵付きストリーム**（HMAC-SHA256(K, seed ‖ salt ‖ counter)）になり、**seed はシナリオの名前、K が realization を決める**。K は公開セットでは公開鍵 `SHA-256("eris-public-v1")`（`PUBLIC_SCENARIO_KEY_HEX`）、ライブ週と練習期間は運営の秘密鍵（`core/src/scenarioKey.ts`。鍵ファイル `{scenarioKey: <64 hex>}`、`npm run competition -- keygen <out>` で生成、コミットメントは `competition commit` と同じ値）。渡し方は `npm run backtest -- --scenario-key <file|public>` か `ERIS_SCENARIO_KEY_FILE`、無ければ公開鍵。**順序付きプラン（ライブ週の形）は鍵の指定が無いと起動しない**。coordinator は flow bot にパスとコミットメントを渡し（不一致なら flow bot は exit）、agent には渡さない。`run_started_realtime` と `matrix.json` に `scenarioKey: {source, commitment}` が載り、`--resume` は鍵が違う・記録の無い matrix を拒否する。`new Rng(x)`（LCG）はシナリオと無関係な用途（agent の `ctx.rng`・actor のサイズ）専用。#150 以前の `new Rng(seed)` は近い seed が近い乱数列を引いていた（`scripts/measureSeedCorrelation.ts`）。**2026-09-28 以前の run とは同じ seed でも realization が違う**。**issue #186 でもう一度変わった**: ストリーム ID にレジーム名が入り（同じ seed でも calm と crash は別の世界）、抽選も各レジーム等回数から i.i.d. に変わった。`matrix.json` / `run_started_realtime` の `scenarioStreams`（`regime-v1`）が版で、`--resume` は版の無い・違う matrix を拒否する。レジーム名は書き方（`calm` / `config/regimes/calm.yaml`）によらず basename に正規化する

## アーキテクチャ（環境とエージェント実行の分離。ADR 0006 / ADR 0015）

```
環境プロセス（core/src/realtime/coordinator.ts = 環境デーモン + 採点者）   agent プロセス × N（完全独立）
  ・anvil ライフサイクル（fork/setup/採掘）                           ・spawn は一律 example/agents/runtime/bot.ts
  ・fair price 生成(Rng(seed)) → PriceFeed/oracle 更新 tx を毎ブロック書込   （agent ディレクトリは env ERIS_AGENT_DIR）
  ・flow bot 注文の relay 送信（市場を動かす）                        ・env で受領: RPC URL / 自分の秘密鍵 /
  ・GMX keeper（注文執行）                                             PriceFeed アドレス / runId・ログ出力先
  ・採点: run 後に歴史ブロック読取で価値系列を一括再構成               ・runtime/read.ts が毎ブロック観測を再構成
         └──────────── 同じ mempool。ブロック内順序は anvil --order fees ・runtime/send.ts が署名・直接送信（nonce 自己管理）
```

- **fair price はオンチェーン配布**（`contracts/PriceFeed.sol`。読取は `sdk/src/priceFeed.ts`、書込は
  `core/src/realtime/priceFeed.ts`）。書込 tx は次ブロック着弾なので情報は 1 ブロック遅れる（全員等しく作用。仕様）。
  **全 base の開始 fair は setup で feed に載せる**（issue #94）。constructor は WETH だけで、WBTC は最初の
  oracle tx（= 最初の境界の 1 ブロック後）で初めて載っていたので、V_0 が全員 WBTC 分（バスケットで 24k）短く
  noop の `netPnlUsdc` が 0 にならなかった。`ctx.fairPrices` も同じ場所で確定するので whale endowment /
  `initial_endowment` / Aave の WBTC aggregator 較正も全 base を見る。OU の walk はその値から始まる
- **エポックの時計は場が揃うまで待つ**（issue #94 / #91 F5。`core/src/realtime/agentsReady.ts`）。automine を
  切った後・interval mining の前に、起動した全 agent の `runtime_start` を `run.agentsReadyTimeoutSec`
  （既定 60 秒、0 = 待たない）まで待ち `agents_ready` に ready/late/exited を残す。実測 docker 32 体で
  `runtime_start` は +86〜99 秒なので、その検証では上げる。外部参加者は待たない
- **エポックはチェーンのブロック番号で終わる**（`core/src/epochExtent.ts`）。終わりは
  `runStartBlock + runBlocks` で、そのブロックは処理され、**最後の境界（V_K）**になり、全 agent の
  `blocksRemaining` が 0 になる（鐘）。ループの各パスはこのブロックで clamp され（`loopStep`）、
  それを越えて評価・スケジュール・観測しない。360 ブロックなら 30 評価区間。`runBlocks` が区間長の倍数で
  なければ格子は保ち、最終区間は端数（終わりのブロックが閉じる）。**以前はループのパス数で終わっていた**ので、
  追いつきパス（`round_timing.blocksCaughtUp`）のある負荷の高いホストでは chain が鐘の 72 ブロック後まで
  走り（crash#101: 360 パスで 432 ブロック）、遅れなくても最後の境界は +348 で 29 区間しか採点していなかった。
  **採点窓は 348 → 360 ブロックに伸びたので、それ以前の run の P とは比較できない**。
  summary.json の `blocksProcessed` はチェーンブロック数（`finalBlock − runStartBlock`）、パス数は `loopIterations`
- **採点は run 後再構成**（`core/src/realtime/reconstruct.ts`）: blockNumber 指定の Multicall3 で全 agent 同一断面の
  価値系列を events.jsonl に observation 形で書く（`runs/<id>/summary.json` に集計）。
  resetFork で歴史が消えるため**次 run の前に必ず再構成を終える**（anvil の保持深度 ~1,050 ブロックに注意）。
- **ルール執行は事後検出**（`core/src/postRunCheck.ts`）: blocks.csv（fee はチェーン上の tx フィールド由来）から
  fee 上限超過を検査し違反 run を `violations` に記録。入口側は `npm run check:strategy`
  （cheatcode 静的検査）で戦略コードを通す。**静的検査は行単位の正規表現で、実行時に組み立てた名前
  （`["anvil","setBalance"].join("_")`）は通る**（issue #216 (5)。`scan-submission.py` も同じ）。入口は入口で、
  組み立てた名前は読取専用クライアントとゲートウェイが送信時に拒み、事後監査が blocks.csv で読む。
  `findAssembledCheatcodeHints` が組み立ての安い形（namespace だけの文字列・リテラルでない `method:`・
  文字コード）を **hint / WARN として報告するだけ**で、網羅は主張しない（`"anv" + "il_…"` は見えない）
- **登録アドレス間の価値移転も事後検出**（issue #208 / 規約 §8。`core/src/rosterTransfers.ts` が純粋ロジック、
  `core/src/realtime/rosterTransferScan.ts` がチェーン読取）。`rawTx` は `to` も `value` も任意なので取引経路では
  塞がず、run 後に blocks.csv の **`to` / `valueWei` 列**（末尾に追加。tx 自身のフィールド）で ETH、run 窓の
  Transfer ログで ERC-20、レジストリの**参加者が作った**エントリと SimpleLending の position イベントで
  「同じコントラクト / 同じ貸出市場で対向した」経路（contract / lending / liquidation）を拾う。
  **同一 `participant` の 2 体は額に関係なく flag**、異参加者間は `run.rosterTransferFlagBps`（既定 100 = 対の
  小さい方の V_0 の 1%）超で flag。判定ではなく報告で **P は変えない**: summary.json の `rosterTransfers`
  （全件）と agent ごとの `rosterTransfers`（flag 分。両側に載る）、events.jsonl の `roster_value_transfers`、
  matrix.json の `flags`（`scenarioScores.ts`）に出る。**見えないもの**: コントラクト内部の ETH 移動
  （trace を取らない）、環境 venue を挟んだ対向（通常の取引）、履歴保持深度を超えた窓のログ経路
  （`roster_transfer_logs_skipped`。練習期間は最終セグメントだけ = 他の事後検査と同じ）。1 参加単位を
  1 母集団メンバーに畳むか σ をロバストにするかは規約側の未決（#186 / ADR 0023）
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

### agent が見るもの（`core/src/realtime/agentView.ts`）

coordinator は起動する agent ごとに `runs/<id>/agent-view/<agentId>/` を作り、`config.yaml`（agent 用 config）と
`run-start.json` を置く。**agent 用 config は allowlist**（`AGENT_CONFIG_FIELDS` = run 長・blockTime・venue・fee・LST 時計・
gas 予算など、ランタイムが読むフィールドを coordinator の解決済み値で）で、**seed・stress・flow・vuln・market・funding・
ロスターを含まない**。`ERIS_CONFIG` はこのファイルを指し、coordinator 自身の config（backtest の
`.effective-<regime>-<seed>.yaml`）は渡さない。名前に seed を持つ env（`ERIS_PRACTICE_SEED` 等）も子へ渡さない。
agent 側の `ctx.rng` は address 由来（run の seed ではない）。`SimConfig` にフィールドを足したら
`test/agentView.test.ts` がどちら側かを決めさせる。
- **docker の image モードで mount するのは view ディレクトリ（読取専用、`/eris/run` = `ERIS_RUN_DIR`）と自分のログ
  ファイルだけ**（`agents/<id>.jsonl`、`ERIS_IMPROVE_LOG_CALLS=1` なら `.llm.jsonl`、`disclosures/` 読取専用 = 全 run）。
  ログはファイル単位の bind mount なので、host 側は従来どおり `runs/<id>/agents/<id>.jsonl`（dashboard の live tail・
  agents-ready・post-run check は無変更）。ro mount の中の mountpoint は事前に要るので wrapper が空ファイルを作る
- **例外 2 つはディレクトリ mount のまま**: segmented period（segment が回るので期間ディレクトリ。警告に出る）と
  `ERIS_AGENT_VIEW_DIR` の無い起動
- **開始時に見えるものはレジームで変えない**（`test/regimeStartInvariance.test.ts`）。agent は最初の価格が動く前に
  config と env を読むので、レジームごとに違うものはレジームを名指す。以前は 4 本が開始時に分かった（registry の
  アドレス = launch / vuln factory = vuln / victim の一覧 = lending-incident・cdp-incident。後ろ 2 本は「暴落が来る」
  なので block 0 で USDC に替えれば勝てた）。さらに depeg と depeg-persist だけ `run.protocols` に gmx が無く、
  観測に GMX 節が無ければ depeg 系と分かった（このテストで発見して追加）。今は **公式 12 本すべて `agentMarkets.enabled: true`**、
  **vuln factory・その owner（`vuln-pools` 財布、全 run で同額のガス）・`disclosures/`・`ERIS_VULN_*` は全 run**（プールは窓で
  `createPool(initCode)` 1 本で deploy = ADR 0014 Amendment 2。以前は setup で全部 deploy し、作成 selector が正解を名指していた）。
  agent に渡す追加 env の形は `core/src/realtime/agentEnv.ts` が config から決め、coordinator は起動前に照合して違えば落ちる。
  **victim の一覧（`ERIS_LIQUIDATION_VICTIMS` / `ERIS_LIQUITY_VICTIMS`）だけは既知の例外**: env を消しても victim は block 0 から
  チェーン上に見える（Aave の HF 1.10 の借り手、`SortedTroves.getLast()` の ICR 1.20）ので、塞ぐには全レジームに victim を
  置く（デコイ）必要があり、レジームの意味が変わるので別に決める。もう 1 つの既知の穴は vuln プールのソースが公開 repo に
  あること（bytecode の骨格で照合できる）
- **bind-mount モードと `--agent-sandbox process` は隔離境界ではない**（repo / host のファイルが全部見える）
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
