[← 目次](README.md) ｜ [← 08 成果物](08-artifacts.md) ｜ [10 運用 →](10-operations.md)

# 09. ダッシュボード

`dashboard/` workspace（Vite + React）。**run にも採点にも一切依存しない**観戦・分析 UI で、`runs/<id>/` をディスクから読み、必要なら anvil を JSON-RPC で読む。

出典 `dashboard/src/{App.tsx,navigation.ts}`、`dashboard/src/data/*`、`dashboard/server/runsApi.ts`。

## 9.1 情報階層

```
competition  ⊃  scenario（1 world = "regime#seed"）  ⊃  round（1 採点エポック）
```

`dashboard/src/data/competition.ts:1-8` が定義する唯一のモデル。

- competition は通常 `npm run backtest -- --scenarios` が書く `matrix.json`。セグメント期間も同じ形
- **「competition に属さない run」という第 2 のモデルは無い。** `sim:realtime` の 1 run は「1 シナリオの競技」であり、`competitionFromRun` が同一の形へ包む。**データ層の入口 1 箇所で正規化するので、以降のページは 1 種類の型しか見ない**
- UI から "matrix" という語は消してある（ディスク上の `matrix.json` は core の出力なのでそのまま）

### ルート

| パス | ページ |
|---|---|
| `/` | Standings（competition の順位表）= **既定の着地点** |
| `/scenario` | 1 シナリオの詳細 |
| `/agent/<id>` | エージェント詳細 |
| `/markets` | venue の状態（scenario 層） |
| `/explorer` | ブロック/tx 探索（scenario 層） |

**`/` を competition にしている理由**：1 シナリオは分布からの 1 ドローであって結果ではない（`config/scenarios/public.yaml`: "the published seeds are five draws from it, **not the target**"）。そこを既定にすると「読んではいけない単位」を最初に見せることになる。

`/markets` と `/explorer` が scenario 層に留まるのは、venue の状態とブロック範囲が 1 つの world の中でしか意味を持たないため。

**削除済みのルート**：`/standings`・`/leaderboard`（scenario 内順位と重複）・`/archive`（未到達の遺物）・`/run`（エイリアス）。

## 9.2 ラウンドカーソル（UI の時計）

`dashboard/src/data/roundCursor.ts`。**位置が 1 つだけ存在する。**

スコアも順位変動も環境イベントも全部エポック単位なので、全ビューはこの軸に対して読む。**以前はラウンド軸を 3 回別々に実装していた**（ラウンド選択 / replay head / live head）— 3 つのストア、1 つの概念。

| 性質 | 内容 |
|---|---|
| `round` | **1-based かつ competition 相対**。`null` は「終わり」= 完走結果 |
| 意味 | **round k では 35 シナリオが各自の round k にいる**。だから 35 個の独立した world が 1 つの競技として観られる |
| 再生 | カーソルを進めるだけ（独立した「リプレイモード」ではない）。1x/2x/4x、1 tick = 700ms |
| 終端 | ループせず**終わりで停止**する（黙って巻き戻るカーソルは「競技が巻き戻った」と読める） |
| 範囲変更 | 新しい範囲に収まる位置は保持する。**はみ出す位置は終端に寄せる**（9 ラウンドのシナリオの round 20 は round 9 ではない） |

ブロック単位の細かい移動（1 シナリオ内）は `replay.ts` に残る。これはこの位置の**細分**であって対立する概念ではなく、シナリオを 1 本開いているときにだけ存在する。armed のとき replay がカーソルを駆動し、カーソルが replay を駆動し返すことはない。

## 9.3 順位表

### ルールは固定（参加者向け）

指標 × 集約のコントロール・λ/ρ スライダ・不一致パネル・#55 露出は 2026-08-31 に撤去した。指標を振った再採点は `npm run metrics -- --matrix` の仕事。

```
シナリオごと M9 = mean − λ·std（λ = 0.25）
  → シナリオ内 z-score
  → レジーム等重み平均
```

**集約は `core/src/scoring/aggregate.ts` をダッシュボードが直接 import する**（`@core/*` alias）。採点ロジックを 2 箇所に置くと、CLI と画面で順位が食い違ったときどちらが本物か分からなくなる。

### 表示

| 列 | 内容 |
|---|---|
| スコア | **M9 のレジーム等重み平均そのもの**（×10⁴ スケール・単位表記なし）。z 集約値は tooltip に降格 |
| net PnL（final marks） | 参考列。β が相殺され `noop` がきっかり 0 になる方の量 |

