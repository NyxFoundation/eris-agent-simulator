[← 目次](README.md) ｜ [← 08 成果物](08-artifacts.md) ｜ [10 運用 →](10-operations.md)

# 09. ダッシュボード

`dashboard/` workspace（Vite + React）。**run にも採点にも一切依存しない**観戦・分析 UI で、`runs/<id>/` をディスクから読み、必要なら anvil を JSON-RPC で読む。

出典 `dashboard/src/{App.tsx,navigation.ts}`、`dashboard/src/data/*`、`dashboard/server/runsApi.ts`。

## 9.1 情報階層

```
competition  ⊃  scenario（1 world = 規約の 1 エポック = "regime#seed"）  ⊃  interval（1 評価区間。途中経過で、採点の単位ではない）
```

`dashboard/src/data/competition.ts:1-8` が定義する唯一のモデル。

UI は評価区間を「評価区間」/ "Interval" と表示する（issue #140 までは「ラウンド」/ "Round"）。dashboard のコード内の識別子（`roundCursor` / `RoundsBar` / `round` など）は round のままで、`dashboard/` の中では常に評価区間を指す。

- competition は通常 `npm run backtest -- --scenarios` が書く `matrix.json`。セグメント期間も同じ形
- **「competition に属さない run」という第 2 のモデルは無い。** `sim:realtime` の 1 run は「1 シナリオの競技」であり、`competitionFromRun` が同一の形へ包む。**データ層の入口 1 箇所で正規化するので、以降のページは 1 種類の型しか見ない**
- UI から "matrix" という語は消してある（ディスク上の `matrix.json` は core の出力なのでそのまま）

### ルート

| パス | ページ |
|---|---|
| `/` | Overview（日程・規約の要約・上位 5 名・リンク集）= **既定の着地点**（issue #183） |
| `/standings` | Standings（competition の順位表 + シナリオ一覧） |
| `/scenario` | 1 シナリオの詳細 |
| `/agent/<id>` | エージェント詳細 |
| `/markets` | venue の状態（scenario 層） |
| `/explorer` | ブロック/tx 探索（scenario 層） |

**着地点を 1 シナリオにしない理由**：1 シナリオは分布からの 1 ドローであって結果ではない（`config/scenarios/public.yaml`: "the published seeds are five draws from it, **not the target**"）。そこを既定にすると「読んではいけない単位」を最初に見せることになる。着地点は参加者が大会について最初に知るべきこと（Overview）で、順位はその中の上位 5 名と、1 クリック先の `/standings`。

### ヘッダ・Overview・？（issue #183）

