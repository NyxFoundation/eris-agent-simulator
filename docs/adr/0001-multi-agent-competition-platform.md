# ADR 0001: 多エージェント競争プラットフォーム — 環境の「識別力」を主軸に（sim で検証 → testnet で開催）

## Status

Accepted

## 用語

| 用語 | 意味 |
|------|------|
| **コンペ（競争プラットフォーム）** | 多数のエージェントが多様な戦略で参加し、競って順位がつくイベント／基盤 |
| **競争シミュレーション環境**（短縮: 競争環境） | エージェントが同時に走る市場の実行環境（app・seed・flow-bot で構成） |
| **識別力（discrimination power）** | 環境が**戦略の実力差を結果（PnL/Sharpe）の差として安定に表せる度合い**。強い戦略が安定して上位なら高い。全員横並び／毎回順位がランダムなら低い |
| **ベースライン** | 実力ゼロの基準エージェント（`noop`＝何もしない、`random`＝でたらめ）。識別力の物差し |
| **sim** | Anvil で Arbitrum をフォークしたシミュレーション。**識別力の検証・調整の場（自前 agent を走らせる）** |
| **testnet** | テストネットの実チェーン。**実際のコンペ開催の場**（実署名・実ガス・実 RPC・test 資金） |
| **provider 抽象** | RPC 接続先を差し替える層。sim（Anvil fork）／testnet を同一インターフェースで扱う |
| **走行（run）** | 1 回のシミュレーション実行 |
| **coordinator** | RPC・市場・順序付け・tx 提出を独占する中央コンポーネント（`src/coordinator.ts`） |
| **agent** | 戦略を実行するプロセス。判断と未署名 tx 生成のみを担い、RPC には触れない |
| **flow / flow-bot** | 市場に注文を流して相場を動かすマーケットメイク用プロセス（`examples/flow/market-maker.ts`）。**識別力に直結し、コンペの市場機会を作る** |
| **fair price** | coordinator が持つ理論価格。勝敗判定の価値計算に使う |
| **sim-loop** | シミュレータの仕組み（公平性・順序付け・ガスモデル・**識別力**）を 1 課題ずつ改善する既存 skill |
| **strategy-evolve / claude-llm** | 戦略を磨く／生成する既存の自己改善ツール（本 ADR では**二次**） |

> tx 構築の再設計（playbook 駆動の決定論 skill 層）は **別 ADR 0002** に切り出す。本 ADR では扱わない。

## Context

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータである。

**運用像**: 多数のエージェントが多様な戦略で競う**コンペを実際に開催**する。開催面は **testnet**（実チェーンだが test 資金）。順位（PnL/Sharpe）で勝者を決める。

**今すぐ確かめたいこと（最優先）**: コンペ成立の前提として、**現在の環境（app・seed・flow-bot）で多様な戦略を走らせたとき、エージェント間に有意な優劣がつくか** ＝ 環境に**識別力**があるか。識別力が無ければ（全員横並び／順位が運次第）、コンペは「運で優勝者が決まる」無意味なものになる。**この検証は sim（自前 agent）で行う**。

現状:

- **プロセス分離 / coordinator 集約**: coordinator が RPC・fair price・順序付け・tx 提出・mine を独占し、agent / flow-bot は stdin/stdout の行 JSON だけで通信する。**agent は RPC に触れない**（公平性、priority-fee オークションの土台）。この不変条件は testnet でも維持する。
- **環境を直す道具がある**: `sim-loop`（仕組み・公平性・識別力を改善）。多様な戦略ロスター（`agents.evolve.json` 等）とベースライン（`noop`/`random`）。
- **`sim-loop` の診断に識別力の項目が既にある**: 「全 agent が同じ Sharpe レンジ → 戦略差なし」「同一機会で勝者が常に 1 体 → 多様性なし」「arb 機会が薄い／フロー過小」。

### 解決したい課題

1. **多様なエージェントが競うコンペを testnet で開催したい。**
2. **環境に識別力があるかを sim（自前 agent）で検証し、無ければ確保したい**（実力差が順位差として安定に出るか）。← 最優先
3. リアルさを保ちつつ識別力を確保したい（どちらかに振り切らない）。

### 検討した選択肢（開催・検証の戦略）

- **選択肢A: sim だけで完結**（testnet で開催しない）
- **選択肢B（採用）: sim で識別力を検証・調整 → testnet で開催**
- **選択肢C: 最初から testnet だけ**（sim 検証なし）

### 各選択肢の評価