z を表に出さないのは、**無単位の z が「どれだけ差があるか」を答えられない**ため。**表示値と順位は稀に前後し得る**が、それは集約方式の差そのものなのでキャプションに明記する。

### `practice` バッジ

`competition.file.resetUnit === "continuous"` のとき常設する（`HomePage.tsx:142`）。ADR 0020 §2 が公式競技を `scenario` モードに置いたので、**continuous な competition は構造的に公式採点ではない**。

**「scenario でない」ではなく「continuous である」で判定する** — ADR 0020 以前の `matrix.json` は当該フィールドを持たず、あれは公式形だった。逆向きに間違えて practice と貼るのは同じ種類の誤りになる。

順位の出自が順位と別々に流通すると誤読されるので、**順位表そのものに恒久的に書く**。

### "through round k"

順位は**先頭 k ラウンドで再計算する**（完走結果を読まない）+ round k−1 からの移動を出す。

`summary.json` の `logReturns` は**フロア適用済み・ベンチマーク超過済み・破産凍結済み**で、λ 以外の構成要素をすべて含む。よって「round k までの順位」は先頭 k 要素に対する `mean − λ·std` **そのもの**であって近似ではない（`dashboard/src/data/standings.ts:47-53`）。

### シナリオ長が揃っていないとき

full-8h では depeg が 9 ラウンド、他は 29 ラウンド。**最終ラウンドを過ぎたシナリオは「世界が終了した」扱いで順位に残す**（除くと「結果でない理由」で場が動く）。帯に `30 of 35 still running · 5 ended earlier` と出す。

### net PnL はラウンド絞り不可

両端を run 最終価格で評価するので、round k の値が存在しない。順位表の参考列としてだけ出し、**スクラブ中は灰色で提示して完走値をラウンド名で出さない**。

### 順位が存在しない 2 ケース

どちらも scenario ビューに着地させ、そう書く。

1. **live run** — `summary.json` は完走時に書かれるので結果がまだ無い
2. **seed プロバイダ**（フィクスチャ）

## 9.4 scenario ページ

タブ形式ではなく縦に積んだ構成（`dashboard/src/pages/ScenarioPage.tsx`）。

```
RoundsBar（ラウンド軸）
hero        シナリオ名（regime#seed、`full-` 接頭辞は剥がす）+ seed + ラウンド数/ブロック数
leaderboard  シナリオ内の順位
market tickers / blocks / tape（イベント列）
SectionPanel  Markets（→ /markets）/ Standings / Explorer（→ /explorer）
InfoTabs      overview / environment / scoring / artifacts（学習層）
```

**hero がシナリオ自身を名乗る**。以前はここが ERIS のワードマークで、35 の world のどれが画面に出ているのかを何も言わずに全シナリオがアプリの表紙のように見えていた。

**実装語彙（ファイル名・ADR 番号）を出してよいのは InfoTabs だけ**（§9.10）。

### 環境イベントのラウンド化（`dashboard/src/data/schedule.ts`）

`stress_schedule` は seed から引かれた**計画**であり、run-relative なブロック窓を持つ。これを**ラウンド軸へ変換する**（`fromRound` / `toRound` = `ceil(block / epochBlocks)`）。ラウンドが他のすべてが乗っている軸だから。

- `stress_schedule` は最初のブロックより前に書かれるので、**events.jsonl の先頭 128KB を読むだけでよい**。35 シナリオで 4MB（全ファイルなら 102MB）
- `windowsAtRound(schedules, round)` が競技全体からその round に掛かる窓を集め、**開いた瞬間の窓を先頭に並べる**（3 ラウンド開いている窓は文脈、いま開いた窓はニュース）
- 順位表のラウンド注記がこれを 1 行で出す

**`crash` / `spike` / `cexDrift` / `flowTrend` は毎ブロックの記録を残さない**（価格の walk 自体を変えるため）ので、これは**「計画」であってそう明示する**。「never fired」とは書かず「price chart を見よ」と出す。

**seed は `run_started_realtime` に記録されている**。無い古い run では stat 自体を出さない。

### パネルのスコープ

選択中のラウンドで絞る。**`scopeRunToBlocks`（`runsProvider.ts:1358`）が run オブジェクト自体をブロック窓で絞る**ので、ビルダー側に第 2 の経路ができない。ヘッダに窓を明示し、全体に戻すリンクを出す。

