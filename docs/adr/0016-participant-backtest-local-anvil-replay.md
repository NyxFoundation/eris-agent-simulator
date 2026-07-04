# ADR 0016: participant 向けバックテスト（ローカル anvil での regime 再生）

## Status

Proposed

## Context

本 repo は Anvil で Arbitrum をフォーク（またはローカルデプロイ）する DeFi トレード競争シミュレータであり、
ADR 0015 により core（環境デーモン + 採点）/ sdk（契約レイヤ）/ example（参加者テンプレート）の
3 workspace に分離済みである。run は `sim:realtime` 一本で、参加者が自分の戦略
（`decide()` / `run(ctx)` / prompt.md）を検証する手段も同じ realtime run しかない。

realtime run は検証手段としては重い: fork モードは backend RPC が律速し、ブロック時間 2 秒の実時間で
しか進まず、結果には tx タイミング/着順の非決定性が混ざる（ADR 0005）。参加者が欲しいのは
「歴史市場データに対して自分の戦略を繰り返し・時系列で走らせ、realtime と同じ尺度の成績を得る」
バックテスト体験である。

一方、コードベースには次の資産が既に存在する:

1. **ローカルデプロイモードが完成済み**。fork なしで全 5 venue（Uniswap/Balancer/Curve/GMX/Aave）が
   動作し、fork RPC レイテンシは存在しない。`resetFork` はローカルでは `evm_snapshot`/`evm_revert` として
   動作し、run 間の状態残留（Aave ポジション汚染）対策として検証済み
2. **anvil state dump の復元が実証済み**。spot runner の golden AMI は全 venue デプロイ済み state を
   `anvil --load-state` で約 10 秒で復元している。state ファイルを配布すれば参加者側に
   deployer / forge / vendor clone は不要になる
3. **市場生成は seed 決定論**。fair price の OU 過程（`sdk/src/rng.ts`）、stress オーバーレイ
   （`core/src/realtime/events.ts`）、flow 注文生成（`core/src/flow/logic.ts`）は seed から決定論再生できる。
   「regime = config + seed」というラベルは ADR 0005 で確立済み
4. **agent 契約は transport 非依存**だが、sdk の AMM 約定数理（swap 見積り）は 3 AMM とも
   quoter/query の eth_call 依存であり、純粋 TS の約定計算は存在しない

### 解決したい課題

- 参加者が戦略変更のたびに fork + 実時間 run を回さずに、手元で安価に挙動確認・回帰テストできるようにしたい
- **同じ環境（初期状態 + 市場条件）で何回でも反復実行**でき、時系列（walk-forward）でテストできるようにしたい
- regime（calm / spike / crash 等）別の市場シナリオを配布し、提出前に多様な条件で自己検証させたい
- 採点の正は realtime のまま、バックテストの数字が realtime と同じ意味（alphaUsdc）を持つようにしたい

### 検討した選択肢

**軸 1: 約定の再現方式**

| 観点 | A. anvil-free tape replay + fill model | B. ローカル anvil 再生（本物のコントラクト） |
|------|----------------------------------------|---------------------------------------------|
| 約定の忠実度 | fill model の近似。v3 tick 跨ぎ・LP fee 積算・StableSwap・GMX keeper・Aave 清算を自前再実装し、realtime との乖離を恒久的に較正 | 厳密（EVM がそのまま計算）。較正負債ゼロ |
| 実装コスト | 大（tape スキーマ + 記録 + エンジン + 台帳 + fill model + agentKernel 抽出） | 小（regime config + CLI + state 配布。agent 契約無改修） |
| 速度 | 秒単位 | blockTimeSec 短縮・ステップ駆動で実時間の数倍〜 |
| 決定論 | 完全（同一データで paired 比較可） | 駆動方式による（軸 2） |
| 自分の約定の市場インパクト | なし（開ループ） | あり（閉ループ） |
| 対応 agent | decide / prompt のみ（RPC 直叩き run(ctx)・自前 command は不可） | 全種別（本物の環境なので制限なし） |
| 提出ゲートの検査範囲 | decide ロジックのみ（send.ts/署名経路を素通り） | フルランタイム（署名・nonce・revert 含む） |
| 参加者セットアップ | npm のみ | anvil バイナリ + state ファイル |

A の固有価値は「全く同一の市場データに対する戦略 2 バージョンの paired 比較」と「過去の公式 run
（他 agent の行動込み）の追体験」だが、前者は開ループ（自分の約定が市場を動かさない）という嘘と
表裏一体で rule agent にしか効かず、後者は練習・検証用途には regime 再生で足りる。
全 venue 対応を要件とした時点で A の再実装コストと較正負債が支配的になる。

