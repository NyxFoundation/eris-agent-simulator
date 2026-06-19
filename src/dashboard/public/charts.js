// 依存最小の軽量 canvas チャート（ADR 0008: uPlot 等を避け自前 canvas）。
// DPR スケーリング込みの折れ線 / 棒の 2 種だけ。系列数・更新頻度が増えたら差し替える。

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const PAD = { l: 6, r: 8, t: 18, b: 8 };

function niceRange(min, max) {
  if (!isFinite(min) || !isFinite(max)) return [0, 1];
  if (min === max) {
    const d = Math.abs(min) * 0.01 || 1;
    return [min - d, max + d];
  }
  const span = max - min;
  return [min - span * 0.08, max + span * 0.08];
}

// xs: number[]（共通 x）。series: [{ys:(number|null)[], color, width?}]。
// yref: { value, color, label } で参照線（例: block time 目標）。
export function drawLines(canvas, { xs, series, yref, fmtY }) {
  const { ctx, w, h } = fitCanvas(canvas);
  if (!xs || xs.length === 0) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const y of s.ys) {
      if (y == null || !isFinite(y)) continue;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  if (yref && isFinite(yref.value)) {
    lo = Math.min(lo, yref.value);
    hi = Math.max(hi, yref.value);
  }
  if (lo === Infinity) return;
  [lo, hi] = niceRange(lo, hi);

  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const sx = (x) =>
    PAD.l + (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * (w - PAD.l - PAD.r));
  const sy = (y) => h - PAD.b - ((y - lo) / (hi - lo)) * (h - PAD.t - PAD.b);

  // yref 線
  if (yref && isFinite(yref.value)) {
    ctx.strokeStyle = yref.color || "#3a4456";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.l, sy(yref.value));
    ctx.lineTo(w - PAD.r, sy(yref.value));
    ctx.stroke();
    ctx.setLineDash([]);
    if (yref.label) {
      ctx.fillStyle = yref.color || "#3a4456";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(yref.label, PAD.l + 2, sy(yref.value) - 3);
    }
  }

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.6;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      const y = s.ys[i];
      if (y == null || !isFinite(y)) {
        started = false;
        continue;
      }
      const px = sx(xs[i]);
      const py = sy(y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // y レンジのラベル（左上/左下）
  if (fmtY) {
    ctx.fillStyle = "#5b6878";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(fmtY(hi), PAD.l, PAD.t - 6);
    ctx.fillText(fmtY(lo), PAD.l, h - PAD.b - 1);
  }
}

// 棒グラフ（レイテンシ）。values:(number|null)[]、color、yref で目標線。
export function drawBars(canvas, { values, color, yref, fmtY }) {
  const { ctx, w, h } = fitCanvas(canvas);
  if (!values || values.length === 0) return;
  let hi = 0;
  for (const v of values) if (v != null && isFinite(v) && v > hi) hi = v;
  if (yref && isFinite(yref.value)) hi = Math.max(hi, yref.value * 1.1);
  if (hi <= 0) hi = 1;
  const n = values.length;
  const bw = Math.max(1, (w - PAD.l - PAD.r) / n);
  const sy = (v) => h - PAD.b - (v / hi) * (h - PAD.t - PAD.b);

  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null || !isFinite(v)) continue;
    const over = yref && isFinite(yref.value) && v > yref.value;
    ctx.fillStyle = over ? "#f85149" : color;
    const x = PAD.l + i * bw;
    const y = sy(v);
    ctx.fillRect(x, y, Math.max(1, bw - 0.6), h - PAD.b - y);
  }

  if (yref && isFinite(yref.value)) {
    ctx.strokeStyle = yref.color || "#3a4456";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.l, sy(yref.value));
    ctx.lineTo(w - PAD.r, sy(yref.value));
    ctx.stroke();
    ctx.setLineDash([]);
    if (yref.label) {
      ctx.fillStyle = yref.color || "#3a4456";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(yref.label, w - PAD.r - 48, sy(yref.value) - 3);
    }
  }
  if (fmtY) {
    ctx.fillStyle = "#5b6878";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(fmtY(hi), PAD.l, PAD.t - 6);
  }
}
