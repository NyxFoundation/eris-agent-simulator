// ダッシュボードのクライアント（ADR 0008「フロントエンド・パネル構成」）。
// /events を EventSource で購読し、snapshot / 増分イベントを state へ適用してパネルを描画する。
// EventSource は切断時に自動再接続し、サーバは接続ごとに snapshot を送るので状態は復元される。

import { drawBars, drawLines } from "./charts.js";

const ROW_H = 24; // 順位レース 1 行の高さ(px)

const S = {
  run: null,
  agents: new Map(), // id -> {id,address,kind,base,index,color,baseline}
  ranking: [],
  prices: [], // {blockNumber, fairPrice, poolPrice}
  blocks: [], // {blockNumber, timingMs}
  activity: new Map(), // id -> activity
  poller: null,
  totals: { txCount: 0, revertCount: 0 },
};

const el = (id) => document.getElementById(id);
const raceList = el("race-list");
const agrid = el("agrid");
const feedBody = el("feed-body");

// ---- formatters ----
function fmtUsd(n) {
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}k`;
  return `${s}${a.toFixed(0)}`;
}
function fmtSigned(n) {
  return (n >= 0 ? "+" : "") + fmtUsd(n);
}
function fmtGwei(wei) {
  const g = Number(wei) / 1e9;
  return g >= 100 ? g.toFixed(0) : g.toFixed(1);
}
function kindTag(kind) {
  return kind === "si" ? "SI" : kind === "frozen" ? "FRZ" : "BASE";
}

// ============================ header ============================
function renderHeader() {
  const run = S.run;
  el("m-run").textContent = run?.runId ? run.runId.slice(0, 19) : "—";
  el("m-block").textContent = run?.blockTimeSec ? `${run.blockTimeSec}s` : "—";
  el("m-curblock").textContent = String(S.latestBlock ?? 0);
  const rb = run?.runBlocks || 0;
  el("m-runblocks").textContent = rb ? ` / ${rb}` : "";
  const pct = rb ? Math.min(100, ((run.processedBlocks || 0) / rb) * 100) : 0;
  el("m-progress").style.width = `${pct}%`;

  const protoBox = el("m-protocols");
  const protos = run?.enabledProtocols ?? [];
  if (protoBox.dataset.sig !== protos.join(",")) {
    protoBox.dataset.sig = protos.join(",");
    protoBox.innerHTML = protos
      .map((p) => `<span class="chip">${p}</span>`)
      .join("");
  }

  const raceSub = el("race-sub");
  if (raceSub) {
    raceSub.textContent = run?.finalized
      ? "確定値（reconstruct・最終順位）"
      : "ライブ PnL（参考値・確定は reconstruct）";
  }

  const phase = el("m-phase");
  if (run?.finalized) {
    phase.className = "badge finalized";
    phase.textContent = "finalized (reconstruct)";
  } else if (run?.phase === "completed") {
    phase.className = "badge completed";
    phase.textContent = "completed";
  } else if (run?.phase === "started") {
    phase.className = "badge live";
    phase.textContent = "● live";
  } else {
    phase.className = "badge idle";
    phase.textContent = "idle";
  }

  const pl = el("m-poller");
  const p = S.poller;
  if (!p) {
    pl.className = "badge idle";
    pl.textContent = "poller —";
  } else if (p.connected) {
    pl.className = "badge live";
    pl.textContent = `RPC ●  poll/${p.pollEvery}blk`;
  } else if (p.degraded) {
    pl.className = "badge degraded";
    pl.textContent = "RPC degrade (tail のみ)";
  } else {
    pl.className = "badge idle";
    pl.textContent = "RPC connecting…";
  }
}

// ============================ ranking race ============================
function ensureRaceRow(id) {
  let row = raceList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) return row;
  const info = S.agents.get(id);
  const color = info?.color ?? "#888";
  const kind = info?.kind ?? "frozen";
  row = document.createElement("div");
  row.className = "race-row";
  row.dataset.id = id;
  row.innerHTML = `
    <span class="rk"></span>
    <span class="nm">
      <span class="dot" style="background:${color}"></span>
      <span class="kind" style="background:${color}">${kindTag(kind)}</span>
      <span class="lbl" title="${id}">${id}</span>
    </span>
    <span class="race-bar"><span class="zero"></span><span class="fill" style="background:${color}"></span></span>
    <span class="pnl"></span>`;
  raceList.appendChild(row);
  return row;
}

function renderRace() {
  const rows = S.ranking;
  if (rows.length === 0) return;
  el("race-empty").style.display = "none";
  raceList.style.height = `${rows.length * ROW_H}px`;
  let maxAbs = 1;
  for (const r of rows) maxAbs = Math.max(maxAbs, Math.abs(r.pnlUsdc));

  for (const r of rows) {
    const row = ensureRaceRow(r.id);
    row.style.transform = `translateY(${(r.rank - 1) * ROW_H}px)`;
    row.querySelector(".rk").textContent = r.rank;
    const fill = row.querySelector(".fill");
    const frac = (Math.abs(r.pnlUsdc) / maxAbs) * 50;
    if (r.pnlUsdc >= 0) {
      fill.style.left = "50%";
      fill.style.width = `${frac}%`;
      fill.style.opacity = "0.95";
    } else {
      fill.style.left = `${50 - frac}%`;
      fill.style.width = `${frac}%`;
      fill.style.opacity = "0.5";
    }
    const pnl = row.querySelector(".pnl");
    pnl.textContent = fmtSigned(r.pnlUsdc);
    pnl.className = `pnl ${r.pnlUsdc >= 0 ? "pos" : "neg"}`;
    pnl.title = `value ${fmtUsd(r.valueUsdc)}`;
  }
}

// ============================ activity grid ============================
function ensureCell(id) {
  let cell = agrid.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (cell) return cell;
  const info = S.agents.get(id);
  const color = info?.color ?? "#888";
  cell = document.createElement("div");
  cell.className = "cell";
  cell.dataset.id = id;
  cell.style.borderTopColor = color;
  cell.innerHTML = `
    <div class="top"><span class="dot" style="width:8px;height:8px;border-radius:2px;background:${color}"></span><span class="lbl" title="${id}">${id}</span></div>
    <div class="adopt"><div></div></div>
    <div class="nums"><span class="cnt"></span><span class="inc"></span></div>
    <div class="last"></div>`;
  agrid.appendChild(cell);
  return cell;
}

function renderCell(id) {
  const a = S.activity.get(id);
  if (!a) return;
  const cell = ensureCell(id);
  const denom = a.submitted + a.rejected + a.submitFailed;
  const adopt = denom ? (a.submitted / denom) * 100 : 0;
  cell.querySelector(".adopt > div").style.width = `${adopt}%`;
  cell.querySelector(".cnt").textContent =
    `S${a.submitted} R${a.rejected} F${a.submitFailed}`;
  cell.querySelector(".inc").textContent =
    `↳${a.included}${a.reverted ? ` ✗${a.reverted}` : ""}`;
  const last = cell.querySelector(".last");
  last.textContent = a.lastActionType
    ? `${a.lastEvent ?? ""} ${a.lastActionType}`.trim()
    : (a.lastEvent ?? "—");
  last.title = a.lastReason ?? "";
}

function refreshCoolness() {
  const now = Date.now();
  for (const [id, a] of S.activity) {
    const cell = agrid.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!cell) continue;
    const cool = !a.lastTs || now - a.lastTs > 6000;
    cell.classList.toggle("cool", cool);
  }
}

// ============================ tx feed ============================
function addFeedRow(tx) {
  const row = document.createElement("div");
  row.className = "tx";
  const st = (tx.status || "").toLowerCase();
  const stClass = st === "success" ? "success" : st;
  const fee = fmtGwei(tx.priorityFeeWei);
  row.innerHTML = `
    <span class="blk">${tx.phase === "submitted" ? "→" : "#"}${tx.blockNumber}${tx.txIndex != null ? `.${tx.txIndex}` : ""}</span>
    <span class="who" title="${tx.ownerId}">${tx.ownerId}</span>
    <span class="at">${tx.actionType || ""}</span>
    <span class="fee">${fee}g</span>`;
  // status は who 行末に色付き。簡潔のため st を別カラムに置く代わりに色のみ反映
  row.querySelector(".at").classList.add("st", stClass);
  feedBody.prepend(row);
  while (feedBody.childElementCount > 60) feedBody.lastElementChild.remove();
}

// ============================ charts ============================
let dirtyCharts = false;
function scheduleCharts() {
  dirtyCharts = true;
}
function drawCharts() {
  if (dirtyCharts) {
    dirtyCharts = false;
    const prices = S.prices;
    drawLines(el("price-canvas"), {
      xs: prices.map((p) => p.blockNumber),
      series: [
        { ys: prices.map((p) => p.fairPrice), color: "#4da3ff", width: 1.8 },
        {
          ys: prices.map((p) => (p.poolPrice == null ? null : p.poolPrice)),
          color: "#3fb950",
          width: 1.4,
        },
      ],
      fmtY: (v) => v.toFixed(0),
    });
    const last = prices[prices.length - 1];
    if (last) {
      const spread =
        last.poolPrice == null ? null : last.poolPrice - last.fairPrice;
      el("price-stat").innerHTML =
        `fair <b>${last.fairPrice.toFixed(1)}</b>` +
        (spread == null
          ? ""
          : `　spread <b>${spread >= 0 ? "+" : ""}${spread.toFixed(2)}</b>`);
    }

    const blocks = S.blocks;
    const target = (S.run?.blockTimeSec || 0) * 1000;
    drawBars(el("lat-canvas"), {
      values: blocks.map((b) => b.timingMs),
      color: "#6e7fa0",
      yref: target
        ? { value: target, color: "#d29922", label: `${S.run.blockTimeSec}s` }
        : undefined,
      fmtY: (v) => `${Math.round(v)}ms`,
    });
    const lb = blocks[blocks.length - 1];
    if (lb && lb.timingMs != null)
      el("lat-stat").innerHTML = `proc <b>${Math.round(lb.timingMs)}ms</b>`;
  }
  refreshCoolness();
  requestAnimationFrame(drawCharts);
}

// ============================ event handlers ============================
function applyAgents(list) {
  for (const a of list) S.agents.set(a.id, a);
  // 既存行/セルの色を更新（fallback 色で作られていた場合）
  for (const a of list) {
    ensureRaceRow(a.id);
    ensureCell(a.id);
  }
}

function applySnapshot(snap) {
  S.run = snap.run;
  S.latestBlock = snap.latestBlock;
  S.poller = snap.poller;
  S.totals = snap.totals ?? S.totals;
  S.agents = new Map((snap.agents ?? []).map((a) => [a.id, a]));
  S.activity = new Map((snap.activity ?? []).map((a) => [a.id, a]));
  S.prices = snap.prices ?? [];
  S.blocks = snap.blocks ?? [];
  S.ranking = snap.ranking ?? [];

  // 既存 DOM をクリアして再構築
  raceList.querySelectorAll(".race-row").forEach((n) => n.remove());
  agrid.querySelectorAll(".cell").forEach((n) => n.remove());
  feedBody.innerHTML = "";
  for (const a of S.agents.values()) {
    ensureRaceRow(a.id);
    ensureCell(a.id);
  }
  for (const id of S.activity.keys()) renderCell(id);
  for (const tx of (snap.tx ?? []).slice(-60)) addFeedRow(tx);
  renderHeader();
  renderRace();
  scheduleCharts();
}

function connect() {
  const es = new EventSource("/events");
  es.addEventListener("snapshot", (e) => applySnapshot(JSON.parse(e.data)));
  es.addEventListener("run", (e) => {
    S.run = JSON.parse(e.data);
    renderHeader();
    scheduleCharts();
  });
  es.addEventListener("agents", (e) => {
    applyAgents(JSON.parse(e.data));
    renderHeader();
  });
  es.addEventListener("block", (e) => {
    const b = JSON.parse(e.data);
    S.latestBlock = Math.max(S.latestBlock ?? 0, b.blockNumber);
    if (S.run)
      S.run.processedBlocks = b.processedBlocks ?? S.run.processedBlocks;
    S.blocks.push({ blockNumber: b.blockNumber, timingMs: b.timingMs });
    if (S.blocks.length > 900) S.blocks.shift();
    renderHeader();
    scheduleCharts();
  });
  es.addEventListener("values", (e) => {
    const v = JSON.parse(e.data);
    S.ranking = v.ranking;
    S.prices.push({
      blockNumber: v.blockNumber,
      fairPrice: v.fairPrice,
      poolPrice: v.poolPrice,
    });
    if (S.prices.length > 900) S.prices.shift();
    renderRace();
    scheduleCharts();
  });
  es.addEventListener("tx", (e) => addFeedRow(JSON.parse(e.data)));
  es.addEventListener("agentAction", (e) => {
    const a = JSON.parse(e.data);
    let act = S.activity.get(a.agentId);
    if (!act) {
      act = {
        id: a.agentId,
        submitted: 0,
        rejected: 0,
        submitFailed: 0,
        included: 0,
        reverted: 0,
      };
      S.activity.set(a.agentId, act);
    }
    act.submitted = a.submitted;
    act.rejected = a.rejected;
    act.submitFailed = a.submitFailed;
    act.lastEvent = a.event;
    act.lastActionType = a.actionType ?? act.lastActionType;
    act.lastReason = a.reason ?? act.lastReason;
    act.lastTs = a.lastTs ?? Date.now();
    renderCell(a.agentId);
  });
  es.addEventListener("pollerStatus", (e) => {
    S.poller = JSON.parse(e.data);
    renderHeader();
  });
  es.onerror = () => {
    /* EventSource が自動再接続。次接続でサーバが snapshot を再送する */
  };
}

connect();
requestAnimationFrame(drawCharts);
window.addEventListener("resize", scheduleCharts);