**軸 2: anvil 再生の駆動方式**

| 観点 | B1. 実時間再生（interval mining） | B2. 同期ステップ再生（ターン制 mine） |
|------|----------------------------------|--------------------------------------|
| 実装 | 既存 sim:realtime そのまま | mine トリガー + bot.ts の判断完了通知（stdout 同期プロトコル）の追加 |
| 再現性 | 統計的（tx タイミング非決定。ADR 0005 と同性質） | ブロック駆動 rule agent なら実質ビット再現（LLM の非決定性のみ残る） |
| 速度 | blockTimeSec 短縮で数倍 | 壁時計非依存で最速 |
| 向く用途 | 同一 regime を N 回回す統計評価・最終確認 | 回帰テスト・戦略 v1 vs v2 の paired 比較 |

**軸 3: 市場シナリオの配布形態**

| 観点 | tape（market.jsonl を記録・配布） | regime config + seed + state dump |
|------|----------------------------------|-----------------------------------|
| 配布物 | run ごとの記録ファイル（サイズ大） | YAML 数本 + state ファイル 1 つ |
| core への変更 | 毎ブロック記録の追加 | なし（既存の決定論生成をそのまま使う） |
| 再現の範囲 | 記録した特定 run の価格パス | 同一 regime の市場条件（パスは閉ループで分岐） |
| 過学習リスク管理 | 非公開 tape の温存 | 非公開 regime（seed）の温存。本番 seed は別サンプル |

## Decision

**参加者バックテストは、配布された venue state dump をロードしたローカル anvil の上で、
公式 regime ライブラリ（config + seed）を再生する方式とする。約定は本物のコントラクトが計算し
（fill model は持たない）、実時間再生（B1）を本線に、回帰テスト・paired 比較用の
同期ステップ再生（B2）を追加する。**

軸 1 は B、軸 2 は B1 + B2 の両建て、軸 3 は regime config + state dump を採用する。
バックテストが本番より甘く出て参加者を裏切らないことを最重要とし、約定忠実度を近似（fill model）で
妥協しない。ADR 0015 §8 の再検討トリガー（anvil を介さない専用エンジンの追加）は本検討で発火を
見送った — 参加者バックテスト用途では anvil 維持が優る。トリガー自体は RL 学習等の
大量オフラインシミュレーション向けに残置する。

### 1. 全体構成

```
運営側（配布物の生成）                          参加者側（手元・fork 不要・外部 RPC 不要）
──────────────────                            ──────────────────
deployer で全 venue をローカルデプロイ           anvil --load-state venues-state.json   （~10 秒で全 venue 復元）
→ anvil state dump（venues-state.json）         npm run backtest -- --regime crash-01 --agents my-arb
→ regime config（config/regimes/*.yaml）              │
        │                                             ├─ coordinator が regime config で市場を再生
        └── 公式 regime ライブラリとして配布 ──────────┤   （fair OU + flow + stress。全て seed 決定論）
            （calm / trend / spike / crash / …）       ├─ agent は runtime/bot.ts で無改修駆動
                                                      └─ 採点・出力は realtime と同一（summary.json 等）
```

- 新規コードは **backtest CLI（薄いラッパ）+ B2 ステップモード（coordinator の mine トリガー +
  runtime/bot.ts の判断完了通知）+ state dump 生成スクリプト**。参加者が書く agent 契約
  （decide / run(ctx) / prompt.md）は一切変えない。依存方向 `example → sdk ← core` にも変更なし
  （参加者は core を実行するが編集はしない。従来の sim:realtime と同じ関係）
- 参加者の前提は anvil バイナリ（foundryup 一発）と state ファイルのみ。deployer / forge / vendor clone /
  外部 RPC（`ARB_RPC_URL`）は一切不要

### 2. 公式 regime ライブラリ

- regime = **既存 config スキーマ（ADR 0013 の YAML）そのもの** + seed。`config/regimes/*.yaml` として
  repo に数本同梱する（calm / trend / spike / crash /（将来）vuln）
- stress イベントはレンジ指定（ADR 0009）のまま入れ、seed がレンジから値をサンプルする —
  「regime は市場条件のラベル」（ADR 0005）の思想を維持する
- **検査用の非公開 regime（seed）を別途温存**し、本番 run の seed は別サンプルとする（過学習対策）
- state dump には生成元コミット・デプロイ構成のフィンガープリントを刻み、backtest CLI が
  repo の constants と不一致なら fail-fast する
