[← README](../../README.md)

# バックテスト（regime 再生。ADR 0016）

参加者が自分の戦略を「歴史市場データ相当の条件で、安価に・何度でも」検証するためのモード。
配布された venue state dump をロードした**専用ローカル anvil**の上で、公式 regime
（`config/regimes/*.yaml` + seed）を既存の coordinator がそのまま再生する。約定は本物の
コントラクトが計算し（fill model 無し）、採点も realtime と完全同一（`summary.json` の
`mode: "backtest"` 以外は同形式）。fork も外部 RPC も不要。

```bash
npm run backtest -- --regime calm-01                       # 平常市場
npm run backtest -- --regime crash-01                      # crash + victim + Aave 清算
npm run backtest -- --regime calm-01 --repeat 5            # 同一 regime を 5 回（分布を見る）
npm run backtest -- --regime calm-01 --agents my-roster.yaml   # ロスター差し替え
```

## 前提

| もの | 入手 |
|---|---|
| anvil バイナリ | `foundryup` 一発 |
| state dump（`backtest/state/`） | 運営の配布物を置く。自分で作る場合は deployer でデプロイ済みの anvil に対して `npm run gen:state-dump`（下記） |

`gen:state-dump` は稼働中の deployer anvil（[ローカルデプロイ](local-deploy.md)）から
`.local-snapshot` のクリーン断面へ revert した上で state を dump し、`--load-state` 直渡し可能な
`venues-state.json` と manifest（生成元コミット・anvil バージョン・genesis hash・deployments.json
丸ごと同梱 + fingerprint）を書き出す。`sdk/src/constants.local.ts` も同じ deployments から再生成される。

## regime = 市場条件のラベル

regime は**既存 config スキーマの YAML + seed**（[設定](configuration.md)と同じ形式）。
fair price の OU パス・flow 注文・stress イベントのスケジュールは全て seed から決定論再生される。

- `config/regimes/calm-01.yaml` — 平常市場（ストレス無し）
- `config/regimes/crash-01.yaml` — 台形 crash（レンジ指定）+ 清算対象 victim 2 体 + liquidator ロスター枠

`blockTimeSec` は regime の一部（本番と同値に固定）。`--blocks` / `--seconds` 等の短縮 override は
挙動確認・スモーク専用で、**成績を読む run は regime 既定値で回す**こと（ADR 0016 §3）。
公開 regime の seed はレンジからのサンプル 1 例にすぎず、本番 run の seed は別サンプル（過学習対策）。

## 反復と再現性

- **環境（初期 state + 市場条件）は毎回完全に同一**: 起動ごとに同じ state dump から fresh anvil を
  作り、`--repeat N` の run 間は `evm_snapshot`/`evm_revert` でクリーン断面へ戻る（victim 残留なし）。
- **ぶれるのは tx の着順だけ**（本番 realtime と同じ性質。ADR 0005）。結果は狭い帯に収束するが
  ビット一致はしない。優劣は `--repeat N` の mean alphaUsdc で読む。
- ビット一致の回帰比較（コード 1 行の差分検証）は B2 同期ステップ再生として計画済み・未実装（ADR 0016 §3）。

## スパーリング（他 agent と競わせる）

ロスターに複数 agent を並べれば同一 run・同一 mempool で競争する。`--agents` で regime 既定の
ロスターを差し替えられる（YAML/JSON。中身は実効 regime に焼き込まれる）:

```yaml
# my-roster.yaml
agents:
  - id: noop
    wallet: AGENT1_PRIVATE_KEY
    baseline: true
  - id: my-strategy          # 自分の戦略（example/agents/my-strategy/）
    wallet: AGENT2_PRIVATE_KEY
  - id: multi-arb            # ライバル: 同梱戦略
    wallet: AGENT3_PRIVATE_KEY
  - id: multi-arb-2          # 同一戦略の複数体（機会の食い合いを見る）
    dir: multi-arb
    wallet: AUTO
```

## 測れる / 測れない（ADR 0016 §8）

| 測れる | 測れない（realtime / 本番でのみ） |
|---|---|
| 戦略ロジックの正しさ・回帰（クラッシュ / validate 違反 / noop 連発） | 本番参加者との競合（ロスターは既知戦略のスパーリングまで） |
| 自分の約定の市場インパクト込みの regime 別 α 傾向 | 本番ロスター密度での挙動 |
| prompt の挙動・自己改訂の傾向、フル tx 経路（署名・revert） | 本番 seed での成績（regime は同じでも seed は別サンプル） |

## CLI リファレンス

| フラグ | 説明 |
|---|---|
| `--regime <name\|path>` | `config/regimes/<name>.yaml`（または YAML パス）。必須 |
| `--agents <roster>` | ロスターファイル（YAML/JSON）で regime 既定の agents を差し替え |
| `--repeat <N>` | 同一 regime を N 回反復（既定 1）。完了後に mean alphaUsdc を表示 |
| `--port <N>` | backtest 専用 anvil のポート（既定 8547。並列は別ポートで） |
| `--state <dir>` | state dump ディレクトリ（既定 `backtest/state`） |
| `--keep-anvil` | 終了後も anvil を残す（receipt を読む事後解析・デバッグ用） |
| `--seed` / `--blocks` / `--seconds` / `--protocols` / `--economic-gas` | regime 値の一回限り上書き（スモーク用） |

> run の override は「実効 regime YAML」として書き出され、coordinator と agent プロセスの両方が
> 同じ設定を読む（coordinator だけに効かせると agent が観測で死ぬため）。

## トラブルシュート

- **`state manifest not found`** — `backtest/state/` に配布物を置くか `npm run gen:state-dump` で生成する。
- **`state dump に venue が足りません: gmx`** — dump 生成時のデプロイに GMX が無い。full deploy
  （`cd deployer && npm run deploy -- --keep-fresh`）から焼き直すか、`--protocols uniswap,balancer,curve,aave` で絞る。
- **`port 8547 は使用中`** — 別の backtest / anvil が居る。`--port` で変える（deployer anvil の 8545 は使わない）。
- **fingerprint 不一致のログ** — manifest 同梱の deployments から `constants.local.ts` を自動再生成して続行する（正常動作）。再生成しても一致しない場合のみ fail-fast（state dump と repo の版の組合せ違い）。
- **生成元コミットと HEAD が違う警告** — deployer / constants を変えていなければ無害。変えた場合は `npm run gen:state-dump` で焼き直す。