- **ヘッダ**（`components/SiteHeader.tsx`、全ページ共通・sticky）: ASCON ロゴ（→ `/`）、ナビ（Overview / Standings / Scenario / Markets / Explorer）、**参加登録**（Google Form 直結。？ に「先に Discord #ascon へ」。**10/25 00:00 JST 以降は出さない**）、その右に**提出**（エージェント提出フォーム直結。**提出期間 9/23〜10/31 だけ**出す。枠線だけのボタンで参加登録と見分ける）、日英トグル。430px 以下はロゴのワードマークを省いて 2 つのボタンを収める。860px 以下はナビをメニューに畳み、参加登録とトグルはバーに残す。ページ内の sticky なバーは `top: var(--header-h)`
- **サイドバーは無い**（全モード・全ページで全幅）。フッタに「閲覧専用 · ログイン不要」（公開ビューでは「公開ビュー ？」も）。**競技セレクト**（`components/CompetitionPicker.tsx`）は概要の上位 5 名の見出しと `/standings` の競技名の横で、**手元で選択肢があるときだけ**（競技が 2 つ以上、または 1 つ + 競技外の run =「— 単発 run —」）。**公開ビューでは出さず、ブラウザに保存された選択も無視して最新の競技を出す**（`effectiveSelectedCompetitionId`。無視しないと、以前別の競技を選んだ閲覧者が動かす手段のないまま古い競技に固定される）。**世界の切替**（`components/WorldSwitcher.tsx`、「変更 ▾」）は scenario 層のページ（シナリオ・マーケット・エクスプローラ・エージェント）の評価区間バーの世界名の横で、選択中の run を今の競技の中に保つ役もする
- **Overview**（`pages/OverviewPage.tsx`）: 日程（ブラウザの時計で「開催中」と次の締切までの JST 暦日数）/ **提出の手順**（参加登録 → API キー → 作る → 手元で確かめる →（任意）練習環境 → ZIP → 提出 → 凍結。各段は 1 行 + ガイドの節へのリンク、コマンドは `bundle:agent` だけ。期間のある段に「受付中 · あと N 日」「締切済み」「9/23 から」。参加者の進み具合は分からないので「あなたの段」は指さない。提出フォームは受付期間中だけ直接リンク（`SUBMISSION_FORM_URL`）、API キーのフォームは載せず Discord 案内。10/31 以降は 1 行に畳む）/ 評価・賞金・提出と制約の 3 カード（要点を常時表示、全文は ？、ascon.dev の規約の節へリンク）/ 上位 5 名（順位・エージェント・平均得点・採点数と、何の数字か・何日分／何エポック分・更新時刻の 1 行。`standings: false` では出さない。練習期間は練習順位、完走済みで結果発表前は「順位」、結果発表後は「最終結果」）/ リンク集
- **呼び方**（日本語 UI）: エポック（練習期間は 1 日）ごとの偏差値 = **得点**、順位を決めるその加重平均 = **平均得点**。規約の「スコア」は平均得点のこと（評価カードに 1 行添える）。英語は score のまま
- **規約の値は `data/competitionInfo.ts` 1 ファイル**（各値に ascon-web `content/legal/rules.md` の節番号）。規約改定時はここだけ直す。文言は `i18n/messages.ts` の `overview.*`
- **？**（`design-system/InfoTip.tsx`）: 説明はここに入れ、見出しと数字だけを常時表示する。クリック/タップ/キーボード（Enter・Space で開閉、Esc で閉じてボタンへ戻る）で開き、外側を押すと閉じる。1 度に 1 つ。パネルは `position: fixed` なので横スクロールする表の中でも切れない。`Panel` の `info` prop が入口。**ネイティブの `title=` は説明に使わない**（スマホで出ない・キーボードで届かない）— 切り詰めた名前の全文やデータの読み値など説明でないものだけ残す
- 旧 InfoTabs（概要 / 環境 / 採点 / データ）は解体: 採点 → Overview の評価カード、概要・環境 → 該当箇所の ？（Overview の見出し・シナリオ一覧）、データ（`npm run explorer` など運営者向け）→ `/explorer` の ？ で公開ビューでは出さない

`/markets` と `/explorer` が scenario 層に留まるのは、venue の状態とブロック範囲が 1 つの world の中でしか意味を持たないため。

**削除済みのルート**：`/leaderboard`（scenario 内順位と重複）・`/archive`（未到達の遺物）・`/run`（エイリアス）。`/standings` は一度削除したが、issue #183 で `/` を Overview にしたときに順位表の置き場所として戻した。

## 9.2 評価区間カーソル（UI の時計）

`dashboard/src/data/roundCursor.ts`。**位置が 1 つだけ存在する。**

途中経過の価値も順位変動も環境イベントも評価区間単位なので、全ビューはこの軸に対して読む。**以前はこの軸を 3 回別々に実装していた**（評価区間の選択 / replay head / live head）— 3 つのストア、1 つの概念。

| 性質 | 内容 |
|---|---|
| `round` | **1-based かつ competition 相対**。`null` は「終わり」= 完走結果 |
| 意味 | **評価区間 k では 35 シナリオが各自の評価区間 k にいる**。だから 35 個の独立した world が 1 つの競技として観られる |
| 再生 | カーソルを進めるだけ（独立した「リプレイモード」ではない）。1x/2x/4x、1 tick = 700ms |
| 終端 | ループせず**終わりで停止**する（黙って巻き戻るカーソルは「競技が巻き戻った」と読める） |
| 範囲変更 | 新しい範囲に収まる位置は保持する。**はみ出す位置は終端に寄せる**（9 区間のシナリオの評価区間 20 は評価区間 9 ではない） |

ブロック単位の細かい移動（1 シナリオ内）は `replay.ts` に残る。これはこの位置の**細分**であって対立する概念ではなく、シナリオを 1 本開いているときにだけ存在する。armed のとき replay がカーソルを駆動し、カーソルが replay を駆動し返すことはない。

## 9.3 順位表

### ルールは固定（参加者向け）

指標 × 集約のコントロール・λ/ρ スライダ・不一致パネル・#55 露出は 2026-08-31 に撤去し、2026-09-06 に採点規則そのものが規約 §4.4 の偏差値方式で確定した（ADR 0023）。振る指標は無い。

