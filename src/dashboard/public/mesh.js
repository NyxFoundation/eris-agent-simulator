// Agent-mesh canvas レンダラ。"Eris Agent Mesh" デザインモックの Component canvas
// ロジックを React/dc-runtime から切り離し、合成 tick の代わりにライブ SSE データで
// 駆動する移植版（ADR 0008 の中央パネル）。
//
//   ノード = 円環上の agent（色 = PnL、サイズ/グロー = equity、pulse = 活動）
//   particle = 中心へ流れ込む tx（block 確定で軌道上のドットがコアへ flush）
//
// 読取専用の演出のみ。チェーンには一切触れない（着順・採点に干渉しない）。

const C = [92, 198, 255]; // cyan : neutral / accent
const G = [79, 224, 168]; // mint : gain
const R = [255, 107, 122]; // red  : loss
const ACCENT = C;

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// PnL → "r,g,b": flat で cyan、gain で緑、loss で赤へ寄せる。
export function rgbForPnl(pnl, start) {
  const p = start > 0 ? pnl / start : 0;
  if (p >= 0) return lerp(C, G, Math.min(1, p * 7)).join(",");
  return lerp(C, R, Math.min(1, -p * 7)).join(",");
}

export class Mesh {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.agents = []; // {id, value, start, pnl, x, y, ang, pulse, hist}
    this.byId = new Map(); // id -> agent
    this.particles = [];
    this.pending = [];
    this.flush = [];
    this.frame = 0;
    this.rot = 0;
    this.corePulse = 0;
    this.intake = 0;
    this.maxBal = 1;
    this.hoverIdx = -1;
    this.selectedId = null;
    this.onSelect = null; // (id) => void
    this.size = null;
    this._raf = 0;
  }

  // ---- ライフサイクル ----
  start() {
    const c = this.canvas;
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(c.parentElement);
    this._onClick = (e) => {
      const id = this._pick(e);
      if (id && this.onSelect) this.onSelect(id);
    };
    this._onMove = (e) => {
      const idx = this._pickIdx(e);
      this.hoverIdx = idx;
      c.style.cursor = idx >= 0 ? "pointer" : "default";
    };
    this._onLeave = () => {
      this.hoverIdx = -1;
    };
    c.addEventListener("click", this._onClick);
    c.addEventListener("mousemove", this._onMove);
    c.addEventListener("mouseleave", this._onLeave);
    const loop = () => {
      this._draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    const c = this.canvas;
    c.removeEventListener("click", this._onClick);
    c.removeEventListener("mousemove", this._onMove);
    c.removeEventListener("mouseleave", this._onLeave);
  }

  // ---- データ更新 ----

  // agent リスト（順序が円環の並び）を id でリコンサイル。位置/pulse/hist は保持。
  setAgents(list) {
    const next = [];
    const nextById = new Map();
    for (const a of list) {
      let node = this.byId.get(a.id);
      if (!node) {
        node = {
          id: a.id,
          value: 0,
          start: 0,
          pnl: 0,
          x: 0,
          y: 0,
          ang: 0,
          pulse: 0,
          hist: [],
        };
      }
      next.push(node);
      nextById.set(a.id, node);
    }
    this.agents = next;
    this.byId = nextById;
  }

  // ranking 行（{id, valueUsdc, pnlUsdc}）で equity / pnl / 履歴を更新。
  updateValues(rows) {
    for (const r of rows) {
      const node = this.byId.get(r.id);
      if (!node) continue;
      node.value = r.valueUsdc;
      node.pnl = r.pnlUsdc;
      node.start = r.valueUsdc - r.pnlUsdc;
      node.hist.push(r.valueUsdc);
      if (node.hist.length > 64) node.hist.shift();
    }
  }

  setSelected(id) {
    this.selectedId = id;
  }

  // tx を 1 件流す。owner が agent なら該当ノードから流入 + pulse、
  // 不明（flow bot 等）なら任意ノード位置から色つきの流入のみ（誤って agent を光らせない）。
  spawnTx({ ownerId, colorRgb }) {
    const n = this.agents.length;
    if (n === 0) return;
    const known = this.byId.has(ownerId);
    let idx;
    if (known) {
      idx = this.agents.findIndex((a) => a.id === ownerId);
      this.agents[idx].pulse = 1;
    } else {
      idx = Math.floor(Math.random() * n); // ambient market flow
    }
    const ta = Math.random() * Math.PI * 2;
    const tr = Math.sqrt(Math.random());
    this.particles.push({
      node: idx,
      dir: "in",
      t: 0,
      sp: 0.014 + Math.random() * 0.013,
      col: colorRgb || ACCENT.join(","),
      ta,
      tr,
      done: false,
      pulseNode: known,
    });
    while (this.particles.length > 140) this.particles.shift();
  }

  // block 確定: 軌道ドットをコアへ flush し、全ノードから accent の放出 particle を出す。
  pulseBlock() {
    this.corePulse = 1;
    this.flush = this.flush.concat(
      this.pending.map((p) => ({ ang: p.ang, rad: p.rad, col: p.col, ft: 0 })),
    );
    if (this.flush.length > 140) this.flush = this.flush.slice(-140);
    this.pending = [];
    const ac = ACCENT.join(",");
    for (let i = 0; i < this.agents.length; i++) {
      this.particles.push({
        node: i,
        dir: "out",
        t: -Math.random() * 0.55,
        sp: 0.017 + Math.random() * 0.012,
        col: ac,
        ta: Math.random() * Math.PI * 2,
        tr: Math.sqrt(Math.random()),
        done: false,
      });
    }
  }

  // ---- 内部: ピッキング ----
  _pickIdx(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = -1;
    let bd = 1e9;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const d = (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return bd < 420 ? best : -1;
  }
  _pick(e) {
    const idx = this._pickIdx(e);
    return idx >= 0 ? this.agents[idx].id : null;
  }

  // ---- 内部: サイズ ----
  _resize() {
    const c = this.canvas;
    if (!c || !this.ctx) return;
    const rect = c.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, rect.width * dpr);
    c.height = Math.max(1, rect.height * dpr);
    c.style.width = rect.width + "px";
    c.style.height = rect.height + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = { w: rect.width, h: rect.height };
  }

  _spokeCtrl(a, cx, cy, Rr) {
    const a2 = a.ang + 0.2;
    const rr = Rr * 0.5;
    return [cx + Math.cos(a2) * rr, cy + Math.sin(a2) * rr];
  }
  _qpt(p0, p1, p2, t) {
    const u = 1 - t;
    return [
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ];
  }
  _addPending(ang, rad, col) {
    this.pending.push({
      ang,
      rad,
      aspeed:
        (0.0015 + Math.random() * 0.0045) * (Math.random() < 0.5 ? 1 : -1),
      col,
      seed: Math.random() * 100,
    });
    if (this.pending.length > 78) this.pending.shift();
  }
  _nodeRGB(a) {
    return rgbForPnl(a.pnl, a.start);
  }

  // ---- 内部: 描画（モック draw() の移植）----
  _draw() {
    const ctx = this.ctx;
    if (!ctx || !this.size || !this.size.w) return;
    const { w, h } = this.size;
    const cx = w / 2;
    const cy = h / 2;
    const R0 = Math.min(w, h) * 0.4;
    ctx.clearRect(0, 0, w, h);
    this.rot += 0.0006;
    this.corePulse *= 0.94;
    this.intake *= 0.9;
    this.frame += 1;
    const N = this.agents.length;
    if (N === 0) return;
    this.maxBal = 1;
    for (const a of this.agents)
      if (a.value > this.maxBal) this.maxBal = a.value;

    for (let i = 0; i < N; i++) {
      const a = this.agents[i];
      const ang = this.rot + (i / N) * Math.PI * 2 - Math.PI / 2;
      a.ang = ang;
      a.x = cx + Math.cos(ang) * R0;
      a.y = cy + Math.sin(ang) * R0;
      a.pulse *= 0.93;
    }

    // 外周/内周のガイドリング
    ctx.strokeStyle = "rgba(150,170,210,0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R0, 0, 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R0 * 0.62, 0, 7);
    ctx.stroke();

    ctx.globalCompositeOperation = "lighter";
    const Rm = Math.min(w, h) * 0.26;

    // スポーク
    for (let i = 0; i < N; i++) {
      const a = this.agents[i];
      const inx = cx + Math.cos(a.ang) * Rm;
      const iny = cy + Math.sin(a.ang) * Rm;
      const ct = this._spokeCtrl(a, cx, cy, R0);
      ctx.strokeStyle = "rgba(120,150,200," + (0.03 + a.pulse * 0.15) + ")";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(inx, iny);
      ctx.quadraticCurveTo(ct[0], ct[1], a.x, a.y);
      ctx.stroke();
    }
    ctx.save();
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "rgba(140,165,210,0.11)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, Rm, 0, 7);
    ctx.stroke();
    ctx.restore();
    ctx.lineCap = "round";

    // particle（コメット軌跡 + ヘッド）
    for (const pp of this.particles) {
      const a = this.agents[pp.node];
      if (!a) continue;
      const ct = this._spokeCtrl(a, cx, cy, R0);
      const P0 = [
        cx + Math.cos(pp.ta) * Rm * pp.tr,
        cy + Math.sin(pp.ta) * Rm * pp.tr,
      ];
      if (!pp.done && pp.t >= 1) {
        pp.done = true;
        if (pp.dir === "in") {
          this._addPending(pp.ta, Rm * pp.tr, pp.col);
          this.intake = Math.min(1, this.intake + 0.09);
        } else {
          a.pulse = 1;
        }
      }
      const prog = Math.min(1, pp.t);
      const headParam = pp.dir === "in" ? 1 - prog : prog;
      const tdir = pp.dir === "in" ? 1 : -1;
      const fade = pp.t > 1 ? Math.max(0, 1 - (pp.t - 1) / 0.15) : 1;
      const segs = 9;
      let prev = null;
      for (let s = 0; s <= segs; s++) {
        const pr2 = headParam + tdir * 0.26 * (1 - s / segs);
        if (pr2 < 0 || pr2 > 1) {
          prev = null;
          continue;
        }
        const pt = this._qpt(P0, ct, [a.x, a.y], pr2);
        if (prev) {
          ctx.strokeStyle =
            "rgba(" + pp.col + "," + (s / segs) * 0.85 * fade + ")";
          ctx.lineWidth = 0.6 + 1.3 * (s / segs);
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(pt[0], pt[1]);
          ctx.stroke();
        }
        prev = pt;
      }
      if (headParam >= 0 && headParam <= 1) {
        const head = this._qpt(P0, ct, [a.x, a.y], headParam);
        const g = ctx.createRadialGradient(
          head[0],
          head[1],
          0,
          head[0],
          head[1],
          7,
        );
        g.addColorStop(0, "rgba(" + pp.col + "," + 0.92 * fade + ")");
        g.addColorStop(1, "rgba(" + pp.col + ",0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(head[0], head[1], 7, 0, 7);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255," + 0.8 * fade + ")";
        ctx.beginPath();
        ctx.arc(head[0], head[1], 1.5, 0, 7);
        ctx.fill();
      }
      pp.t += pp.sp;
    }
    this.particles = this.particles.filter((p) => p.t < 1.15);

    // 軌道上の pending ドット
    for (const d of this.pending) {
      d.ang += d.aspeed;
      const rr = d.rad + Math.sin(this.frame * 0.04 + d.seed) * 1.8;
      const x = cx + Math.cos(d.ang) * rr;
      const y = cy + Math.sin(d.ang) * rr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 4.5);
      g.addColorStop(0, "rgba(" + d.col + ",0.85)");
      g.addColorStop(1, "rgba(" + d.col + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, 7);
      ctx.fill();
      ctx.fillStyle = "rgba(" + d.col + ",0.95)";
      ctx.beginPath();
      ctx.arc(x, y, 1.3, 0, 7);
      ctx.fill();
    }

    // block flush（コアへ吸い込み）
    for (const f of this.flush) {
      f.ft += 0.05;
      const e = f.ft * f.ft * (3 - 2 * f.ft);
      const sx = cx + Math.cos(f.ang) * f.rad;
      const sy = cy + Math.sin(f.ang) * f.rad;
      const x = sx + (cx - sx) * e;
      const y = sy + (cy - sy) * e;
      const al = (1 - f.ft) * 0.95;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 4);
      g.addColorStop(0, "rgba(" + f.col + "," + al + ")");
      g.addColorStop(1, "rgba(" + f.col + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 7);
      ctx.fill();
    }
    this.flush = this.flush.filter((f) => f.ft < 1);

    // 流入グロー / コアパルスリング
    if (this.intake > 0.02) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Rm);
      g.addColorStop(
        0,
        "rgba(" + ACCENT.join(",") + "," + this.intake * 0.22 + ")",
      );
      g.addColorStop(1, "rgba(" + ACCENT.join(",") + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, Rm, 0, 7);
      ctx.fill();
    }
    if (this.corePulse > 0.02) {
      const rr = Rm + (R0 - Rm) * (1 - this.corePulse);
      ctx.strokeStyle =
        "rgba(" + ACCENT.join(",") + "," + this.corePulse * 0.4 + ")";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, 7);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";

    // ノード本体 + ラベル
    const sel = this.selectedId;
    for (let i = 0; i < N; i++) {
      const a = this.agents[i];
      const col = this._nodeRGB(a);
      const isSel = a.id === sel;
      const isHov = i === this.hoverIdx;
      const sz = 2.4 + Math.min(a.value / this.maxBal, 1) * 2.6;
      const pr = a.pulse;
      ctx.globalCompositeOperation = "lighter";
      const gr = 12 + pr * 16 + (isSel ? 6 : 0);
      const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, gr);
      g.addColorStop(0, "rgba(" + col + "," + (0.45 + pr * 0.5) + ")");
      g.addColorStop(1, "rgba(" + col + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(a.x, a.y, gr, 0, 7);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgb(" + col + ")";
      ctx.beginPath();
      ctx.arc(a.x, a.y, sz + pr * 2, 0, 7);
      ctx.fill();
      if (isSel || isHov) {
        ctx.strokeStyle = "rgba(" + col + ",0.9)";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(a.x, a.y, sz + 7 + (isSel ? 3 : 0), 0, 7);
        ctx.stroke();
      }
      if (isSel || isHov) {
        const out = R0 + 14;
        const lx = cx + Math.cos(a.ang) * out;
        const ly = cy + Math.sin(a.ang) * out;
        const right = Math.cos(a.ang) >= 0;
        ctx.font = '600 10px "Geist Mono", ui-monospace, monospace';
        ctx.textAlign = right ? "left" : "right";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(230,235,242,0.95)";
        ctx.fillText(a.id, lx, ly);
      }
    }
  }
}