**例外は run 終端の断面表**（GMX 建玉 / Aave 口座 / reserve）で、run 終了時の 1 断面なのでタイトルに "at the run's final block" と書く。建玉が本当にゼロだった場合は「この run では建玉が無かった、あるいはこの run が venue 別建玉の記録より古い」と文章で出す。

**ラウンド別 volume の合計が run 全体より小さいのは正しい** — scorer が末尾の端数エポックを落とすので、最終境界より後のブロックはどのラウンドにも属さない。

### ラウンドバー

上部の帯は選択中 run のエポック系列そのもの（`valueSeries.epochSeries.boundaryBlocks`）。セグメントを押すとその round の per-agent 結果が開く。

- **`Δ value` と `log return` は別物**：前者は β 込みの生の資産変化（noop も動く）、後者は baseline 超過（= スコアが平均する系列）
- live run は採点系列が無いので `run_started_realtime.epochBlocks` から枠だけ引いて進捗を出し、結果は完走時に入る

## 9.5 `/markets`

**価格ではなく venue の状態**を出す。有効な protocol ごとに 1 タブ（AMM / Perp / Lending / Stablecoin / LST）。

| 出典 | 対象 |
|---|---|
| `market.json` | AMM・Perp・Lending・stable 価格 |
| **`events.jsonl` の `lst_block` / `liquity_block`** | LST と Liquity の「市場全体の状態」 |

LST / Liquity を events から読むのは、coordinator が毎ブロック出しているので**二重に再構成する必要がなく、古い run でも描ける**ため。構築は `dashboard/src/data/venuePanels.ts`。

### エージェントの建玉

**全 venue 分が `market.json` に入る**（`gmxPositionsAtEnd` / `aaveAccountsAtEnd` / `lstPositionsAtEnd` / `liquityPositionsAtEnd`）。

以前は GMX だけを見ていたので、run 中ずっとステークや借入だけしていたエージェントは空表になり「壊れている」と見分けがつかなかった。表は perp 形ではなく **venue / kind / size / 何に対してマークしているか（entry 価格・償還レート・ICR・HF）/ detail**。本当に建玉ゼロで終わった場合はその旨を文章で出す。

## 9.6 エージェントページ

既定タブは **Standing（順位の理由）** — ただし**そのエージェントが competition で順位を持つときだけ**で、持たない場合（seed モード / live run）は Overview に着地する（`AgentDetailPage.tsx:516`）。

そのエージェントの全エポックを**competition 横断でプールして** mean / std / λ·std / 分布 / レジーム別内訳を出す。M9 自体はシナリオごと → レジーム平均なので、これは別の順位ではなく**説明**である。

実測例：`clean-arb` は 1 ラウンド +0.32bp・std 1.78bp で 1 位、`levered-long-max` は **+4.90bp**・std **78.60bp** で最下位。**15 倍稼いでいる方が最下位**で、差は全部 std。レジーム別に割ると `cex-drift` だけ +48.3bp で他 6 本は負け＝レジーム適合の話だと分かる。

**判断ログタブは external エージェントでは出さない**（[05 §5.9](05-agent-contract.md)）。空パネルは「このエージェントは何も考えなかった」という別の主張になる。送信フィードは「何名がここに出ないか」を明示する。

## 9.7 live / replay

### live

実行中の run は `● (live)` として現れる。

| 判定 | `summary.json` が無く、`events.jsonl` / `blocks.csv` の**新しい方**が 120 秒以内に更新されている（`runsApi.ts:23`） |
|---|---|
| 情報源 | events/agent jsonl の tail + `run_started_realtime.rpcUrl` の現ブロック読取 |
| 切り替え | 採点・venue 系列は完走時に自動で archived 表示へ |

**判定を「新しい方」で見る理由**：teardown（blocks.csv の一括記録 → 再構成 sweep）の間、events.jsonl は数十秒沈黙しうる。その間に index から落ちると、ダッシュボードは隣の run へ飛んでそこで固まる（live 更新ループは見失った run と一緒に止まる）。

### replay

完走した run を「ブロック B 時点」として前に歩かせる（rounds bar の `▶ replay`）。

**live モードは run したマシンでしか成立しない**（tail は dev サーバーのファイルシステム、チェーン読取はエージェントの anvil）ので、**完走済み run と spot で回して回収した run を観るにはこれが唯一の手段**。