```
シナリオ（= エポック）ごと P = V_K − V_0 → T = 50 + 10 (P − μ) / σ（場全体）
  → Score = Σ w·T / Σ w（w は回次に線形 1 → 1.5）
  → レジーム等重み平均
```

**採点は `core/src/scoring/deviationScore.ts` をダッシュボードが直接 import する**（`@core/*` alias）。採点ロジックを 2 箇所に置くと、CLI と画面で順位が食い違ったときどちらが本物か分からなくなる。

### 表示

| 列 | 内容 |
|---|---|
| スコア | **Score（2 桁）**。tooltip に採点エポック数と §4.6 のタイブレーク（T の標準偏差・最悪エポック） |
| net PnL（final marks） | 参考列。β が相殺され `noop` がきっかり 0 になる方の量 |

z を表に出さないのは、**無単位の z が「どれだけ差があるか」を答えられない**ため。**表示値と順位は稀に前後し得る**が、それは集約方式の差そのものなのでキャプションに明記する。

### `practice` バッジ

`competition.file.resetUnit === "continuous"` のとき常設する（`StandingsPage.tsx`）。ADR 0020 §2 が公式競技を `scenario` モードに置いたので、**continuous な competition は構造的に公式採点ではない**。

**「scenario でない」ではなく「continuous である」で判定する** — ADR 0020 以前の `matrix.json` は当該フィールドを持たず、あれは公式形だった。逆向きに間違えて practice と貼るのは同じ種類の誤りになる。

順位の出自が順位と別々に流通すると誤読されるので、**順位表そのものに恒久的に書く**。

### "through interval k"

順位は**先頭 k 評価区間で再計算する**（完走結果を読まない）+ 評価区間 k−1 からの移動を出す。

「評価区間 k までの順位」は、境界系列から P = V_k − V_0 を取り直して T と Score を再計算したもの**そのもの**であって近似ではない（`dashboard/src/data/standings.ts` の `scenarioPnl`）。

### シナリオ長が揃っていないとき

full-8h（最後の評価区間が採点されていなかった頃の記録）では depeg が 9 評価区間、他は 29 評価区間。**最終評価区間を過ぎたシナリオは「世界が終了した」扱いで順位に残す**（除くと「結果でない理由」で場が動く）。帯に `30 of 35 still running · 5 ended earlier` と出す。

### net PnL は評価区間で絞れない

両端を run 最終価格で評価するので、評価区間 k の値が存在しない。順位表の参考列としてだけ出し、**スクラブ中は灰色で提示して完走値を評価区間名で出さない**。

### 順位が存在しない 2 ケース

どちらも scenario ビューに着地させ、そう書く。

1. **live run** — `summary.json` は完走時に書かれるので結果がまだ無い
2. **seed プロバイダ**（フィクスチャ）

## 9.4 scenario ページ

1 つの world を**ブロック単位で歩ける盤面**として出す（`dashboard/src/pages/ScenarioPage.tsx`）。他のページが「何が起きたか」に答えるのに対し、ここは「起きている最中はどう見えるか」に答える。

```
RoundsBar      評価区間の軸（競技のカーソル。replay の transport はここでは出さない）
header         シナリオ名（regime#seed、`full-` 接頭辞は剥がす）+ seed + 評価区間数/ブロック数 + agent 数・venue 数・表示中のブロック窓
WorldTimeline  ブロック軸。クリック・ドラッグ・← → で移動、0.5x〜4x 再生。評価区間の境界が目盛り
WorldMap       左に wallet、中央にチェーン、右に contract。1 フレーム = 1 ブロック（900 フレーム超は複数ブロックを束ねて範囲表示）
This block     取引数 / revert / 取引した agent 数 / その場で環境がしたこと
3 パネル       シナリオ内順位（行クリックで盤面の wallet を選ぶ）/ Agent Log（選んだ wallet の判断ログ、head まで）/ 各 venue の価格 vs fair と採点境界ごとの口座評価額
```

**以前は Markets / Standings / Explorer のプレビュー 3 枚を並べたランディングで、盤面は `/world` という別タブだった**（2026-09-07 に統合）。プレビューは盤面が持つ数字から時間軸を抜いたものだったので、盤面をページ本体にした。`/world` へのリンクは `/scenario` に着地する。

