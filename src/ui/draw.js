// Canvas drawing helpers: colormaps, heatmaps, axes, line plots.

// Viridis-ish (8 anchor colors, interpolated)
const VIR = [[68,1,84],[72,40,120],[62,74,137],[49,104,142],[38,130,142],[31,158,137],[53,183,121],[109,205,89],[180,222,44],[253,231,37]];
const HOT = [[0,0,0],[40,0,60],[120,0,90],[200,40,40],[240,120,20],[255,200,60],[255,255,200]];
const BLUE = [[10,12,20],[20,40,90],[30,90,160],[60,150,210],[140,200,240],[240,250,255]];
function ramp(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) { const x = i / 255 * (stops.length - 1), k = Math.min(Math.floor(x), stops.length - 2), f = x - k; for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] * (1 - f) + stops[k + 1][c] * f; }
  return lut;
}
const DIV = [[255,140,66],[120,80,40],[20,24,32],[40,80,140],[78,161,255]]; // orange (bit 1) … dark … blue (bit 0)
export const CMAPS = { viridis: ramp(VIR), hot: ramp(HOT), blue: ramp(BLUE), diverging: ramp(DIV) };
export function cmapColor(name, v) { const l = CMAPS[name]; const i = Math.max(0, Math.min(255, Math.round(v * 255))) * 3; return `rgb(${l[i]},${l[i + 1]},${l[i + 2]})`; }

/**
 * Draw a heatmap. data is row-major (rows x cols). rowAt(y) / colAt(x) map pixel -> data index (fractional ok).
 * Rendered via an offscreen ImageData of size (cols x rows) then drawImage-scaled; use `nearest` for crisp cells.
 */
export function heatmap(g, { data, rows, cols, x, y, w, h, vmin, vmax, cmap = 'viridis', flipY = false, log = false, nearest = false, colRange = null, rowRange = null, pool = false }) {
  const c0 = colRange ? colRange[0] : 0, c1 = colRange ? colRange[1] : cols; const r0 = rowRange ? rowRange[0] : 0, r1 = rowRange ? rowRange[1] : rows;
  let nc = c1 - c0, nr = r1 - r0;
  // Optional max-pooling so narrow peaks survive when the data is denser than the pixels.
  let src = data, sCols = cols, sc0 = c0, sr0 = r0;
  if (pool && (nc > w || nr > h)) {
    const tc = Math.min(nc, Math.ceil(w)), trr = Math.min(nr, Math.ceil(h));
    const pooled = new Float32Array(tc * trr).fill(-Infinity);
    for (let r = 0; r < nr; r++) { const pr = Math.min(trr - 1, Math.floor(r / nr * trr)); for (let c = 0; c < nc; c++) { const pc = Math.min(tc - 1, Math.floor(c / nc * tc)); const v = data[(r0 + r) * cols + c0 + c]; const k = pr * tc + pc; if (v > pooled[k]) pooled[k] = v; } }
    src = pooled; sCols = tc; sc0 = 0; sr0 = 0; nc = tc; nr = trr;
  }
  const img = new ImageData(nc, nr); const lut = CMAPS[cmap]; const px = img.data;
  const scale = 1 / ((vmax - vmin) || 1);
  for (let r = 0; r < nr; r++) {
    const rr = flipY ? (sr0 + nr - 1 - r) : (sr0 + r);
    for (let c = 0; c < nc; c++) {
      let v = src[rr * sCols + sc0 + c]; if (log) v = 10 * Math.log10(v + 1e-12);
      let t = (v - vmin) * scale; t = t < 0 ? 0 : t > 1 ? 1 : t; const i = Math.round(t * 255) * 3, o = (r * nc + c) * 4;
      px[o] = lut[i]; px[o + 1] = lut[i + 1]; px[o + 2] = lut[i + 2]; px[o + 3] = 255;
    }
  }
  const off = heatmap._off || (heatmap._off = document.createElement('canvas')); off.width = nc; off.height = nr; off.getContext('2d').putImageData(img, 0, 0);
  g.save(); g.imageSmoothingEnabled = !nearest; g.drawImage(off, x, y, w, h); g.restore();
}

export function axisX(g, { x, y, w, min, max, ticks, label, fmt = v => v, color = '#8b93a3' }) {
  g.save(); g.strokeStyle = '#2a3242'; g.fillStyle = color; g.font = '11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'top';
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.stroke();
  for (const t of ticks) { const px = x + (t - min) / (max - min) * w; g.beginPath(); g.moveTo(px, y); g.lineTo(px, y + 4); g.stroke(); g.fillText(fmt(t), px, y + 6); }
  if (label) { g.fillText(label, x + w / 2, y + 20); }
  g.restore();
}
export function axisY(g, { x, y, h, min, max, ticks, label, fmt = v => v, color = '#8b93a3', flip = false }) {
  g.save(); g.strokeStyle = '#2a3242'; g.fillStyle = color; g.font = '11px system-ui'; g.textAlign = 'right'; g.textBaseline = 'middle';
  g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + h); g.stroke();
  for (const t of ticks) { let f = (t - min) / (max - min); if (!flip) f = 1 - f; const py = y + f * h; g.beginPath(); g.moveTo(x - 4, py); g.lineTo(x, py); g.stroke(); g.fillText(fmt(t), x - 6, py); }
  if (label) { g.translate(x - 38, y + h / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(label, 0, 0); }
  g.restore();
}
export function ticks(min, max, n = 6) { const span = max - min, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag; const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag; const out = []; for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(+t.toFixed(10)); return out; }

export function linePlot(g, { xs, ys, x, y, w, h, xmin, xmax, ymin, ymax, color = '#4ea1ff', width = 1.2, fill = null }) {
  g.save(); g.beginPath();
  for (let i = 0; i < xs.length; i++) { const px = x + (xs[i] - xmin) / (xmax - xmin) * w, py = y + h - (ys[i] - ymin) / (ymax - ymin) * h; i ? g.lineTo(px, py) : g.moveTo(px, py); }
  if (fill) { g.lineTo(x + (xs[xs.length - 1] - xmin) / (xmax - xmin) * w, y + h); g.lineTo(x + (xs[0] - xmin) / (xmax - xmin) * w, y + h); g.closePath(); g.fillStyle = fill; g.fill(); }
  else { g.strokeStyle = color; g.lineWidth = width; g.stroke(); }
  g.restore();
}
export function hline(g, x, w, py, color, dash = []) { g.save(); g.strokeStyle = color; g.setLineDash(dash); g.beginPath(); g.moveTo(x, py); g.lineTo(x + w, py); g.stroke(); g.restore(); }
export function vline(g, px, y, h, color, dash = []) { g.save(); g.strokeStyle = color; g.setLineDash(dash); g.beginPath(); g.moveTo(px, y); g.lineTo(px, y + h); g.stroke(); g.restore(); }
export function text(g, s, x, y, { color = '#e6e9ef', align = 'left', base = 'top', font = '11px system-ui', bg = null } = {}) {
  g.save(); g.font = font; g.textAlign = align; g.textBaseline = base;
  if (bg) { const m = g.measureText(s); const w = m.width + 6; const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x - 3; g.fillStyle = bg; g.fillRect(bx, y - 2, w, 14); }
  g.fillStyle = color; g.fillText(s, x, y); g.restore();
}
export function clear(c) { c.g.clearRect(0, 0, c.w, c.h); }
export function passColor(p) { return ['#4ea1ff', '#3ddc97', '#ffd166', '#c792ea', '#c792ea', '#c792ea'][Math.max(0, (p || 1) - 1)] || '#c792ea'; }