| 観点 | A sim のみ | B sim→testnet（採用） | C testnet のみ |
|------|----------|---------------------|---------------|
| 反復速度（識別力の作り込み） | **高** | **高（sim で反復）** | 低（実チェーンは遅い） |
| 安全性（実損失） | **高** | 高（test 資金） | 中 |
| リアルさ（本番の実在性） | 低（本番が無い） | **高（testnet 本番）** | 高 |
| 識別力の検証しやすさ | **高（決定論）** | **高（sim で検証）** | 低（非決定で測りにくい） |
| sim↔本番の乖離リスク | — | あり（要差分検証） | なし |

## Decision

**採用案（一文）**: 多エージェント競争プラットフォームを構築する。中心要件は競争環境の「識別力」であり、**sim（Anvil fork・自前 agent）で識別力を検証・確保**し、**testnet で実際のコンペを開催**する。リアルさと識別力は**バランス**（識別力に下限を置きつつ現実性を保つ）。RPC は coordinator が独占（no-RPC 維持）、sim↔testnet は provider 抽象で切り替える。tx 構築の skill 化（ADR 0002）と戦略の自己改善（strategy-evolve/claude-llm）は本 ADR のスコープ外／二次。

### A-1. 競争環境の「識別力」を一級要件にする（主軸）

- **定義**: 環境が、戦略の実力差を結果（PnL/Sharpe）の差として**安定に**表せること。
- **検証（sim・自前 agent）**: 多様な戦略 ＋ **ベースライン（`noop`/`random`）** を 1 市場で走らせ、複数 seed で集計し:
  - **賢い戦略 ≫ ベースライン** の差が出るか（出なければ実力を報酬していない）。
  - 上位↔下位の **gap が seed をまたいで安定**して開くか（毎回入れ替わるならノイズ）。
  - 全 agent が同じ Sharpe レンジに潰れていないか。
- **改善**: 不足したら **`sim-loop`** で環境（flow-bot 強度・手数料/ガス・arb 機会サイズ・順序付け）を 1 課題ずつ調整。
- **リアルさとのバランス**: 識別力には**下限**を設けるが、それを満たしたら以降は**現実性を優先**する（識別力を上げるために環境を非現実的・攻略可能にしない）。

### A-2. 2 環境を provider 抽象でつなぐ（sim 検証 → testnet 本番）

- **sim（Anvil fork）**: 識別力の検証・調整の場。自前 agent ＋ ベースライン。決定論（同一 seed=同一市場）で反復しやすい。
- **testnet**: 実際のコンペ開催。実署名・実ガス・実 RPC（test 資金）。`submit`/`settle` は実チェーンの確定処理になる。
- 両者は **provider 抽象**で切り替え、agent・戦略コードは不変。**flow-bot は testnet でも稼働**させ、コンペの市場機会を作る。
- sim で確保した識別力が testnet に移るとは限らないため、**testnet 移行時に識別力を再検証**する（下記 Risk）。

### A-3. 役割分担: coordinator と agent（no-RPC、sim/testnet 共通）

| 関心事 | 呼ぶ主体 | RPC | 備考 |
|--------|---------|-----|------|
| 観測作成 | **coordinator** | あり | agent に RPC を渡さない＝公平性維持 |
| 未署名 tx 生成 | **agent** | なし | 戦略判断の出力。tx 構築の中身は ADR 0002 |
| 署名・順序付け・提出・確定 | **coordinator** | あり | 署名鍵を 1 箇所に隔離。testnet では実署名/実ガス |

### A-4. 競争評価 = 多様な agent ＋ ベースラインを 1 市場で、PnL/Sharpe で順位

- 全 agent 同一の初期インベントリ・`limits`・同一市場・同一ラウンド数（公平条件）。
- **複数 seed を `scripts/evaluate.ts` で集計**して識別力と順位を判定（単一走行の `leaderboard.ts` は目視用）。
- 公平性と識別力は別概念で両方必要（公平でも機会ゼロなら識別力は低い）。

### A-5. スコープ外 / 二次

- **tx 構築の skill 化（playbook/build skill）** → **別 ADR 0002**。
- **戦略の自己改善**（`strategy-evolve`＝磨き込み、`claude-llm`＝生成）→ 二次。識別力ある環境が整ってから。
- **untrusted な外部 agent の安全対策**（サンドボックス・DoS・談合）→ 当面スコープ外（sim 段階は自前 agent のみ）。外部参加の testnet コンペを開く段階で別途設計。

## Incremental Migration

| フェーズ | 内容 | 環境 | 主な道具 |
|---------|------|------|---------|
| **P1（識別力の検証と確保）** | 多様な戦略＋ベースラインを多 seed で実走 → 識別力判定 → 不足なら環境調整 | **sim** | `evaluate` / `sim-loop` |
| **P2（testnet 配備）** | provider を testnet に切替、coordinator の実署名/実ガス/`settle`、flow-bot を testnet 稼働。自前 agent で動作・識別力を再検証 | **testnet** | provider 抽象 |
| **P3（コンペ運営）** | 多様な agent で本番運営。外部参加・untrusted 安全対策は別途設計 | **testnet** | — |