**時計は 2 本あるが、ページのものは 1 本**。RoundsBar は競技のカーソル（全 world の評価区間 k）で、選んだ評価区間がブロック軸の窓になる。ブロック軸の head はページのローカル状態であって replay head ではない — replay head はフェッチキーに入っているので一歩ごとに全 snapshot を再取得するが、盤面は snapshot が持つフレームを歩くだけで再取得が要らない。**歩いた途中でページを離れると、その時点で 1 回だけ head を replay store に渡す**（archived なら replay を arm、replay 中なら seek）。`/markets` と `/explorer` が盤面のいたブロックで開くためで、末尾まで歩き切っていれば渡さない（他ページの既定は run 全体で、末尾に停めた replay は同じ表示に「replay」と付けるだけ）。逆に、この run の replay が armed の状態でページを開くと盤面はその head から始まる。**盤面のフレーム自体は replay で clamp しない**（フレームは常に run 全体。replay head で切ると head 以降が「取引の無い未来」として見える）。未来を見せない責務は walk の head が負い、Agent Log・チャート・順位パネルは head までしか読まない。順位パネルは **head 時点で閉じた評価区間までの順位**（`standingsThroughRound`。`buildStandings` を閉じた評価区間の数ごとに呼ぶだけで、採点経路は 1 本のまま）で、閉じた評価区間が無ければ「まだ採点されていません」と出す。

**header がシナリオ自身を名乗る**。以前はここが ERIS のワードマークで、35 の world のどれが画面に出ているのかを何も言わずに全シナリオがアプリの表紙のように見えていた。

**実装語彙（ファイル名・ADR 番号）を出してよいのは運営者向けの ？ だけ**（§9.10）。

### 環境イベントの評価区間への変換（`dashboard/src/data/schedule.ts`）

`stress_schedule` は seed から引かれた**計画**であり、run-relative なブロック窓を持つ。これを**評価区間の軸へ変換する**（`fromRound` / `toRound` = `ceil(block / intervalBlocks)`）。評価区間が他のすべてが乗っている軸だから。

- `stress_schedule` は最初のブロックより前に書かれるので、**events.jsonl の先頭 128KB を読むだけでよい**。35 シナリオで 4MB（全ファイルなら 102MB）
- `windowsAtRound(schedules, round)` が競技全体からその評価区間に掛かる窓を集め、**開いた瞬間の窓を先頭に並べる**（3 評価区間開いている窓は文脈、いま開いた窓はニュース）
- 順位表の評価区間注記がこれを 1 行で出す

**`crash` / `spike` / `cexDrift` / `flowTrend` は毎ブロックの記録を残さない**（価格の walk 自体を変えるため）ので、これは**「計画」であってそう明示する**。「never fired」とは書かず「price chart を見よ」と出す。

**seed は `run_started_realtime` に記録されている**。無い古い run では stat 自体を出さない。

### パネルのスコープ

選択中の評価区間で絞る。**`scopeRunToBlocks`（`runsProvider.ts:1358`）が run オブジェクト自体をブロック窓で絞る**ので、ビルダー側に第 2 の経路ができない。ヘッダに窓を明示し、全体に戻すリンクを出す。

**例外は run 終端の断面表**（GMX 建玉 / Aave 口座 / reserve）で、run 終了時の 1 断面なのでタイトルに "at the run's final block" と書く。建玉が本当にゼロだった場合は「この run では建玉が無かった、あるいはこの run が venue 別建玉の記録より古い」と文章で出す。

**評価区間別 volume の合計が run 全体と違うのは最初のブロックの分だけ** — 評価区間は `(fromBlock, toBlock]` で、最後の境界は run の最終ブロック（`blocksRemaining` が 0 のブロック。`core/src/epochExtent.ts`）なので、境界 0（run の最初のブロック。V_0 はその状態で読む）より後のブロックはちょうど 1 つの評価区間に属する。以前は scorer が末尾の端数区間を落とし、最終境界より後のブロックがどの評価区間にも属さなかった。

### 評価区間バー（`RoundsBar`）

上部の帯は選択中 run の評価区間の系列そのもの（`valueSeries.intervalSeries.boundaryBlocks`。issue #140 以前の run は `epochSeries`、どちらでも読む）。セグメントを押すとその評価区間の per-agent 結果が開く。