- **`blockTimeSec` は regime の一部として固定**する（既定は本番と同じ値）。市場パスはブロック単位の
  決定論なので短縮しても不変だが、壁時計駆動 agent の行動頻度が変わり成績の意味が壊れるため（§3）
- **core ソースの公開を前提**とする: backtest は core（coordinator / flow 生成 / stress / 採点）の実行を
  要するため、参加者は repo 一式を持つ。flow・stress・採点のロジックは既知になる前提で設計し、
  秘匿は seed のみで担保する（ロジック既知でも seed 未知なら価格パス・イベント時刻は予測不能）
- state dump は**デプロイ構成 constants（deployments.json → `constants.local.ts` 相当）とセットで配布**し、
  参加者に `gen:local-constants` の実行を要求しない
- victim 付き stress regime（crash 等）のため、ローカルデプロイモードでは「`--load-state` 直後・
  `evm_revert` 直後 = fresh state」とみなして victim setup の full re-fork ガード（ADR 0009 §4）を
  緩和する。victim ポジションが revert で確実に消えること・清算が較正どおり成立することの
  ローカル実証を Phase 0 に含める（setup 時の debt 検証 fail-fast は維持）

### 3. 実行モード

**B1: 実時間再生（本線）** — 既存 sim:realtime をそのまま使う。tx タイミングの非決定性は残るが、
これは本番 realtime と同じ性質であり、「同一 regime を N 回回して分布を見る」統計評価には
むしろ正しい挙動である。ただし `blockTimeSec` は regime の一部として本番と同じ値に固定する（§2）:
市場パスはブロック単位の決定論なので短縮しても不変だが、壁時計駆動 agent（`intervalMs` 指定の
decide 型・prompt 型）の判断頻度や observe / LLM レイテンシとブロック時間の比率が変わり、
成績が本番と同じ意味を失うためである。短縮（例 0.5 秒）は明示 override として許すが、
クラッシュしない・validate を通る等の挙動確認・スモーク専用とし、**成績を読むのは regime
既定値の run のみ**とする。

**B2: 同期ステップ再生（回帰テスト・paired 比較用）** — 壁時計から切り離したターン制で進める:
毎ブロック、flow 注文の投入後に **全 agent の「このブロックの判断完了」通知（+ tx 到着）が揃った
時点で mine** し、次ブロックへ進む。noop を選んだブロックは tx が来ず沈黙とタイムアウトで
区別できないため、通知なしでは「最速」と「再現」が両立しない — そこで runtime/bot.ts に、
flow bot と同じ stdout 1 行同期プロトコルで判断完了（tx 有無込み）を coordinator へ返す通知を
追加する。変更は運営配布コード（bot.ts + coordinator）に閉じ、参加者が書く agent.ts / prompt.md の
契約は無傷。壁時計駆動（`intervalMs` 指定・prompt 型）はステップモードではブロック等価周期に
正規化して駆動する（詳細は Phase 1 で較正）。ブロック駆動の rule agent なら初期状態・seed・順序が
全て固定され**実質ビット再現**になり、「コードを 1 行変えたら結果がどう変わるか」の paired 比較が
できる（prompt 型は LLM 自体の非決定性が残る）。ただし閉ループなので v1/v2 の tx が違えば以降の
市場パスは分岐する — 開ループ tape の「同一データ比較」ではなく**分岐込みの感度比較**である。
bot.ts を使わない完全自前 command agent は完了通知を出せないため、B2 ではタイムアウト駆動の
フォールバックとなりビット再現の対象外（B1 は全種別対象のまま）。realtime とタイミング意味論が
異なるため、B2 の結果は回帰・比較専用とし最終確認は B1 で行う。

### 4. 反復実行の保証

「同じ環境で何回も」を 2 層で保証する:

- **初期状態**: `anvil --load-state` の再ロード、または起動済み anvil 上の `evm_snapshot` → run →
  `evm_revert`（ローカルデプロイモードで検証済みの機構）。`--repeat N` で snapshot/revert ループを回す
- **市場条件**: 同一 regime config（seed）で fair パス・flow 生成が決定論再生される
- **直列反復**は同一 anvil の snapshot/revert が最速。ただし revert で歴史ブロックが消えるため、
  採点の再構成を revert 前に完了する（realtime と同じ制約。anvil の歴史保持深度 ~1,050 ブロックも同様）
- **並列反復**は anvil インスタンスをポート別に分ける（同一 anvil への複数 run 同時載せは
  snapshot/revert が干渉して壊れることが既知）。state ファイルは同じものを各自ロードする
- state dump に agent の資金は含まれない。funding は従来どおり run セットアップで coordinator が
  mint する（mint / owner 権限は anvil 既定キーが前提。配布物仕様に明記する）

