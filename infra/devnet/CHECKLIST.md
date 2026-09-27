# 練習 devnet 安定稼働チェックリスト

練習 devnet が「チェーン・環境・参加者役 agent（LLM を含む）・ダッシュボード」の 4 つで安定して
動くことを確かめる手順。用語（環境 / flow bot / 参加者役 agent / カナリア / 受け入れチェック /
定常点検 / 環境の失敗 / 市場の警告）はリポジトリ直下の [CONTEXT.md](../../CONTEXT.md) に定義がある。

| 段 | どこで | 長さ | 実行者 |
|---|---|---|---|
| [1. リハーサル](#1-リハーサル26h) | on-demand EC2 × 2（非公開） | 26h | Claude |
| [2. 本番短縮版](#2-本番短縮版約-1h) | 本番 box | 起動から最初の 2 評価区間（約 1h） | devnet 運用担当者 |
| [3. 定常点検](#3-定常点検) | 本番 box | 毎日（切替の後に 5 分）+ 毎週 | devnet 運用担当者 |

**使い方**: 実施のたびに GitHub issue を 1 本立て（題: `devnet 受け入れ <段> <日付> (<commit>)`）、
該当する節をそのまま貼って、チェックと `記録:` 欄を埋める。runbook 自体は書き換えない。直すべき点が
見つかったら PR で直す。

**前提**: 起動時に登録ファイルを読む修正（#146）が入った commit で行う。入っていないと、登録ファイルから入る
参加者が新しい competition の初日に採点されない（1.6 と 2.3 がそれを検出する）。

**なぜリハーサルが先か**: coordinator の再起動は新しい competition を開く（順位表が割れる。
[README](README.md#a-restart-is-a-new-competition-on-purpose)）。本番で試して落ちると、直してもう 1 回
再起動することになる。

---

## 0. 合否の読み方

各項目は **内側**（box の中: anvil の RPC・`runs/`・systemd・exporter）と **外側**（参加者と同じ経路:
gateway 経由の RPC・公開ダッシュボード）の 2 欄で見る。内側は原因を、外側は症状を示す。以前、内側が
全部正常なのに、公開ビューだけが期間中ずっと `blocks 0–0` だったことがある（issue #84 A）。

| 対象 | 合格 | 記録するだけ |
|---|---|---|
| チェーン | 平均ブロック間隔が 2 秒 ±5%、かつダンプごとの最大間隔が伸びない（観察期間での伸びが 1 秒未満） | 最大間隔の絶対値、anvil のメモリ、ダンプのサイズ |
| 環境 | **環境の失敗 0 件**。oracle が毎ブロック書き、flow bot が毎時間出している | 市場の警告の件数 |
| 参加者役 agent | プロセスが観察期間中に落ちない。自己改訂型は改訂が**毎時間 1 回以上完了**し、LLM 呼び出しの失敗が改訂の **10% 未満**。カナリアの取引が**毎時間 1 件以上**着弾する | decide timeout の件数、直結とプロキシ経由の失敗率の差、成績（見ない） |
| ダッシュボード | 公開ビューで、参加者が見るものが揃っていて、漏れてはいけないものが漏れていない | `index.json` の応答時間 |

**不合格のとき**

| 不合格の種類 | リハーサル | 本番 |
|---|---|---|
| チェーン・環境・参加者役 agent | 直してから 26h を最初からやり直す（時間とともに悪化する種類が多く、直した項目だけ見ても分からない） | 直して再起動する（新しい competition。Discord で告知） |
| ダッシュボードだけ | 走らせたまま直した版に差し替え、その項目だけ再確認する（ダッシュボードは状態を持たない） | 同左 + Discord で告知 |
| リハーサル基盤の障害（SSH トンネルが切れた、EC2 の障害） | devnet の不合格ではない。記録して復旧し、影響した時間帯を判定から外す | — |

---

## 共通のコマンド

box 上のリポジトリのルート（本番は `~/workspace/eris-agent-simulator`）で使う。

```sh
# 期間ディレクトリ（current-segment を持つ最新の runs/<id>）と、今のセグメント
P=$(for d in $(ls -td runs/*/); do [ -f "$d/current-segment" ] && { echo "${d%/}"; break; }; done)
S="$P/$(cat "$P/current-segment")"

# 環境の失敗: 1 行も出なければ合格
envfail() { sed -nE 's/^\{"ts":"[^"]*","type":"([a-z0-9_]+)".*/\1/p' "$@" \
  | grep -E '(_failed|_stuck|_reverted|_incomplete|_exhausted|_capped)$|^(realtime_block_error|agent_process_exited)$' \
  | sort | uniq -c; }

# 市場の警告: 件数を記録する
warnings() { sed -nE 's/^\{"ts":"[^"]*","type":"([a-z0-9_]+)".*/\1/p' "$@" \
  | grep -E '_warning$|^flow_guard$' | sort | uniq -c; }

# 時間ごと（1,800 ブロック = 1h）の: system 行のあるブロック数 / flow bot の tx 数 / カナリアの着弾数
hourly() { awk -F, -v id="${1:-ops-canary}" 'FNR>1 {
    h = int($2 / 1800); if (min == "" || h < min) min = h; if (h > max) max = h
    if ($9 == "system" && !seen[$2]++) sys[h]++
    if ($9 ~ /flow$/) flow[h]++
    if ($8 == id && $7 == "success") can[h]++
  } END { print "hour system-blocks flow-tx canary-tx"
          for (h = min; h <= max; h++) printf "%d %d %d %d\n", h, sys[h]+0, flow[h]+0, can[h]+0 }' \
  "$P"/*/blocks.csv; }
```

- **チェーンの判定**は `node infra/devnet/block-gaps.mjs --rpc <RPC> --from <開始ブロック>`。
  全ブロックのタイムスタンプを読み、平均間隔と「5 分窓ごとの最大間隔の伸び」を PASS / FAIL で出す
  （exporter の `ascon_block_interval_seconds` は 10 秒に 1 回の標本なので、ダンプ中の数秒の停止を
  ほとんど取りこぼす）。
- **自己改訂型の判定**は `node infra/devnet/revision-health.mjs <ERIS_RUN_DIR>/agents`。agent を
  動かしたマシンで実行する（判断ログは参加者側にしかない）。
- `hourly` の最初と最後の行は端数の時間なので、判定から外す。

---

## 1. リハーサル（26h）

### 1.1 構成

**EC2 A（box）**: 本番と同じ compose（`infra/monitoring`）と systemd unit を、本番に入れる commit で
動かす。本番 box はベアメタルなので同じ型は無い。**本番 box の `nproc` と `free -g` 以上**の on-demand
インスタンスを選ぶ（例: 8 コア / 96 GB の `amd-ryzen-9700x` なら `r7a.4xlarge` = 16 vCPU / 128 GB）。
spot は使わない（26h の途中で回収されるとやり直しになる）。

**EC2 B（agent ホスト）**: 参加者役 agent 7 体と推論プロキシ。`m7a.2xlarge` 程度。A と同じリージョン。
A の gateway（`127.0.0.1:8546`）へは SSH トンネルで繋ぐ（compose を変えずに「box の外」を作る）。
Cloudflare Access の段はリハーサルには無い。本番短縮版で確かめる。

**参加者役 agent（B で動かす）**。全員 `participant: operator`。LLM は全員 Ollama Cloud の `glm-5.3-flash`、
改訂は既定の 60 ブロックごと。直結とプロキシ経由を同じ元戦略どうしで並べるので、プロキシ経由の側だけが
落ちれば原因はプロキシだと切り分けられる。

| id | `ERIS_AGENT_DIR` | 種類 | LLM の経路 | 登録 |
|---|---|---|---|---|
| `ops-canary` | `example/agents/canary` | カナリア（ルール型） | — | 開始時 |
| `ops-venue-d` | `example/agents/venue-arb` | 自己改訂型 | Ollama 直結 | 開始時 |
| `ops-venue-p` | `example/agents/venue-arb` | 自己改訂型 | 推論プロキシ経由 | 開始時 |
| `ops-multi-d` | `example/agents/multi-arb` | 自己改訂型 | Ollama 直結 | 開始時 |
| `ops-multi-p` | `example/agents/multi-arb` | 自己改訂型 | 推論プロキシ経由 | 開始時 |
| `ops-venue-frozen` | `example/agents/venue-arb` | frozen 対照（`ERIS_AGENT_FROZEN=1`） | — | 開始時 |
| `ops-late` | `example/agents/canary` | 途中登録（ルール型） | — | 開始 3h 後 |

**seed と長さは本番と別**: `.env.practice` は新しく引く（同じ seed だと、リハーサルの成果物から本番の
窓が逆算できる）。長さは `--blocks 46800`（2 秒 × 46,800 = 26h。24h で切替 1 回 + 2 日目 2h）。
2 日目を 2h 取るのは、途中登録の agent が 2 日目に採点されるところまで見るため（採点は翌日の最初の
境界から、順位には境界 2 つ = 約 1h で入る）。

### 1.2 準備

**A（box）**

- [ ] commit を固定する。`git rev-parse HEAD` → 記録: `commit=`。A には sync timer
  （`eris-dashboard-sync`）を入れない（入れると 26h の途中で commit が動く）
- [ ] `npm run dashboard:build`（compose は `dashboard/dist` を配信するだけで、ビルドはしない）
- [ ] 本番 box と同じ手順で立てる: [infra/provision](../provision/README.md) の "Order of operations"
  2〜4（`npm ci`、`setup-vendors.sh`、deploy、`npm run gen:state-dump`、`docker compose up -d`）。
  `grafana/secret.env` に **Slack トークンは入れない**（本番チャンネルに流さない。アラートは Grafana の
  Alerting 画面で見る）
- [ ] 参加者キーを発行し、gateway に読ませる:
  `infra/access/issue-key.sh --generate 8` → `infra/monitoring/.env` の `ASCON_KEYS_DIR`
- [ ] seed: [README](README.md#install-once-on-the-box-that-hosts-it) のとおり `.env.practice` を作る
- [ ] 長さの上書き（unit の drop-in）:
  ```sh
  mkdir -p ~/.config/systemd/user/ascon-devnet.service.d
  cat > ~/.config/systemd/user/ascon-devnet.service.d/rehearsal.conf <<'EOF'
  [Service]
  ExecStart=
  ExecStart=/usr/bin/env npm run sim:realtime -- --config config/practice.yaml --seed ${ERIS_PRACTICE_SEED} --blocks 46800
  EOF
  systemctl --user daemon-reload
  ```
- [ ] `config/registrations.yaml` に、開始時に登録する 6 体（上の表）を書く。形は
  [config/registrations.example.yaml](../../config/registrations.example.yaml)
- [ ] 前提 2 つを測る（agent を繋ぐ前に。[practice-devnet](../../docs/guide/practice-devnet.md#running-a-period)）:
  `npm run check:ordering -- --live --rounds 5` / `npm run stress:rpc -- --agents 30 --seconds 60 --write`
  → 記録: 両方の結果

**B（agent ホスト）**

- [ ] 同じ commit を checkout して `npm ci`。`sdk/src/constants.local.ts` を A からコピーする
  （アドレス表は deployment ごとに違う）
- [ ] A へのトンネル（切れても張り直す）:
  ```sh
  while true; do ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -L 8546:127.0.0.1:8546 -L 5174:127.0.0.1:5174 <A>; sleep 5; done &
  ```
- [ ] マニフェスト（A で作って B に置く）:
  `npm run manifest -- --config config/practice.yaml --public-rpc http://127.0.0.1:8546`
- [ ] 鍵を 7 本作る（[practice-devnet §1](../../docs/guide/practice-devnet.md#1-create-a-wallet-and-register-its-address)
  の viem ワンライナー）。アドレスを A の `config/registrations.yaml` に書く（`ops-late` は 3h 後まで書かない）
- [ ] Ollama が答えるか、時間も測る（API 経由の LLM 呼び出しは 60 秒で timeout）:
  ```sh
  time curl -s https://ollama.com/api/chat -H "Authorization: Bearer $OLLAMA_API_KEY" \
    -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"reply with {}"}],"format":"json","stream":false}'
  ```
  → 記録: 所要秒数
- [ ] 推論プロキシ（B の localhost だけで待ち受ける。公式競技でも agent とプロキシは同じ側にある）:
  ```sh
  cp infra/inference-proxy/models.example.yaml infra/inference-proxy/models.yaml
  #  models: を 1 件にする → { name: glm-5.3-flash, provider: ollama, upstream: https://ollama.com/api, apiKeyEnv: OLLAMA_API_KEY }
  export ERIS_INFERENCE_SECRET="$(openssl rand -hex 32)"
  nohup npm run inference-proxy -- --models infra/inference-proxy/models.yaml \
    --listen 127.0.0.1:8790 --record ./ops-inference > ops-proxy.out 2>&1 &
  curl -s http://127.0.0.1:8790/healthz
  # agent ごとのトークン（通常は coordinator が配るが、外部 agent には配られない）
  node -e 'console.log(require("crypto").createHmac("sha256", process.env.ERIS_INFERENCE_SECRET).update(process.argv[1]).digest("hex"))' ops-venue-p
  ```
- [ ] agent ごとの env ファイル `ops-agents/<id>.env`（`ops-late` は `ops-agents-late/` に分けておく）:
  ```sh
  ERIS_MANIFEST=./manifest.json
  ERIS_AGENT_ID=ops-venue-p
  ERIS_AGENT_DIR=example/agents/venue-arb
  ERIS_AGENT_PRIVATE_KEY=0x…
  ERIS_RUN_DIR=./ops-logs
  # gateway のキー。runtime は CF の 2 ヘッダとこの JSON しか送らない（sdk/src/chain.ts）。
  # 単一引用符が要る: 無いと . で読んだときにシェルが二重引用符を剥がして JSON でなくなる
  ERIS_RPC_HEADERS='{"X-ASCON-Key":"…"}'
  # 自己改訂型だけ
  ERIS_LLM_MODEL=glm-5.3-flash
  ERIS_IMPROVE_LOG_CALLS=1
  # 直結（-d）: OLLAMA_API_KEY=…
  # プロキシ経由（-p）: ERIS_INFERENCE_BASE_URL=http://127.0.0.1:8790 と ERIS_INFERENCE_TOKEN=<上のトークン>
  # frozen 対照: ERIS_AGENT_FROZEN=1（LLM の行は要らない）
  ```

### 1.3 起動直後（T+0〜1h）

A で `systemctl --user enable --now ascon-devnet`、登録が取り込まれたのを見てから（下の 3 つ目）、
B で agent を起動する:

```sh
mkdir -p ops-logs
for f in ops-agents/*.env; do id=$(basename "$f" .env)
  ( set -a; . "$f"; set +a; nohup node --import tsx example/agents/runtime/bot.ts > "ops-logs/$id.out" 2>&1 & )
done
```

- [ ] **チェーン（内側）**: `cast block-number --rpc-url http://127.0.0.1:8545` を数秒あけて 2 回。
  → 記録: 開始ブロック `from=`（1.7 の判定で使う）
- [ ] **チェーン（外側）**: B からトンネル経由で、キーありの `eth_blockNumber` が 200、キーなしが
  `missing or unknown X-ASCON-Key`、`anvil_setBalance` が `method not permitted`
- [ ] **環境**: `$S/events.jsonl` に `run_started_realtime`（`runBlocks: 46800`）/ `agents_ready`
  （late・exited が 0）/ `lst_setup`（`reserveCoversRun: true`）/ `stress_schedule` がある
- [ ] **環境**: `agent_external_registered` が 6 件（`registrations_reloaded` も出ている）。
  B から各アドレスの `eth_getBalance` が 0 でない
- [ ] **環境**: `initial_endowment` の `ratio` が 2 以下 → 記録: `ratio=`
- [ ] **環境**: `envfail "$P"/*/events.jsonl` が何も出さない
- [ ] **参加者役 agent**: 開始時の 6 体の `ops-logs/<id>.out` に起動エラーが無く、`ops-logs/agents/<id>.jsonl`
  に `runtime_start` がある（無いのは preflight で落ちたということ）
- [ ] **参加者役 agent**: `hourly ops-canary` でカナリアが着弾している（blocks.csv の `ownerId` が
  agent の id、role が `agent`）
- [ ] **参加者役 agent**: 自己改訂型 4 体に最初の `revision …` 行がある（60 ブロック ≈ 2 分後から）。
  プロキシ経由の 2 体は `ops-inference/<id>.jsonl` に行があり、直結の 2 体には無い
- [ ] **ダッシュボード**（B のトンネル経由の `http://127.0.0.1:5174`）: `/runs/mode.json` が audience、
  `/runs/index.json` に期間が live で出る、盤面のブロック高が進む。
  **目視**: picker に期間が出て、評価区間のバーが進む

### 1.4 途中登録（T+3h）

- [ ] A の `config/registrations.yaml` に `ops-late` を追記する。約 1 分以内に `agent_external_registered`
  が出て、残高が入る
- [ ] B で `ops-agents-late/ops-late.env` を起動し、`hourly ops-late` に着弾が出る
- [ ] 記録: 登録したブロックと時刻

### 1.5 期間中（6h ごと: T+6h / 12h / 18h）

- [ ] Grafana（A の `:3000`）の Alerting で firing が 0 → 記録: firing があれば名前と時刻
- [ ] `envfail "$P"/*/events.jsonl` が何も出さない
- [ ] `hourly`: 端数を除く全時間で system-blocks ≥ 1,700 / flow-tx > 0 / canary-tx ≥ 1。
  flow bot のプロセスが落ちてもイベントは出ないので、flow-tx の列が唯一の検出手段
- [ ] B: `pgrep -fa runtime/bot.ts | wc -l` が 7（途中登録の後）、プロキシが `/healthz` に答える
- [ ] 資源の記録（伸び方を本番の 1 か月に外挿するため）:
  ```sh
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' ascon-anvil
  docker exec ascon-anvil ls -l /chainstate/state.json      # ダンプのサイズ
  df -h / ; du -sh "$P"
  ```
  → 記録: 時刻・anvil のメモリ・ダンプのサイズ・ディスク使用量・`$P` のサイズ

### 1.6 セグメント切替（T+24h）

- [ ] `$P/current-segment` が新しい日（`…-s01`）を指し、前日のディレクトリに `summary.json` がある
- [ ] 新しいセグメントの `events.jsonl` が、`run_started_realtime`（`segment` / `previousSegment` 付き）/
  `agents_registered` / `stress_schedule` で始まり、`manifest.json` もある（2 日目以降も揃うこと）
- [ ] 評価区間の継ぎ目: 前日の `intervals.jsonl` の最後の `index` と、今日の最初の `index` が、同じ
  （途中で切り替わった場合）か +1（境界ちょうどで切り替わった場合）。それ以外は区間の欠落か二重計上
- [ ] exporter が新しい日を追っている: Grafana で `ascon_interval_index` が -1 になっていない
- [ ] 前日の `summary.json` で、開始時に登録ファイルにいた 6 体は採点されていて（`scored: false` でない）、
  途中登録の `ops-late` だけが `scored: false` + `unscoredReason` を持ち、`netPnlUsdc` のフィールド自体が
  無い（0 に潰されていない。issue #84 X2）。開始時の 6 体が未採点なら、起動時に登録ファイルを読む修正が
  入っていない
- [ ] **ダッシュボード**: `/runs/index.json` に 2 日分が出る。**目視**: picker が新しい日に移り、前日の順位が
  出て、`ops-late` だけが「未採点」と出る（0 として並んでいない）

### 1.7 終了（T+26h）

- [ ] unit が `failed` ではなく正常終了している（`systemctl --user status ascon-devnet`）。最後のセグメント
  にも `summary.json` がある
- [ ] **チェーン**: `node infra/devnet/block-gaps.mjs --rpc http://127.0.0.1:8545 --from <1.3 の from>`
  が 2 行とも PASS → 記録: 平均間隔・伸び・最大間隔とそのブロック
- [ ] **環境**: `envfail "$P"/*/events.jsonl` が何も出さない。`warnings "$P"/*/events.jsonl` → 記録
- [ ] **環境**: `hourly` の全時間（端数を除く）で、system-blocks ≥ 1,700 / flow-tx > 0
- [ ] **参加者役 agent**: B で `node infra/devnet/revision-health.mjs ops-logs/agents` が 4 体とも PASS
  → 記録: 表をそのまま貼る（直結とプロキシ経由の失敗率の差も見る）
- [ ] **参加者役 agent**: `hourly ops-canary` と `hourly ops-late`（登録後）の全時間で canary-tx ≥ 1。
  7 体とも `ops-logs/<id>.out` に異常終了が無い
- [ ] **参加者役 agent**: 2 日目の順位に `ops-late` が入っている（データでは、2 日目の `intervals.jsonl`
  に V_0 を持って載っている）
- [ ] **ダッシュボード**: 下の「漏れの検査」を `BASE=http://127.0.0.1:5174` で全部通る
- [ ] **ダッシュボード**: `curl -s -o /dev/null -w '%{time_total}\n' "$BASE/runs/index.json"`
  → 記録: 秒数
- [ ] 資源: 1.5 と同じものを記録し、anvil のメモリの傾きから 35 日後の値を見積もる → 記録

**漏れの検査**（公開ビュー。`SEG=<期間 id>/<セグメント>`、`HEAD` は今のブロック番号）

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/runs/$SEG/agents/noop.jsonl"        # 404
curl -s "$BASE/runs/$SEG/events.jsonl" | grep -c '"seed":\|"flowSeed":'              # 0
curl -s "$BASE/runs/$SEG/events.jsonl" | grep -c '"type":"stress_calibration_warning"'   # 0
curl -s "$BASE/runs/$SEG/events.jsonl" | node -e '
  let bad = 0; const head = Number(process.argv[1]);
  require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
    try { const e = JSON.parse(l); if (e.type !== "stress_schedule") return;
      for (const w of e.events ?? []) if ((e.runStartBlock ?? 0) + w.endBlock > head) bad++;
    } catch {} }).on("close", () => { console.log(bad ? `FAIL: ${bad} future window(s)` : "PASS: no future window"); });' "$HEAD"
```

### 1.8 片付け

- [ ] A の `runs/` と B の `ops-logs/` `ops-inference/` を tar で手元に回収し、issue に置き場所を書く
- [ ] A と B を terminate する（鍵と seed はリハーサル専用なので捨ててよい）
- [ ] 判定: 全項目合格なら **go**。issue に commit を書き、本番短縮版はこの commit で行う

---

## 2. 本番短縮版（約 1h）

リハーサルに無かったもの（Cloudflare Access の段、本番の登録ファイルと実参加者、本番 box の資源、
公開 URL）だけを見る。

### 2.1 前提

- [ ] リハーサルの issue が go で、commit が書いてある
- [ ] 事前に Discord で告知する: 再起動で新しい competition になる / チェーンがリセットされるので
  **参加者は自分の agent を再起動する**（nonce と approve が消える。runtime は起動時にしか approve しない）/
  登録は引き継がれ、再登録は要らない（登録ファイルは起動時に読まれ、初日から採点される）

### 2.2 手順

- [ ] box の checkout が、リハーサルの commit と同じか、そこからの差分がダッシュボードと文書だけである:
  `git fetch && git diff --stat <commit>..origin/main`。box の checkout は sync timer が 5 分ごとに
  `origin/main` へ fast-forward するので（[infra/dashboard](../dashboard/README.md)）、`git checkout <commit>`
  で固定しても戻される。走っている coordinator は起動時のコードのままだが、unit が再起動すればその時点の
  main で起動する。差分に `core/` `sdk/` `example/` `infra/monitoring/` `config/` が入っていたら、
  その差分でリハーサルをやり直す
- [ ] deploy 鍵が公開テスト鍵でない: `grep AclAdmin sdk/src/constants.local.ts` が
  `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`（anvil の account 0）**ではない**（issue #74）
- [ ] 新しい seed を引く（新しい competition なので。[README](README.md#install-once-on-the-box-that-hosts-it)）
- [ ] **coordinator を止めてから**チェーンを触る（動いたまま volume を消すと、何も出さずに固まる。
  [README](README.md#resetting-the-chain-under-a-running-coordinator-wedges-it-silently)）:
  `systemctl --user stop ascon-devnet` → compose を新しい commit で上げ直す → exporter コンテナも
  同時に上げ直す（古い exporter は `intervals.jsonl` を読めない）→ `systemctl --user start ascon-devnet`
- [ ] 期間ディレクトリができたら `infra/monitoring/.env` に `ERIS_DASHBOARD_COMPETITIONS=<期間 id>`
  を書き、dashboard コンテナを上げ直す（公開 picker に smoke run を出さない。issue #84 K）
- [ ] カナリアを登録する（`id: ops-canary`、`participant: operator`、登録ファイルへ追記。初回だけ。
  2 回目以降の再起動では登録ファイルに残っている）
- [ ] カナリアを box の**外**で動かす。小さな on-demand EC2（t3.small 程度）に常駐させる。checkout は box と
  同じ commit、`sdk/src/constants.local.ts` は box からコピー、マニフェストは
  `--public-rpc https://ascon-rpc.nyx.foundation/` で作る。env ファイルは 1.2 の形に
  `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` を足したもの（単一引用符はそのままでよい。systemd の
  EnvironmentFile も引用符を解釈する）。再起動のたびに `constants.local.ts` とマニフェストを作り直して
  unit を再起動する（チェーンのリセットで nonce と approve が消える）:
  ```ini
  # ~/.config/systemd/user/ascon-canary.service（loginctl enable-linger も要る）
  [Service]
  WorkingDirectory=%h/eris-agent-simulator
  EnvironmentFile=%h/ops-canary.env
  ExecStart=/usr/bin/env node --import tsx example/agents/runtime/bot.ts
  Restart=always
  RestartSec=30

  [Install]
  WantedBy=default.target
  ```

### 2.3 確認（T+0〜1h）

- [ ] **チェーン（内側）**: block number が 2 回とも進む
- [ ] **チェーン（外側）**: カナリアのマシンから、CF ヘッダ + キーありが 200 / キーなしが
  `missing or unknown X-ASCON-Key` / CF ヘッダなしが Cloudflare の 403 / `anvil_setBalance` が
  `method not permitted`（[infra/access](../access/README.md) の 4 つ）
- [ ] **環境**: `run_started_realtime` の `runEndsAt` が 10/31 23:59:59 JST、`lst_setup` が
  `reserveCoversRun: true`、`stress_schedule` がある、`envfail` が何も出さない
- [ ] **環境**: 登録ファイルの全員に `agent_external_registered` が出て、`registration_failed` が 0。
  最初の境界（`intervals.jsonl` の 1 行目）に全員の値がある（= 初日から採点される）→ 記録: 件数
- [ ] **環境**: 最初の 2 つの `interval_boundary` が出て、`interval_boundary_failed` が 0
- [ ] **参加者役 agent**: `hourly ops-canary` に着弾がある
- [ ] **ダッシュボード**（`https://ascon-dash.nyx.foundation`）: 漏れの検査（1.7）を全部通る。
  **目視**: picker に今の期間だけが出る、ブロックと評価区間が進む、カナリアの tx がメソッド名付きで出る、
  「Find your agent」がアドレスで引ける
- [ ] 判定: 全部通れば go。落ちたら 0 章の表どおり

---

## 3. 定常点検

**毎日（セグメント切替の後、5 分）**

- [ ] 新しい日のディレクトリがあり、`events.jsonl` の先頭に `run_started_realtime`（`previousSegment` 付き）/
  `agents_registered` / `stress_schedule`、`manifest.json` がある。前日に `summary.json` がある
- [ ] 前日分で `envfail "$P/<前日>/events.jsonl"` が何も出さない
- [ ] 前日分の `hourly` で canary-tx ≥ 1 / flow-tx > 0 / system-blocks ≥ 1,700（全時間）
- [ ] 公開ビューが新しい日に移り、前日の順位が出ている（目視）
- [ ] `journalctl --user -u eris-dashboard-sync --since yesterday` にビルドがあった日は、漏れの検査（1.7）
  をもう一度通す（ダッシュボードは main に追従していて、merge のたびに公開ページが変わる）

**毎週**

- [ ] anvil のメモリ: `ascon_anvil_mem_growth` が firing でない。`docker stats` の値を記録し、先週との差を見る
- [ ] ディスク: `df -h /`、`du -sh "$P"`、ダンプのサイズ → 記録
- [ ] LST: 最新の `lst_block` の `rewardRunwayBlocks` が null か、期間の残りブロック以上
  （尽きると `apyBps` が 0 になる。issue #129）
- [ ] flow bot の財布: 1 週間分で `flow_wallet_topped_up` が出ている（補充が回っている）。最新の
  `flow_balances` を記録する（issue #130）
- [ ] チェーン: 直近 24h で `block-gaps.mjs` が 2 行とも PASS

**アラートにする予定の項目**（別 PR。入ったら手動の項目から外す）

| 項目 | 今の検出手段 | 予定 |
|---|---|---|
| 環境の失敗 | `envfail`（手動） | exporter が件数を出し、`increase > 0` で通知 |
| flow bot の停止 | `hourly` の flow-tx（手動） | flow tx の増加が止まったら通知（プロセス終了のイベントも足す） |
| カナリアの停止 | `hourly` の canary-tx（手動） | カナリアの tx が 1h 増えなければ通知 |
| ダンプ停止の伸び | `block-gaps.mjs`（手動） | ブロック間隔の最大値を exporter が窓ごとに出す |
| gateway の異常 | なし | `rpc_upstream_up` / 拒否数の急増で通知 |
| ダッシュボードの停止 | なし | health エンドポイント + 外形監視 |

---

## 4. 既知の穴（2026-09-27 時点）

- **Eris の runtime で `X-ASCON-Key` を送る方法が、参加者向けの文書に無かった**。runtime が送るのは CF の
  2 ヘッダと `ERIS_RPC_HEADERS`（JSON）だけ（`sdk/src/chain.ts`）。ガイド §3 に追記した
- exporter は環境の失敗イベントを 1 つも出さない。flow bot のプロセスが落ちてもイベントが出ない。
  promtail の glob（`/runs/*/agents/*.jsonl`）は 1 階層なので、セグメント配下の agent ログを拾えない
- ダッシュボードに health エンドポイントが無い。gateway の指標にアラートが無い
- coordinator は SIGTERM を扱わないので、手で止めたセグメントには `summary.json` が無い
  （[README](README.md#stopping)）
- 推論プロキシは拒否（401 / 403 / 429）を記録しない。プロキシ経由の失敗は agent 側の
  `revision failed: …` から数える