archived は live より情報が多い（`market.json`・採点済みエポック・完全な `blocks.csv`）ので、劣化版ではなく**上位互換**。

**未来を見せないのが要件**：

- 閉じていないラウンドは結果を持たない
- 順位も**閉じたラウンドまでの `mean − λ·std` で計算し直す**（完走時のスコアを読むと毎フレームに答えが出てしまう）
- run 終端の建玉断面も head が終端に届くまで落とす

## 9.8 run の探索（`/runs` API）

`dashboard/server/runsApi.ts`。dev サーバーと hosted サーバーで**同じハンドラを共有**する。

| エンドポイント | 内容 |
|---|---|
| `/runs/index.json` | run ディレクトリ一覧（新しい順）。`live: true` / `kind: "matrix"` タグ付き |
| `/runs/<id>/<artifact>` | 成果物そのもの |
| `/runs/<id>/tail/<file>?offset=N&limit=M` | jsonl / csv の増分 tail |

- **走査は 2 階層下まで**（`MAX_RUN_DEPTH = 2`）。spot から回収した run は `runs/<回収ID>/runs/<runID>/` に展開されるため。picker には `<runID> ← <回収ID>` と出る
- id は `runs/` からの相対パス（スラッシュを含みうるので、tail の分割は**最後の `/tail/`** で行う）
- **競技ディレクトリは葉ではない**：`matrix.json` を持つディレクトリの中にセグメントがあり、それらは run である
- tail は 1 回 4MB 上限。`limit` を明示すると先頭だけ読める（`run_started_realtime` と `stress_schedule` は最初の数 KB にあるので、35 シナジオ × 128KB = 4MB で済み、全ファイルを読む 102MB と同じ答えが得られる）
- パス解決は prefix チェック + `realpath`（`runs/` 配下のシンボリックリンクがどこでも指せてしまうのを塞ぐ）

**`npm run dashboard:serve` は read-only だがアクセス境界ではない** — `runs/` 配下は全部公開になる（[10](10-operations.md)）。

## 9.9 表示名の原則

**内部 ID を UI に出さない。**

| 対象 | 表示 |
|---|---|
| 競技名 | scenarioSet + 実施日から自動導出（h1 に `full-8h`、picker に `full-8h · 8/29`、生の ID は tooltip） |
| シナリオ | 常に `regime#seed`（表示では `full-` 接頭辞を剥がす）。セグメントは日付ラベル |
| run | `2026-08-29 16:03`（ディレクトリ名のタイムスタンプを整形） |
| **`runs/` の通し番号「Run N」** | **全廃**（開発機ローカルの座標で参加者に無意味） |

**識別と表示は別**：シナリオのキーは `runDir`（`--repeat` で (regime, seed) が重複しうるし、セグメントは同じ時刻ラベルを共有しうる）。ラベルでキーにすると 6 セグメントが 1 つに潰れてラウンドが混ざる。

## 9.10 i18n

`dashboard/src/i18n/`（locale ストア + 全文言辞書 `messages.ts`）。サイドバーのトグルで切替、localStorage 永続、既定はブラウザ言語。

**データ層のビルダー（`venuePanels` / `runsProvider` の tape・建玉表）も `t()` を呼ぶ**ため、`useSnapshot` が key に locale を含めて言語切替でスナップショットを再構築する。

文言の規律：

- 実装語彙（ファイル名・ADR 番号）は**学習層（scenario ページの Info タブ）以外に出さない**
- 単位は必ず添える（bps・USDC）
- 状態語は **live・finished の 2 語**
- `npm run` コマンドは explorer 起動などローカル運用文脈のみ

## 9.11 Blockscout 連携

起動していれば tx / block / address が deep link になり、indexer の高さが RPC の高さと併記される。**落ちていればリンクだけ消える**（機能は劣化しない）。

`/explorer` は接続状態を明示し（indexed 高さ / 落ちていれば起動コマンド）、検索が tx hash・block・address・**エージェント名**（→ wallet address。Blockscout は名前を知らない）を解決する。Blockscout が無くてもローカル一覧のフィルタとしては効く。

## 9.12 開発用

`VITE_DATA_PROVIDER=seed` でフィクスチャデータに切り替わる（`dashboard/src/data/seed.ts`）。seed プロバイダには順位が存在しないので、そう表示する。
