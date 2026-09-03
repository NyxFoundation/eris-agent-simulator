[← 目次](README.md) ｜ [← 10 運用](10-operations.md) ｜ [12 既知の制約 →](12-open-issues.md)

# 11. 品質保証と不変条件

**「黙って落とさない」が全体の規律**（[00 §0.5 P4](00-overview.md)）。検査は 4 層に分かれる。

```
[入口]    提出コードの静的検査
[起動時]  較正・設定・デプロイの整合を実測して落とす
[実行中]  構造的な破綻を監視して報告する
[事後]    チェーンに残った事実から違反を検出する
```

## 11.1 起動時 fail-fast

**チェーンに触れる前、または agent プロセスを起動する前に throw する。** 出典は各行に記載。

### 設定の整合

| 条件 | 出典 |
|---|---|
| config ファイルが 1 つも見つからない | `core/src/runConfig.ts:180` |
| `run.resetUnit: scenario` を行列ランナー以外が宣言 | `coordinator.ts:405` |
| `run.resetUnit` の綴り間違い | `sdk/src/config.ts:42` |
| `run.chainMode` の綴り間違い | `sdk/src/config.ts:55` |
| `run.epochSeconds` と `run.epochBlocks` の両方指定 | `sdk/src/config.ts:576` |
| `economicGas` かつ `funding.ethWei < 0.5 ETH` | `coordinator.ts:479` |
| ロスターの検証（id 重複・ウォレット再利用・external の矛盾…） | `core/src/config.ts:99` |

### external チェーン（5 条件）

`coordinator.ts:426-456`。`TREASURY_PRIVATE_KEY` 無し / `localDeploy: false` / `economicGas: true` / `stressVictimCount > 0` / `prewarmBlocks > 0`。

さらに **scored token が誰でも mint できるなら落とす**（`assertTokensNotMintable`、`coordinator.ts:237`）。"cheatcode-free" は RPC の話だが、同じ穴が contract 側にあった（`MockERC20.mint` は permissionless だった）。**参加者が到達できるチェーンでは、mint できるトークンに対して計算したスコアは何の意味も持たない。**

### デプロイの実在

**`deployment_check`**（`core/src/realtime/deploymentCheck.ts`）が有効な venue のアドレスを実測し、無ければ**何が無いかと再生成コマンドを出して停止**する。

以前は setup の数分後に `Cannot decode zero data ("0x")` と生アドレスが出るだけだった。原因は [07 §7.6](07-configuration.md) の「2 軸」— チェーンとアドレス overlay が別の場所にあり、片方だけ動かすと不整合になる。

### venue の較正

| 検査 | 内容 |
|---|---|
| **`lst_setup`** | プールの rate oracle 配線。乖離 200bps 超で停止（未配線だとレート上昇が**全員に開かれた無リスク裁定**になる） |
| **`liquity_setup`** | オラクルアダプタの差し替えと drift 検証。Recovery Mode 開幕・デペグ済みチェーンで停止 |
| **`no_arb_startup`** | 実行可能な venue 間往復が `STARTUP_FAIL_BPS = 300` を超えたら停止（`STARTUP_WARN_BPS = 10` 超は警告） |

**no-arb の閾値の根拠**（`core/src/realtime/noArb.ts:27-31`）：setup 後の venue は fair の ±20bps 以内に較正され、どの venue も片側 30bps 以上を取る。よって**往復コスト 60bps 以上に対して実行可能な利益が正**なら疑わしく、300bps は明確に壊れている（split deploy の sort order 破壊は約 1000 倍の価格誤差を出した）。

### ストレスイベント

[04 §4.9](04-stress-events.md) の一覧。加えて coordinator 側で venue 有効性・fresh state・deployer 鍵衝突を検査する。

## 11.2 実行中の監視

| 監視 | 内容 |
|---|---|
| **`NoArbMonitor`** | 実行可能な裁定が `PERSIST_WARN_BPS = 50` を **`PERSIST_BLOCKS = 10` 連続ブロック**超えたら `no_arb_persistent_warning`。**一過性の裁定はエージェントが取るべき α、持続する裁定は構造的な破綻** |
| **`epoch_boundary_failed`** | 境界が読めなかったことを記録し、境界自体は**記録しない**（`null` で埋めない） |
| **`agent_process_exited`** | エージェントプロセスの異常終了。**途中で死んだエージェントは黙って取引をやめる**ので、これが無いと「動かないことを選んだ」と区別できない |
| **`initial_endowment`** | 最大/最小が 2 倍を超えたら警告。**2 倍は既に別の競技**（external では endowment が代入でなく下限になるため、prefund 済みアドレスがそのまま残る） |
| **`round_timing`** | 各段の所要時間。環境ループのボトルネック診断 |
| `stress_calibration_warning` | crash の magnitude が victim HF を割れない可能性 |
| 各タスクの `*_failed` | keeper / oracle / liquidity / depeg / vuln / liquity watch |

## 11.3 事後検査

### 手数料上限（`core/src/postRunCheck.ts`）