### 5. 時系列テストとしての性質

本シミュレータはブロック = 時間ステップの前進型シミュレーションであり、バックテストの
walk-forward が構造として備わっている:

- agent は**現在までの情報だけ**を観測する（fair price はオンチェーン配布で 1 ブロック遅れ、
  observation に直近 20 ブロックの `history`）。判断は次ブロックで約定する
- **look-ahead bias が構造的に不可能**: 未来の市場状態はブロックを進めて初めて生成されるため、
  記録データ再生型のバックテストと違い「未来を覗く」実装ミスが起き得ない
- stress イベント（ブロック X からの ramp→hold→decay 窓）・vuln 窓により、
  「暴落の前・最中・後」という時間構造を持つシナリオを時系列で検証できる
- 時系列出力: 採点再構成が毎ブロックの `valueUsdc` / `alphaValueUsdc` 系列（equity curve）を出し、
  `agents/<id>.jsonl` に毎判断、blocks.csv に約定 tx の時系列が残る
- 1 run の長さは anvil の歴史保持深度（~1,050 ブロック）が実質上限（採点再構成が歴史ブロック読取に
  依存する。realtime と同じ制約）。より長い時系列は regime の期間分割か `--repeat` の連結で扱う

### 6. 採点・出力・agent 対応

- 採点は realtime と完全同一（同じ coordinator・同じ `observationFor`・同じ alphaValueUsdc）。
  `summary.json` は `mode: "backtest"` を刻む以外は同形式で、既存の解析手順がそのまま使える
- agent は**全種別が無改修で動く**: decide 型 / prompt 型（`ERIS_PROMPT_REVISE_EVERY` の自己改訂含む）/
  RPC 直叩きの run(ctx) 自走型（liquidator 等）/ 明示 `command` の完全自前 agent。
  本物の環境なので対応範囲の制限が存在しない（B1。B2 のビット再現はブロック駆動の
  rule agent に限る — §3）
- prompt 型のイテレーションはブロック時間 2 秒の壁時計待ちが消える分だけ高速化する
  （LLM 呼び出し自体は残るため、律速は LLM レートになることを明示する）

### 7. 副産物: 提出ゲートとしての利用

提出 bundle（`bundle:agent`。ADR 0015 §7）を**非公開 regime に対して backtest で smoke test** できる:
クラッシュしない・action が validate を通る・noop 連発でない、を数分で検査する。in-process 駆動と
違い署名・nonce・revert を含む**フルランタイムが検査対象**になり、`check:strategy`（静的検査）と
対になる動的な入口検査となる。

### 8. 参加者に明示する「測れる / 測れない」

| 測れる | 測れない（realtime でのみ検証） |
|--------|--------------------------------|
| 戦略ロジックの正しさ・回帰（クラッシュ / validate 違反 / noop 連発） | 他 agent との競合・ブロック内順序・gas 入札の実勢（ADR 0011。flow とは競るが他参加者は居ない） |
| 自分の約定の市場インパクト込みの regime 別 α 傾向 | 本番ロスター密度での挙動（observe 負荷・機会の食い合い） |
| prompt の挙動・自己改訂の傾向、フル tx 経路（署名・revert） | 本番 seed での成績（regime は同じでも seed は別サンプル） |

## Consequences

### Positive

- 約定が厳密になり、fill model の実装・較正という恒久負債が発生しない（旧 A 案比で新規コードが一桁小さい）
- agent 契約 / sdk が無改修（B2 の変更は運営配布の bot.ts + coordinator に閉じる）= バックテストと
  realtime のランタイム乖離というリスクが最小化される
- 全 agent 種別（liquidator・自前 command 含む）が対象になる
- 同一環境の反復実行（snapshot/revert + seed）と時系列 walk-forward が構造的に保証される
- 提出ゲートがフルランタイムを検査できる
- 参加者セットアップが「foundryup + state ファイル」まで縮む（fork RPC・deployer 不要）

### Negative

- 純 TS replay（旧 A 案）の秒単位速度・完全決定論は得られない
  - → B2 ステップ駆動 + ポート別並列で実用域へ（blockTimeSec 短縮は挙動確認・スモーク専用 — §3）。
    rule agent の回帰は B2 が実質ビット再現を担う
- 参加者に anvil バイナリの導入が必要になる
  - → foundryup 一発 + `--load-state` で deployer/forge は不要。バージョンは固定して配布物に明記する
- B1 の結果は run ごとにぶれる（tx タイミング非決定）
  - → 本番 realtime と同じ性質であり、`--repeat N` で分布を見る運用を既定とする（ADR 0005 の思想）
