[← 目次](README.md) ｜ [← 09 ダッシュボード](09-dashboard.md) ｜ [11 品質保証 →](11-invariants.md)

# 10. 運用

## 10.1 コマンド一覧

出典 `package.json` の `scripts`。

### run を回す

| コマンド | 役割 |
|---|---|
| `npm run sim:realtime` | 実時間 run を 1 回。設定は `config/local.yaml`（`--config` で別ファイル、`--seed`/`--blocks`/`--protocols`/`--agents` 等で一回上書き） |
| `npm run anvil` | 別ターミナルで Anvil フォークを起動（fork モードの前提。ローカルデプロイでは不要） |
| `npm run backtest -- --regime <名> --seed <N>` | シナリオ 1 本を専用 anvil で再生 |
| `npm run backtest -- --scenarios <path>` | シナリオ行列を 1 つの anvil 上で全部再生し順位を出す |

### 生成物

| コマンド | 役割 |
|---|---|
| `npm run build:contracts` | PriceFeed + モックオラクルを forge build（`out/` 未生成なら最低 1 回） |
| `npm run gen:local-constants` | `deployments.json` → `sdk/src/constants.local.ts` |
| `npm run gen:state-dump` | 稼働中の deployer anvil から配布用 state dump + manifest |
| `npm run gen:method-selectors` | venue ABI から selector→関数名テーブル |
| `npm run manifest` | 環境マニフェスト（`--participant <id>` で個別の鍵を stdout に） |
| `npm run bundle:agent <id>` | 提出用 zip |

### 分析・観測

| コマンド | 役割 |
|---|---|
| `npm run metrics -- <runDir...>` | 保存済み run を全候補指標で採点し直す |
| `npm run metrics -- --matrix runs/matrix-<id>` | 行列を「指標 × 集約」の総当たりで採点し直す |
| `npm run dashboard` | 開発サーバー（:5173） |
| `npm run dashboard:build` / `dashboard:serve` | 運営 hosted ダッシュボード（:5174） |
| `npm run explorer` / `explorer:down` / `explorer:reset` / `explorer:tag` | ローカル Blockscout |

### 検査

| コマンド | 役割 |
|---|---|
| `npm run typecheck` / `npm run test` | 型チェック / ユニットテスト |
| `npm run check:strategy` | 戦略コードの cheatcode 静的検査（入口ゲート） |
| `npm run check:boundaries` | workspace 依存方向の検査 |
| `npm run check:ordering -- --live` | **ビルダーが手数料順に並べるかを自分で入札して測る** |
| `npm run stress:rpc` | Eris 形状の read 負荷で RPC 容量を測る |

## 10.2 ローカルデプロイのセットアップ

fork RPC のレイテンシを避けるため、**空の anvil に全 venue をデプロイする**のが既定経路。

```
初回のみ:
  cd deployer && npm install && forge build && cp .env.example .env && ./scripts/setup-vendors.sh

毎回:
  cd deployer && npm run deploy -- --keep-fresh   # anvil 起動 + 全 venue deploy（--exit は付けない）
  npm run gen:local-constants                      # deploy アドレスを取り込む
  npm run sim:realtime
```

| 注意 | 理由 |
|---|---|
| **焼き直すときは anvil ごと立て直す** | `--keep-fresh` が消すのは `deployments.json` だけ。全 venue の seed で deployer アカウントは 100 万 ETH のうち約 99.9 万を使うので、同じ anvil に 2 回目を流すと WETH の wrap で `insufficient funds` になる |
| **部分再デプロイ（`--only`）は使わない** | 共有トークンも作り直すので venue 間でアドレス不整合になる（症状：`WETH9 insufficient allowance`） |
| `vendor/` の重いクローン | git 管理外。`setup-vendors.sh` が再現する |

fork に戻すには `run.localDeploy: false` + `run.protocols` から `lst` / `liquity` を外す + `ARB_RPC_URL` + 別端末で `npm run anvil`。

## 10.3 backtest

### state dump

`npm run gen:state-dump` が稼働中の deployer anvil から配布用の state dump を `backtest/state/` へ書く（ADR 0016）。