- **`Δ value` と `log return` は別物**：前者は β 込みの生の資産変化（noop も動く）、後者は同じ変化を対数成長率 ln(後 / 前) で表したもの。**どちらもスコアではない**（スコアはエポックにつき 1 つの P）
- live run は採点系列が無いので `run_started_realtime.intervalBlocks`（古い run は `epochBlocks`）から枠だけ引いて進捗を出し、結果は完走時に入る

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

そのエージェントが採点された全エポック（s / シナリオ / P / T / w）と、T の平均・標準偏差・最悪値（§4.6 のタイブレーク）、分布、レジーム別内訳を出す。順位は Score で決まるので、これは別の順位ではなく**説明**である。

実測例：`clean-arb` は 1 評価区間あたり +0.32bp・std 1.78bp で 1 位、`levered-long-max` は **+4.90bp**・std **78.60bp** で最下位。**15 倍稼いでいる方が最下位**で、差は全部 std。レジーム別に割ると `cex-drift` だけ +48.3bp で他 6 本は負け＝レジーム適合の話だと分かる。

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

完走した run を「ブロック B 時点」として前に歩かせる（評価区間バーの `▶ replay`）。scenario ページだけは transport を出さない（ブロック軸を自前で持つ。§9.4）。そこを歩いた途中で離れると head が replay に渡る。

**live モードは run したマシンでしか成立しない**（tail は dev サーバーのファイルシステム、チェーン読取はエージェントの anvil）ので、**完走済み run と spot で回して回収した run を観るにはこれが唯一の手段**。

archived は live より情報が多い（`market.json`・採点済みの評価区間系列・完全な `blocks.csv`）ので、劣化版ではなく**上位互換**。

**未来を見せないのが要件**：

- 閉じていない評価区間は結果を持たない
- 順位も**閉じた評価区間までの P = V_k − V_0 から T を計算し直す**（完走時の数字を読むと毎フレームに答えが出てしまう）
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
| 競技名 | scenarioSet + 実施日から自動導出（h1 に `full-8h`、picker に `full-8h · 8/29`、生の ID は tooltip）。**この例の `full-8h` は保存済み run が記録している名前**で、セットファイル自体はレジーム一本化の際に `public.yaml` へ統合された — 表示名は `matrix.json` の `scenarioSet` から来るので、消えたセット名も過去の run では出続ける |
| シナリオ | 常に `regime#seed`（表示では `full-` 接頭辞を剥がす）。セグメントは日付ラベル |
| run | `2026-08-29 16:03`（ディレクトリ名のタイムスタンプを整形） |
| **`runs/` の通し番号「Run N」** | **全廃**（開発機ローカルの座標で参加者に無意味） |

**識別と表示は別**：シナリオのキーは `runDir`（`--repeat` で (regime, seed) が重複しうるし、セグメントは同じ時刻ラベルを共有しうる）。ラベルでキーにすると 6 セグメントが 1 つに潰れて評価区間が混ざる。

## 9.10 i18n

`dashboard/src/i18n/`（locale ストア + 全文言辞書 `messages.ts`）。ヘッダのトグルで切替、localStorage 永続、既定はブラウザ言語。`<html lang>` も追従する。

**データ層のビルダー（`venuePanels` / `runsProvider` の tape・建玉表）も `t()` を呼ぶ**ため、`useSnapshot` が key に locale を含めて言語切替でスナップショットを再構築する。

文言の規律：

- 実装語彙（ファイル名・ADR 番号）は**運営者向けの ？（`/explorer` のデータの出所。公開ビューでは出さない）以外に出さない**
- 単位は必ず添える（bps・USDC）
- 状態語は **live・finished の 2 語**
- `npm run` コマンドは explorer 起動などローカル運用文脈のみ

## 9.11 Blockscout 連携

起動していれば tx / block / address が deep link になり、indexer の高さが RPC の高さと併記される。**落ちていればリンクだけ消える**（機能は劣化しない）。

`/explorer` は接続状態を明示し（indexed 高さ / 落ちていれば起動コマンド）、検索が tx hash・block・address・**エージェント名**（→ wallet address。Blockscout は名前を知らない）を解決する。Blockscout が無くてもローカル一覧のフィルタとしては効く。

## 9.12 開発用

`VITE_DATA_PROVIDER=seed` でフィクスチャデータに切り替わる（`dashboard/src/data/seed.ts`）。seed プロバイダには順位が存在しないので、そう表示する。
