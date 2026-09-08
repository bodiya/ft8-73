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
 * Rendered-heatmap cache. Building the ImageData for a heatmap costs one LUT lookup and four
 * byte writes per source cell, which for the spectrogram (1920 bins x 337 rows) is ~650k cells.
 * Nothing about that depends on the transport clock, so the result is cached as an offscreen
 * canvas keyed on the data identity plus every parameter that affects a pixel, and a redraw
 * costs one drawImage. Callers that build a fresh array every frame will miss every time: they
 * should memoize the array themselves (see the page modules).
 */
const HM_MAX_ENTRIES = 24, HM_MAX_PIXELS = 8e6;   // 8M px of RGBA is ~32 MB of backing store
const hmCache = new Map();          // insertion-ordered, re-inserted on hit => LRU
let hmPixels = 0;
const hmIds = new WeakMap(); let hmNextId = 1;
function dataKey(a) { let id = hmIds.get(a); if (!id) { id = hmNextId++; hmIds.set(a, id); } return id; }
function hmEvict() {
  while (hmCache.size > HM_MAX_ENTRIES || hmPixels > HM_MAX_PIXELS) {
    const k = hmCache.keys().next().value; if (k === undefined) break;
    const e = hmCache.get(k); hmCache.delete(k); hmPixels -= e.px;
  }
}
/** Drop everything (used when a page unmounts, so stale window data does not pin memory). */
export function clearHeatmapCache() { hmCache.clear(); hmPixels = 0; }
export function heatmapCacheStats() { return { entries: hmCache.size, pixels: hmPixels }; }

/**
 * Draw a heatmap. data is row-major (rows x cols). rowAt(y) / colAt(x) map pixel -> data index (fractional ok).
 * Rendered via an offscreen ImageData of size (cols x rows) then drawImage-scaled; use `nearest` for crisp cells.
 * The offscreen render is cached; pass a stable `data` array (or a `version` that changes when you mutate it).
 */
export function heatmap(g, { data, rows, cols, x, y, w, h, vmin, vmax, cmap = 'viridis', flipY = false, log = false, nearest = false, colRange = null, rowRange = null, pool = false, version = 0 }) {
  const c0 = colRange ? colRange[0] : 0, c1 = colRange ? colRange[1] : cols; const r0 = rowRange ? rowRange[0] : 0, r1 = rowRange ? rowRange[1] : rows;
  const nc0 = c1 - c0, nr0 = r1 - r0;
  // Optional max-pooling so narrow peaks survive when the data is denser than the pixels. The
  // pooled size depends on the destination box, so it is part of the cache key.
  const doPool = pool && (nc0 > w || nr0 > h);
  const pc = doPool ? Math.min(nc0, Math.ceil(w)) : 0, pr = doPool ? Math.min(nr0, Math.ceil(h)) : 0;
  const key = `${dataKey(data)}|${version}|${rows}|${cols}|${c0}|${c1}|${r0}|${r1}|${vmin}|${vmax}|${cmap}|${flipY ? 1 : 0}|${log ? 1 : 0}|${pc}|${pr}`;
  let ent = hmCache.get(key);
  if (ent) { hmCache.delete(key); hmCache.set(key, ent); }
  else { ent = renderHeatmap({ data, rows, cols, vmin, vmax, cmap, flipY, log, c0, r0, nc0, nr0, pc, pr }); hmCache.set(key, ent); hmPixels += ent.px; hmEvict(); }
  g.save(); g.imageSmoothingEnabled = !nearest; g.drawImage(ent.canvas, x, y, w, h); g.restore();
}

function renderHeatmap({ data, rows, cols, vmin, vmax, cmap, flipY, log, c0, r0, nc0, nr0, pc, pr }) {
  let src = data, sCols = cols, sc0 = c0, sr0 = r0, nc = nc0, nr = nr0;
  if (pc) {
    const pooled = new Float32Array(pc * pr).fill(-Infinity);
    for (let r = 0; r < nr0; r++) { const prr = Math.min(pr - 1, Math.floor(r / nr0 * pr)); for (let c = 0; c < nc0; c++) { const pcc = Math.min(pc - 1, Math.floor(c / nc0 * pc)); const v = data[(r0 + r) * cols + c0 + c]; const k = prr * pc + pcc; if (v > pooled[k]) pooled[k] = v; } }
    src = pooled; sCols = pc; sc0 = 0; sr0 = 0; nc = pc; nr = pr;
  }
  const img = new ImageData(nc, nr); const lut = CMAPS[cmap]; const px = img.data;
  const scale = 1 / ((vmax - vmin) || 1);
  for (let r = 0; r < nr; r++) {
    const rr = flipY ? (sr0 + nr - 1 - r) : (sr0 + r);
    const rowOff = rr * sCols + sc0, outOff = r * nc;
    for (let c = 0; c < nc; c++) {
      let v = src[rowOff + c]; if (log) v = 10 * Math.log10(v + 1e-12);
      let t = (v - vmin) * scale; t = t < 0 ? 0 : t > 1 ? 1 : t; const i = Math.round(t * 255) * 3, o = (outOff + c) * 4;
      px[o] = lut[i]; px[o + 1] = lut[i + 1]; px[o + 2] = lut[i + 2]; px[o + 3] = 255;
    }
  }
  const canvas = document.createElement('canvas'); canvas.width = nc; canvas.height = nr;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return { canvas, px: nc * nr };
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