**direct 送信ではエージェントが事前検証を迂回できる**ので、ルール執行はチェーンに残った事実の機械的検査へ移す。

- `blocks.csv` の `role === "agent"` の行を走査し、`priorityFeeWei > maxPriorityFeeWei` を違反として記録する
- **手数料はオンチェーンの tx フィールド由来**なので改竄できない
- 上限超過は `--order fees` の順序を歪める市場歪曲行為なので、当該エージェントを記録すると同時に **run 自体を無効化する**
- `economicGas` プロファイルでは上限強制自体が退役しているので `violations` は空になり、`fee_cap_enforcement_disabled` を emit する

### 環境自身の revert（`countRunRevertedTxs`）

**環境の shock が黙って失敗してはならない。** whale は通常の relay を通るので**送信**エラーは捕捉されるが、**オンチェーンの revert はエラーではない** — tx は着弾し、イベントログは「whale が発火した」と言い、`blocks.csv` だけが何も起きなかったことを示す。approve 漏れで一度、この regime が全ログ健全なまま calm に退化した。

### live 採点と sweep の一致（`compareEpochSeries`）

両方が存在する run で必ず検査し、`epoch_series_agreement` に出す（`boundaries` / `compared` / `maxAbsDiffUsdc` / `maxRelDiff` / `worst`）。

**テストではなく run ごとの実測にしてある理由**（`coordinator.ts:176-178`）：両者を引き離しうるもの（「どのブロックか」ではなく「いつ読んだか」に依存する venue 状態）は、チェーン上でしか現れない。

## 11.4 入口ゲート

`npm run check:strategy`（cheatcode 静的検査、[05 §5.8](05-agent-contract.md)）と `npm run check:boundaries`（workspace 依存方向）。

LLM 生成コードは設置前に**同じ静的検査 + vm コンパイル + 2 秒の実行上限**を通る（[05 §5.7](05-agent-contract.md)）。

## 11.5 ユニットテスト

`test/` に 58 ファイル（`node --test`）。何を守っているかで分けると：

| 領域 | テスト |
|---|---|
| **契約の凍結** | `actionVocabulary`（アクションの改名・削除を検出）/ `actionSchema` / `action` / `methodNames`（selector テーブルと ABI のズレ） |
| **採点の正しさ** | `epochScore` / `epochBoundaries` / `scoringBlocks` / `metrics` / `aggregate` / `standings` / `markMedian` / `liveScoring` / `scoringExclusions` / `summaryMultiBaseValuation` / `lpValuation` / `poolShareValuation` / `unaccountedTokens` |
| **決定論** | `rng` / `events` / `flow` / `flowTrendCorrelation` / `whale` |
| **モードの整合** | `resetUnit` / `chainMode` / `segments` / `externalAgents` / `config` / `run-config` |
| **venue の挙動** | `liquity*` / `lst*` / `uniswap` / `balancerSeed` / `gmxMarketToken` / `stables` / `two-sided-quote` / `no-arb` / `tickMath` |
| **ストレス** | `liquidityPull` / `liquidityPullDepth` / `vulnEvents` / `fundingGasBuffer` |
| **ルール執行** | `postRunCheck` / `strategyStaticCheck` / `verifyContract` / `economicGas` |
| **エージェントランタイム** | `improve` / `runtimeLlmCli` / `agentLogAppender` / `agent-markets` |

一部は**ローカルデプロイ実チェーンを要求**する（`lstVault.integration` / `lstLeverage` / `vulnPools.integration`）。`ERIS_LOCAL_DEPLOY=1` とデプロイ済み anvil が無ければ skip する（CI では skip）。

### run の golden 回帰が無い理由

**run は非決定的**（[00 §0.5 P3](00-overview.md)）なので、run の出力を固定してリグレッションを取ることはできない。採点コードを触るときの順序が決まっている：

```
1. ユニットテストで現在の挙動を固定する
2. 挙動の修正を分割して入れる
3. リファクタは最後
```

## 11.6 検査の限界

**書いてあることは保証しない。以下は明示的に検出できない。**

| 限界 | 内容 |
|---|---|
| cheatcode 静的検査 | 正規表現によるソース検査。難読化や動的構築は抜ける。事後監査と対で使う |
| vm サンドボックス | **封じ込め境界ではない**。`ctx` を渡す以上、生成コードは手書き戦略と同じ自由度でチェーンを触れる |
| submitted-but-not-included | 外部参加者では**原理的に検証不能**（運営がプロセスを持たない） |
| `crash` / `spike` / `cexDrift` / `flowTrend` の発火記録 | 価格の walk 自体を変えるので毎ブロックの記録が残らない。「発火しなかった」とは言えない |
| クラッシュした run の `blocks.csv` | 通常 run では終了時に一括で書くので、途中でクラッシュすると空になる（診断は `events.jsonl`） |
| 事後 sweep | 窓が履歴保持深度（約 1,000 ブロック）を超えると**実行しない**。equity curve・α・`market.json` はその run では得られない |