- sdk に純粋 venue 数理が入らない（旧 A 案の副産物だった参加者向け eth_call なし見積りは実現しない）
  - → ローカル anvil への eth_call はミリ秒オーダーで、fork 時代の見積りコスト問題自体が消えている

### Risks

- B2 のタイミング意味論が realtime と乖離し、B2 で強い戦略が本番で通用しない
  - → B2 は回帰・paired 比較専用と位置づけ、成績の最終確認は B1（さらに本番前は realtime）で行う
    運用をドキュメントで強制する
- state dump と repo の constants / デプロイ構成がドリフトする（spot AMI で既知の失敗モード）
  - → dump に生成元コミットを刻み、backtest CLI が不一致で fail-fast。deployer 変更時は
    state dump の再生成を必須とする
- 参加者が公式 regime（seed）に過学習する
  - → regime はレンジからのサンプル 1 例であり、検査用非公開 regime + 本番 seed 別サンプルで検出・無効化する
- 同一 anvil への並行実行や revert 前の再構成漏れなど、反復運用の足回りで壊す
  - → backtest CLI が anvil ライフサイクル・snapshot/revert・再構成完了待ちを内包し、
    参加者に生の運用手順を露出しない
- ローカルモードの victim ガード緩和（§2）で fresh-state 判定を誤ると、victim 残留で HF 計算が
  壊れる（fork 時代の既知故障モード = ADR 0007 訂正の原因）
  - → Phase 0 で「revert 後の victim 消滅」と「清算の較正どおりの成立」をローカルで実証してから
    crash regime を配布する。setup 時の debt 検証 fail-fast は維持する

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| 歴史価格 CSV を fair パスとして与えるモード（実データ駆動の時系列バックテスト） | fair price は環境が毎ブロック書く系列なので拡張は素直だが、合成 regime で足りるかは需要次第 | regime ライブラリ運用後、需要が出た時点 |
| B2 の完了通知プロトコル詳細（壁時計 interval のブロック等価正規化・フォールバックタイムアウトの較正） | 実装しないと決められない | Phase 1 実装時 |
| vuln regime（ADR 0014 の悪意プール入り） | vuln の live 較正自体が未実施 | vuln 較正完了後 |
| state dump の配布チャネル（repo 同梱 or release asset） | dump の実サイズの実測待ち | Phase 0 で dump を生成した時点 |
| backtest を提出ゲートに正式採用するか（合否基準含む） | コンペルールの問題でありアーキテクチャでは決まらない | コンペルール策定時 |
| 純 TS 高速 replay（旧 A 案）の再検討 | CI で秒単位・完全決定論のテストが必須になった場合のみ価値が出る | その要件が実際に発生した時点 |

## Notes

### 実装フェーズ

1. **Phase 0**: state dump 生成スクリプト（constants 同梱）+ regime config 数本（calm / crash）+
   backtest CLI（B1、anvil ライフサイクル・`--repeat` 内包）+ victim ガード緩和とローカルでの
   stress + victim + 清算の実証（crash regime の前提。§2）
2. **Phase 1**: B2 同期ステップモード（coordinator の mine トリガー + bot.ts の判断完了通知）+
   equity curve 出力の整備 + 較正（同一 regime での B1/B2/realtime 比較）
3. **Phase 2**: 公式 regime ライブラリ拡充（stress / vuln）+ 提出ゲートへの組込み

### 参考資料

- ADR 0015: core/example パッケージ分離と agent ランタイム一本化 — agent 契約・bundle の前提。
  §8 の「anvil を介さない専用エンジン」トリガーは本 ADR で発火を検討し見送った（本文 Decision 参照）
- ADR 0005: realtime 化と統計評価 — 「regime = 市場条件のラベル・同一 regime でも結果はぶれる・
  複数回回して集計する」という B1 の運用思想の出典
- ADR 0006: 環境とエージェント実行の分離 — coordinator / agent プロセス分離と採点再構成。
  backtest はこの機構を無改修で再利用する
- ADR 0009 / 0011 / 0013 / 0014: stress イベント / economic gas / config 単一ソース（regime YAML の
  スキーマ元）/ vuln イベント
- 先行実証: ローカルデプロイモード（fork なし全 5 venue、snapshot/revert）と spot golden AMI
  （`anvil --load-state` による全 venue ~10 秒復元）— 本 ADR の実行基盤・配布方式はこの 2 つの
  既存実証の組合せである
- [benedictbrady/amm-challenge](https://github.com/benedictbrady/amm-challenge) — ADR 0015 Notes で
  「将来の取り込み候補」とした「提出前ローカル検証 CLI」の実現が本 ADR に相当する