- dump 前に `.local-snapshot` のクリーン断面へ revert し、**`constants.local.ts` も同じ deployments から再生成する**
- manifest には生成元コミット・deployments・fingerprint が入る
- `--load-state` は plain JSON のみ受け付ける

### 実行時の検証（`core/src/backtest/shared.ts`）

| 検査 | 不一致時 |
|---|---|
| deployments fingerprint | manifest 同梱の deployments から `constants.local.ts` を**自動再生成** |
| genesis | **fail-fast** |
| venue の欠落 | 何が足りないかを名指して停止（`--protocols` の案内付き） |

### CLI

```
npm run backtest -- (--regime <name|path> --seed <N> | --scenarios <path>) [options]
  --agents <roster>    regime 既定ロスターの差し替え
  --metric <name>      standings の指標（既定 netPnlUsdc）
  --repeat <N>         各シナリオを N 回（較正の診断用。standings は中央値）
  --port <N>           backtest 専用 anvil のポート（既定 8547）
  --state <dir>        state dump ディレクトリ
  --keep-anvil         終了後も anvil を残す
  --blocks/--seconds/--protocols/--economic-gas/--score-every
```

| 規則 | 内容 |
|---|---|
| **シナリオ = (regime, seed)** | regime YAML は seed を持たないので `--seed` は必須（ADR 0017 §1）。省略を「黙って既定 seed」にはしない |
| `--regime` と `--scenarios` は排他 | `--seed` は `--scenarios` に適用できない（セットが seed を供給する） |
| `--config` は使えない | backtest では **regime YAML that itself is the run config** |
| **override は実効 regime YAML に書き出される** | coordinator だけに効かせるとエージェントが観測で死ぬ。`--agents` のロスターも同様に伝播する |
| `--score-every N` | 採点断面の間引き。**スコアは不変**、equity curve が粗くなるだけ |

`--scenarios` は `{regimes, seeds}` の直積をシナリオ間 snapshot/revert で 1 つの anvil 上に再生し、`runs/matrix-<id>/matrix.json` と `standings.json` を書く（[08 §8.9](08-artifacts.md)）。

## 10.4 練習 devnet

ADR 0021。**止まらないチェーン + 自己ホスト参加者。**

### 公式採点ではない

公式競技は提出バンドル × シナリオ行列（ADR 0017 / 0020）で、**練習期間の結果は一切反映されない**。順位表は `resetUnit === "continuous"` を見て `practice` バッジを常設する。

> **「scenario でない」ではなく「continuous である」で判定する。** ADR 0020 以前の `matrix.json` は当該フィールドを持たず、あれは公式形だった。

### 運用の流れ

```
1. 外部チェーン（OP Stack devnet）を用意し、venue をデプロイする
2. .env.local に ANVIL_RPC_URL / CHAIN_ID / TREASURY_PRIVATE_KEY を置く
3. DEPLOYMENTS_JSON=<path> npm run gen:local-constants でアドレス overlay を切り替える
4. config/practice.yaml をもとにロスター（登録リスト）を作る
5. npm run sim:realtime -- --config config/practice.yaml --chain-mode external
6. npm run manifest で環境マニフェストを配る（鍵は --participant <id> で個別に stdout）
7. npm run dashboard:serve でダッシュボードをホストする
```

手順の詳細は `docs/guide/practice-devnet.md`。

### ロスターは登録リストであって起動リストではない

[05 §5.9](05-agent-contract.md) / [07 §7.5](07-configuration.md)。`external: true` + `address`（**運営が作った鍵は運営が持っている鍵**なので参加者が鍵を持つ方を推奨）。

### 諦めているもの

| 項目 | 理由 |
|---|---|
| **submitted-but-not-included** の追跡 | 運営が動かしていないエージェントでは元々検証不能 |
| 判断ログ | 参加者のマシンにしか無い |
| リセット | 練習場ではそれが設計 |

### 成果物は日次セグメント