### P1 の受け入れ条件（acceptance criteria）

**対象ロスター**: 多様な戦略（`arb` / `gmx-rev` / `cvbal` / `dn-lp`）＋ **ベースライン（`noop` / `random`）**（いずれも自前）。

**実行**:
```bash
SEEDS=1,2,3 ROUNDS=128 AGENTS_CONFIG=<diverse+baseline>.json npm run evaluate --silent 2>err.log | tee /tmp/eval.json
```

**識別力の合否**:
1. **賢い戦略の median PnL/Sharpe が `noop`/`random` を明確に上回る**。
2. **上位↔下位の gap が seed をまたいで安定**（順位が seed ごとに総入れ替えなら不合格）。
3. 全 agent が同一 Sharpe レンジに潰れていない。

**不合格時**: `sim-loop` で原因（フロー過小・手数料/ガス過大・機会が薄い・勝者総取り等）を 1 つずつ特定し環境を調整、再判定。**識別力の下限を満たしたら、それ以上は現実性を優先**して止める。

## Consequences

### Positive

- **コンペの妥当性を担保**: 識別力を一級要件にするので、順位が運でなく実力を反映する。
- **安全・高速に土俵を作れる**: 識別力の作り込みは sim で反復、本番は testnet（実損失なし）。
- **公平性を維持**: no-RPC・coordinator 集約を sim/testnet 共通で保つ。
- **焦点が明確**: tx skill 層・自己改善を分離し、本 ADR は「コンペ＋識別力」に集中。
- **既存資産を活かせる**: P1 は `evaluate`＋`sim-loop`＋既存ロスター/ベースラインで成立。

### Negative

- **sim↔testnet の二重運用コスト**（provider・flow-bot・確定処理の差）。
  - → provider 抽象を同一契約に強制。testnet 固有（実ガス・nonce・確定待ち）は薄い差分層に閉じ込める。
- **識別力の確保に試行錯誤が要る**（環境調整は 1 課題ずつで遅い）。
  - → `sim-loop` の before/after で定量管理。識別力 KPI を固定する。

### Risks

- **sim で確保した識別力が testnet に移らない**（実ガス・他トランザクション・非決定性・約定差）。
  - → P2 で **testnet 上で識別力を再検証**。乖離が大きければ sim の環境前提を修正。
- **識別力と公平性の取り違え**（条件を揃えただけで「良い土俵」と誤認）。
  - → 必ずベースラインを入れ、「賢い ≫ noop/random」を必須条件にする。
- **識別力の上げすぎで非現実・攻略可能化**。
  - → A-1 の「下限を満たしたら現実性優先」で歯止め。
- **非定常性**（多戦略同時で順位がぶれる）。
  - → 多 seed 集計でノイズを吸収。gap の**安定性**まで見る。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| 識別力の定量しきい値（gap を何で・どれだけ開けば合格か） | 実データが無いと決められない | P1 の実走データを見て |
| 識別力不足時の環境調整の優先順位（flow 強度／手数料／機会サイズ） | 原因が実データ依存 | P1 の診断後（sim-loop で） |
| testnet の選定・flow-bot の testnet 稼働方式・実ガス/確定の扱い | sim で識別力を固めてから | P2 |
| 外部参加（untrusted agent）の安全対策（サンドボックス・DoS・談合・不正） | 当面は自前 agent のみ | 外部参加コンペを開く段階 |
| 戦略の自己改善（strategy-evolve/claude-llm）の接続 | 識別力確保が先 | P3 以降 |
| tx 構築の skill 化 | 関心が別 | **ADR 0002** |
| ランキング指標の詳細（評価ホライズン・PnL か risk-adjusted か・判定用 holdout seed） | P1 のデータを見て | P1 後 |

## Notes

### 参考資料

- `.claude/skills/sim-loop/SKILL.md` — 環境の仕組み・**識別力**を改善する主役ツール。
- `.claude/skills/strategy-evolve/SKILL.md`・`TEMPLATE-DESIGN.md` — 二次の戦略自己改善とテンプレ化。
- 既存実装: `scripts/evaluate.ts`（多 seed 集計）、`scripts/leaderboard.ts`（単一走行順位）、`examples/agents/{noop,random}.ts`（ベースライン）、`agents.evolve.json`（多様な戦略）、`examples/flow/market-maker.ts`（flow-bot＝識別力に直結）、`src/cli/anvil.ts`（fork・`FORK_BLOCK_NUMBER`）、`src/coordinator.ts`（RPC/順序付け/submit）。
- `CLAUDE.md` — 現状のプロセス分離・coordinator 集約。
- **ADR 0002（予定）** — tx 構築の playbook/build skill 化（defi-skills 参照）。