`run.segmentHours`（[02 §2.5](02-runtime.md)）。チェーンは連続のまま、run ディレクトリだけを切る。

### hosted ダッシュボードの注意

**read-only だがアクセス境界ではない。** `runs/` 配下は全部公開になる（[09 §9.8](09-dashboard.md)）。

## 10.5 explorer（ローカル Blockscout）

`infra/blockscout/`。stock イメージを pin してある。UI は http://localhost:3100。

| 操作 | 内容 |
|---|---|
| `npm run explorer` | 起動 |
| **`npm run explorer:reset`** | **チェーンをリセットしたら必ず実行**。resetFork / snapshot-revert の巻き戻しに indexer は追従できないので、**DB を消して再索引するのが正規のライフサイクル** |
| `npm run explorer:tag` | 最新 run の `summary.json` からエージェントアドレスに名前タグを付ける（reset で消えるので run ごと） |

接続先・chain id・fork 用 `FIRST_BLOCK` は `infra/blockscout/explorer.env`。

## 10.6 順序と容量の実測

### `npm run check:ordering`

| 形態 | 内容 |
|---|---|
| 引数なし | `blocks.csv` の事後検査 |
| `--live` | **自分で入札して測る**（#35 の load-bearing assumption） |

既定プロファイルは oracle を全員より高く積んで txIndex 0 に置くので、**順序が守られないチェーンでは環境の価格が front-run 可能になる**。

**入札は昇順に送る**ので到着順と手数料順が逆になる。到着順を保つだけのビルダーは降順プローブなら通ってしまうが、この昇順プローブでは落ちる。

### `npm run stress:rpc`

`reconstruct.ts` と同じ read 集合の Multicall3 をエージェント × ブロックで撃ち、cold/warm 別の p50/p99・ブロック間隔ジッタ（負荷有無）・`eth_call` の到達可能深度・sequencer-only か replica かの判定を出す。

**読む対象が無いチェーンでは測る前に落ちる。** 空アドレスへの call はノードが実残高より速く断るので、全滅が巨大な容量に見える（実際に「何もデプロイされていない anvil に 3,360 obs/s・sequencer-only で十分」と報告した）。

## 10.7 spot EC2 で重い run を回す

ローカルの CPU / メモリが逼迫するときは golden AMI の spot EC2 に投げる。ローカルデプロイ前提（fork 不要）で自己完結し、外部依存は LLM（ollama）egress のみ。

- 全 protocol を deploy 済みの anvil state を AMI に焼いてあり、launch 時は `anvil --load-state` で全 5 venue を約 10 秒で復元 → install/deploy なしで run（起動約 3 分）
- 結果は SSH で回収（S3 / IAM ロール不要）
- AWS は `eris` profile 固定
- スクリプトは user-global の spot skills（`~/.claude/skills/spot-{run,bake,ops}/scripts/`）

| skill | 用途 |
|---|---|
| `/spot-run` | golden AMI で run を回して結果を回収（日常ドライバ） |
| `/spot-bake` | 新しい golden AMI を焼く（poc 依存追加 / deployer・constants 変更時）。約 35 分 |
| `/spot-ops` | 初回セットアップ（鍵 + SG + IAM）/ 状態確認 / 掃除 |

> **AMI の焼き直しが必要**：ADR 0015 の workspace 化で npm install の対象とパス前提が変わったため、次回 spot 利用時は `/spot-bake` が要る。
>
> **bake はスポットで走らせない**（バンドリング中に回収されて AMI ごと消える）。`ERIS_BAKE_MARKET=on-demand`。失敗しても exit 0 になるので、実体の確認が要る。

回収した run はダッシュボードでそのまま開ける（`runs/<回収ID>/runs/<runID>/` に展開され、index が 2 階層下まで走査する。[09 §9.8](09-dashboard.md)）。

## 10.8 撤去済みのコマンド

以下は存在しない。run 後の解析は `runs/<id>/` を直接読むか、`npm run metrics` / ダッシュボードを使う。

`sim`（同期ラウンド）/ `evaluate` / `gate` / `discrimination` / `leaderboard` / `stress-report`
