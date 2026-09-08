// Stage 1: coarse sync. Sync spectrum + full surface + three animated views of the template, with the real knobs.
//
// Performance shape: the sync spectrum and the surface depend only on the sync parameters (and,
// in the causal view, on how much audio has been heard), so they sit on background layers and the
// clock only moves a crosshair. The causal view needs a whole new sync surface every 0.16 s of
// clock time, which is far too much to do inside a frame, so the 84 surfaces of the ladder are
// computed in the background as soon as that view opens and simply looked up during playback.
import { syncAt, syncSurface, syncHits, dedupeCandidates } from '../dsp/sync.js';
import { COSTAS, JZ } from '../dsp/constants.js';
import { slider, select, checkbox, el, panel, canvas, layers, tabbar, caption } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, text, hline, vline, clear, passColor, linePlot } from '../ui/draw.js';

const st = { view: { span: 0, center: 1600, vmax: 5, ymax: 8, rings: true }, focus: null, mode: 'lag', causalCache: new Map(), ladderToken: 0, unsubs: [] };
const MODES = [['lag', 'lag sweep'], ['freq', 'frequency sweep'], ['causal', 'causal reveal']];
const CAPTIONS = {
  lag: ['slides the template through all 125 lags at the focused frequency, 0.1 s per lag.', 'the score spiking at one lag. That peak, divided by the noise floor, is the whole candidate test.'],
  freq: ['slides the template across the zoom span at the focused lag, one sweep per 10 s.', 'how narrow each peak is in frequency. Set a 250 Hz zoom span to slow the sweep down enough to follow.'],
  causal: ['plays the window in real time and re-runs the whole search on the audio heard so far.', 'real signals clearing the threshold only once two of the three Costas arrays have arrived, at 7.4 s. That is why a decoder can start before the slot ends.'],
};
const LADDER_STEP = 4;   // spectrogram rows per causal step (4 rows = one symbol = 0.16 s)

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); this.mount(root, app); } }); st.unsubs.push(off); return; }  // cancelled by unmount if you navigate away first
    const P = app.syncParams, V = st.view;
    const want = app.tabFor('sync', MODES.map(m => m[0])); if (want) st.mode = want;
    root.append(el('h1', null, '1 · Coarse sync: finding candidates with the Costas arrays'));
    root.append(el('p', 'blurb', 'Every FT8 transmission carries the same 7-tone Costas pattern [3 1 4 0 6 5 2] three times: at symbols 0, 36 and 72. The decoder computes a spectrogram with 3.125 Hz bins and 40 ms steps (2 bins per tone, 4 rows per symbol) and, for every start frequency and every start time (lag), sums the power in the 21 cells where the Costas tones should be, divided by the mean power in the other 6 tone slots of those same symbols. That ratio is the sync score. The surface below is that score for every frequency bin × 125 lags (±2.48 s). Collapse it over lag (keeping the best lag in a ±0.52 s window) and you get the sync spectrum; divide by its 40th percentile so "1.0" means "typical noise", threshold, then dedupe nearby hits → the candidate list. The three views on the right animate the same computation three ways.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div'); row.append(main);
    const specP = panel(main, 'Sync spectrum: best score per frequency bin ÷ noise floor'); const [cvSb, cvS] = layers(specP, 1000, 190);
    const surfP = panel(main, 'Sync surface: score vs frequency (→) and time offset DT (↓)'); const [cvUb, cvU] = layers(surfP, 1000, 380);
    const hover = el('div', 'stats', ' '); surfP.append(hover); const lg = el('div', 'legend'); lg.innerHTML = '<span>○ white = kept candidate (purple = found via the full-lag red2 search)</span><span>○ colored ring = reference decode (blue p1, green p2, yellow p3, purple A7)</span><span>lighter band = the short-lag window</span>'; surfP.append(lg);
    const side = el('div', 'controls'); side.style.maxWidth = '460px'; side.style.minWidth = '460px'; row.append(side);
    const tabs = tabbar(side, MODES, st.mode, id => app.setTab(id));
    const cap = caption(side);
    const tmplP = panel(side, 'The template'); const cvT = canvas(tmplP, 430, 380); const tinfo = el('div', 'stats'); tmplP.append(tinfo);
    const auxP = panel(side, 'Score along the sweep'); const cvA = canvas(auxP, 430, 150); const ainfo = el('div', 'note'); auxP.append(ainfo);
    const stats = panel(side, 'Counts'); const statsTxt = el('div', 'stats'); stats.append(statsTxt);
    const listP = panel(main, 'Candidate list (after dedupe, strongest first)'); const listWrap = el('div', 'scroll'); listP.append(listWrap);

    const rerun = () => { st.causalCache.clear(); app.recomputeSync(); };
    slider(ctl, { label: 'noise-floor percentile', min: 0.05, max: 0.95, step: 0.05, value: P.basePct, fmt: v => (v * 100).toFixed(0) + 'th', oninput: v => { P.basePct = v; rerun(); } });
    slider(ctl, { label: 'sync threshold (× floor)', min: 0.5, max: 6, step: 0.05, value: P.syncMin, fmt: v => v.toFixed(2), oninput: v => { P.syncMin = v; rerun(); } });
    slider(ctl, { label: 'short-lag window ±', min: 0, max: 62, step: 1, value: P.mlag, fmt: v => `${v} = ±${(v * 0.04).toFixed(2)} s`, oninput: v => { P.mlag = v; rerun(); } });
    checkbox(ctl, { label: 'also keep best over the full ±2.48 s (red2)', value: P.useRed2, onchange: v => { P.useRed2 = v; rerun(); } });
    slider(ctl, { label: 'max candidates', min: 10, max: 1000, step: 10, value: P.maxCandidates, oninput: v => { P.maxCandidates = v; rerun(); } });
    slider(ctl, { label: 'dedupe: freq tolerance', min: 0, max: 25, step: 0.5, value: P.freqTol, fmt: v => v + ' Hz', oninput: v => { P.freqTol = v; rerun(); } });
    slider(ctl, { label: 'dedupe: DT tolerance', min: 0, max: 0.5, step: 0.01, value: P.dtTol, fmt: v => v.toFixed(2) + ' s', oninput: v => { P.dtTol = v; rerun(); } });
    slider(ctl, { label: 'search freq min', min: 100, max: 3000, step: 50, value: P.freqMin, fmt: v => v + ' Hz', oninput: v => { P.freqMin = v; rerun(); } });
    slider(ctl, { label: 'search freq max', min: 500, max: 4007, step: 50, value: P.freqMax, fmt: v => v + ' Hz', oninput: v => { P.freqMax = v; rerun(); } });
    ctl.append(el('h3', null, 'view'));
    select(ctl, { label: 'zoom span', options: [[0, 'full range'], [1500, '1500 Hz'], [600, '600 Hz'], [250, '250 Hz'], [100, '100 Hz']], value: V.span, onchange: v => { V.span = +v; drawAll(); } });
    slider(ctl, { label: 'zoom center', min: 200, max: 4000, step: 5, value: V.center, fmt: v => v + ' Hz', oninput: v => { V.center = v; drawAll(); } });
    slider(ctl, { label: 'color ceiling (score)', min: 2, max: 40, step: 1, value: V.vmax, oninput: v => { V.vmax = v; drawAll(); } });
    slider(ctl, { label: 'spectrum y max', min: 2, max: 60, step: 1, value: V.ymax, oninput: v => { V.ymax = v; drawAll(); } });
    checkbox(ctl, { label: 'draw candidate rings', value: V.rings, onchange: v => { V.rings = v; drawAll(); } });
    ctl.append(el('div', 'note', 'Defaults are wsjtr / WSJT-X defaults: 40th percentile, threshold 1.2, ±13 lags, 200 candidates, dedupe within 4 Hz and 0.04 s. Turn the rings off in the causal view: before two Costas arrays have arrived most of them are noise, which is the point but also a lot of clutter.'));

    const L = 46, T = 6;
    const fr = () => { const s = app.surf; if (!V.span) return [s.freqs[0], s.freqs[s.nb - 1]]; const c = Math.max(s.freqs[0] + V.span / 2, Math.min(s.freqs[s.nb - 1] - V.span / 2, V.center)); return [c - V.span / 2, c + V.span / 2]; };
    const ref = () => app.ref();

    // ---- what the clock means in each mode ----
    function setupMode() {
      app.clock.pause();
      if (st.mode === 'lag') { app.clock.setDuration(12.5); if (st.focus) app.clock.seek((st.focus.lag + JZ + 0.5) / (2 * JZ + 1) * 12.5); }
      else if (st.mode === 'freq') { app.clock.setDuration(10); app.clock.seek(0); }
      else { app.clock.setDuration(app.duration); app.clock.seek(0); }
      auxP.hidden = st.mode === 'lag';
      cap.set(...CAPTIONS[st.mode]);
    }
    const curLag = () => st.mode === 'lag' ? Math.max(-JZ, Math.min(JZ, Math.floor(app.clock.t / app.clock.duration * (2 * JZ + 1)) - JZ)) : (st.focus ? st.focus.lag : 0);
    const curFreqBin = () => { const s = app.surf; if (st.mode !== 'freq') return st.focus ? st.focus.bin : 0; const [f0, f1] = fr(); const f = f0 + app.clock.t / app.clock.duration * (f1 - f0); return Math.max(0, Math.min(s.nb - 1, Math.round((f - s.freqs[0]) / s.df))); };
    const causalRows = () => Math.max(0, Math.min(app.spec.rows, Math.floor(app.clock.t / 0.04 / LADDER_STEP) * LADDER_STEP));

    /** Sync search using only spectrogram rows < R (cached per R). */
    function causal(R) {
      if (st.causalCache.has(R)) return st.causalCache.get(R);
      const surf = syncSurface(app.spec, P.freqMin, P.freqMax, 0.5, R); const hits = syncHits(surf, P); const d = dedupeCandidates(hits.hits, P);
      const out = { surf, hits, candidates: d.kept, dropped: d.dropped }; st.causalCache.set(R, out); return out;
    }
    /**
     * Fill the whole causal ladder in the background so scrubbing and playback are lookups.
     * One surface is ~30 ms, and there are 84 of them; chunking through setTimeout keeps the page
     * responsive while it runs and lets a mode change or an unmount cancel it.
     */
    function buildLadder() {
      const token = ++st.ladderToken;
      const steps = []; for (let R = 0; R <= app.spec.rows; R += LADDER_STEP) steps.push(Math.min(R, app.spec.rows));
      let i = 0;
      const tick = () => {
        if (token !== st.ladderToken || st.mode !== 'causal') return;
        const t0 = performance.now();
        while (i < steps.length && performance.now() - t0 < 12) { causal(steps[i]); i++; }
        st.ladderProgress = i / steps.length;
        drawStats();
        if (i < steps.length) setTimeout(tick, 0); else { st.ladderProgress = 1; drawAux(); }
      };
      st.ladderProgress = 0; setTimeout(tick, 0);
    }
    /** The (surface, hits, candidates) being displayed. */
    function current() { if (st.mode === 'causal') return causal(causalRows()); return { surf: app.surf, hits: app.hits, candidates: app.candidates, dropped: app.dropped }; }

    function drawSpectrum() {
      const { surf: s, hits: h, candidates, dropped } = current(); const g = cvSb.g; clear(cvSb); const [f0, f1] = fr(); const W = cvSb.w - L - 10, H = cvSb.h - T - 28;
      const fx = f => L + (f - f0) / (f1 - f0) * W, sy = v => T + H - Math.min(v, V.ymax) / V.ymax * H;
      const xs = [], ys = []; for (let i = 0; i < s.nb; i++) if (s.freqs[i] >= f0 - 5 && s.freqs[i] <= f1 + 5) { xs.push(s.freqs[i]); ys.push(Math.min(h.red[i], V.ymax)); }
      if (P.useRed2) { const x2 = [], y2 = []; for (let i = 0; i < s.nb; i++) if (s.freqs[i] >= f0 - 5 && s.freqs[i] <= f1 + 5) { x2.push(s.freqs[i]); y2.push(Math.min(h.red2[i], V.ymax)); } linePlot(g, { xs: x2, ys: y2, x: L, y: T, w: W, h: H, xmin: f0, xmax: f1, ymin: 0, ymax: V.ymax, color: '#5a6478', width: 1 }); }
      linePlot(g, { xs, ys, x: L, y: T, w: W, h: H, xmin: f0, xmax: f1, ymin: 0, ymax: V.ymax, color: '#4ea1ff', width: 1 });
      hline(g, L, W, sy(1), '#8b93a3', [2, 4]); text(g, 'floor = 1.0', L + W - 4, sy(1) - 13, { color: '#8b93a3', align: 'right' });
      hline(g, L, W, sy(P.syncMin), '#ff8c42', [6, 3]); text(g, `threshold ${P.syncMin.toFixed(2)}`, L + 4, sy(P.syncMin) - 13, { color: '#ff8c42' });
      if (V.rings) {
        for (const d of dropped) if (d.freq >= f0 && d.freq <= f1) { g.fillStyle = '#5a6478'; g.beginPath(); g.arc(fx(d.freq), sy(d.score), 2, 0, 7); g.fill(); }
        for (const c of candidates) if (c.freq >= f0 && c.freq <= f1) { g.fillStyle = c.kind === 'red2' ? '#c792ea' : '#ffffff'; g.beginPath(); g.arc(fx(c.freq), sy(c.score), 2.5, 0, 7); g.fill(); }
      }
      for (const d of ref()) if (d.freq >= f0 && d.freq <= f1) { g.fillStyle = passColor(d.pass); g.fillRect(fx(d.freq) - 1, T, 2, 6); }
      if (st.mode === 'causal') text(g, `heard ${(causalRows() * 0.04).toFixed(1)} s of ${app.duration.toFixed(1)} s`, L + W / 2, T, { align: 'center', bg: 'rgba(0,0,0,0.6)' });
      axisX(g, { x: L, y: T + H, w: W, min: f0, max: f1, ticks: ticks(f0, f1, 8), fmt: v => v + ' Hz' });
      axisY(g, { x: L, y: T, h: H, min: 0, max: V.ymax, ticks: ticks(0, V.ymax, 4) });
    }
    function drawSurface() {
      const { surf: s, hits: h, candidates } = current(); const g = cvUb.g; clear(cvUb); const [f0, f1] = fr(); const W = cvUb.w - L - 10, H = cvUb.h - T - 28;
      const fx = f => L + (f - f0) / (f1 - f0) * W, ly = lag => T + (lag + JZ) / (2 * JZ) * H;
      const c0 = Math.max(0, Math.floor((f0 - s.freqs[0]) / s.df)), c1 = Math.min(s.nb, Math.ceil((f1 - s.freqs[0]) / s.df) + 1);
      const norm = h.base || 1;
      heatmap(g, { data: s.surface, rows: s.nl, cols: s.nb, x: fx(s.freqs[c0]), y: ly(-JZ - 0.5), w: fx(s.freqs[c1 - 1]) - fx(s.freqs[c0]), h: ly(JZ + 0.5) - ly(-JZ - 0.5), vmin: 0, vmax: V.vmax * norm, cmap: 'viridis', colRange: [c0, c1], nearest: V.span > 0 && V.span <= 250, pool: true });
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(L, ly(-P.mlag - 0.5), W, ly(P.mlag + 0.5) - ly(-P.mlag - 0.5));
      if (V.rings) for (const c of candidates) if (c.freq >= f0 && c.freq <= f1) { g.strokeStyle = c.kind === 'red2' ? '#c792ea' : '#ffffff'; g.lineWidth = 1; g.beginPath(); g.arc(fx(c.freq), ly(c.lag), 3.2, 0, 7); g.stroke(); }
      for (const d of ref()) if (d.freq >= f0 - 20 && d.freq <= f1 + 20) { g.strokeStyle = passColor(d.pass); g.lineWidth = 1.5; g.beginPath(); g.arc(fx(d.freq), ly(d.dt / 0.04 + 0.5), 7, 0, 7); g.stroke(); }
      axisX(g, { x: L, y: T + H, w: W, min: f0, max: f1, ticks: ticks(f0, f1, 8), fmt: v => v + ' Hz' });
      axisY(g, { x: L, y: T, h: H, min: -JZ * 0.04, max: JZ * 0.04, ticks: [-2, -1, 0, 1, 2], fmt: v => v + ' s', flip: true });
    }
    /** Crosshair on the surface and the sweep marker on the spectrum: the only per-frame drawing. */
    function drawCross() {
      const s = app.surf; const [f0, f1] = fr();
      const gu = cvU.g; clear(cvU);
      if (st.focus || st.mode === 'freq') {
        const W = cvU.w - L - 10, H = cvU.h - T - 28;
        const fx = f => L + (f - f0) / (f1 - f0) * W, ly = lag => T + (lag + JZ) / (2 * JZ) * H;
        vline(gu, fx(s.freqs[curFreqBin()]), T, H, '#ff5c5c', [3, 3]); hline(gu, L, W, ly(curLag()), '#ff5c5c', [3, 3]);
      }
      const gs = cvS.g; clear(cvS);
      if (st.mode === 'freq') { const W = cvS.w - L - 10, H = cvS.h - T - 28; vline(gs, L + (s.freqs[curFreqBin()] - f0) / (f1 - f0) * W, T, H, '#ff5c5c', [3, 3]); }
    }
    function drawTemplate() {
      const g = cvT.g; clear(cvT); const s = app.surf, spec = app.spec;
      if (!st.focus && st.mode !== 'freq') { text(g, 'click the surface or the spectrum to pick a point', 10, 10, { color: '#8b93a3' }); tinfo.textContent = ''; return; }
      const bin = curFreqBin() + s.ia, lag = curLag(); const maxRow = st.mode === 'causal' ? causalRows() : spec.rows;
      const nbShow = 26, b0 = Math.max(0, bin - nbShow), b1 = Math.min(spec.nbins, bin + nbShow + 14);
      const Lx = 38, Ty = 6, W = cvT.w - Lx - 8, H = cvT.h - Ty - 26;
      const bx = b => Lx + (b - b0) / (b1 - b0) * W, ry = r => Ty + r / spec.rows * H;
      // The slice is a fresh array every time, so key the heatmap cache by the window it shows.
      if (!st._sub || st._sub.b0 !== b0 || st._sub.b1 !== b1 || st._sub.spec !== spec) st._sub = { spec, b0, b1, data: new Float32Array(spec.rows * (b1 - b0)), maxRow: -1 };
      const sub = st._sub.data;
      if (st._sub.maxRow !== maxRow) { let mx = 0; for (let r = 0; r < spec.rows; r++) for (let b = b0; b < b1; b++) { const v = r < maxRow ? spec.data[r * spec.nbins + b] : 0; sub[r * (b1 - b0) + (b - b0)] = v; if (v > mx) mx = v; } st._sub.maxRow = maxRow; st._sub.mx = mx; st._sub.version = (st._sub.version || 0) + 1; }
      const mx = st._sub.mx;
      heatmap(g, { data: sub, rows: spec.rows, cols: b1 - b0, x: Lx, y: Ty, w: W, h: H, vmin: 10 * Math.log10(mx + 1e-9) - 45, vmax: 10 * Math.log10(mx + 1e-9), cmap: 'blue', log: true, nearest: true, version: st._sub.version });
      if (maxRow < spec.rows) { g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(Lx, ry(maxRow), W, ry(spec.rows) - ry(maxRow)); hline(g, Lx, W, ry(maxRow), '#ff5c5c'); }
      const jstrt = s.jstrt; const cw = W / (b1 - b0), rh = H / spec.rows;
      const r = syncAt(spec, bin, lag, jstrt, 4, 2, maxRow);
      for (const off of [0, 36, 72]) for (let n = 0; n < 7; n++) {
        const m = lag + jstrt + 4 * n + 4 * off; if (m < 0 || m >= spec.rows) continue;
        const avail = m < maxRow;
        for (let t = 0; t <= 6; t++) { const b = bin + 2 * t; g.strokeStyle = t === COSTAS[n] ? (avail ? '#ff8c42' : 'rgba(255,140,66,0.35)') : 'rgba(255,255,255,0.25)'; g.lineWidth = t === COSTAS[n] ? 1.5 : 0.6; g.strokeRect(bx(b), ry(m), cw, rh * 4); }
      }
      axisX(g, { x: Lx, y: Ty + H, w: W, min: b0 * s.df, max: b1 * s.df, ticks: ticks(b0 * s.df, b1 * s.df, 4), fmt: v => v.toFixed(0) });
      axisY(g, { x: Lx, y: Ty, h: H, min: 0, max: spec.rows * 0.04, ticks: [0, 2, 4, 6, 8, 10, 12], fmt: v => v + 's', flip: true });
      const { hits } = current(); const bi = bin - s.ia;
      const tr = app.truthFor({ freq: bin * s.df, dt: (lag - 0.5) * 0.04 });
      tinfo.innerHTML = `f = <b>${(bin * s.df).toFixed(1)} Hz</b>, lag = <b>${lag}</b> (DT ${((lag - 0.5) * 0.04).toFixed(2)} s) → raw score <b>${r.score.toFixed(2)}</b> (all three arrays: ${r.abc.toFixed(2)}, last two only: ${r.bc.toFixed(2)}) = <b>${(r.score / (hits.base || 1)).toFixed(2)}</b> × floor. Best lag in ±${P.mlag} at this frequency: <b>${hits.jpeak[bi]}</b> → ${hits.red[bi].toFixed(2)}.` + (tr ? `<br>reference decode here: <b>${tr.message}</b> (pass ${tr.pass}, ${tr.snr} dB, DT ${tr.dt}).` : '');
    }
    function drawAux() {
      const g = cvA.g; clear(cvA); const Lx = 34, W = cvA.w - Lx - 8, H = cvA.h - T - 24;
      if (st.mode === 'freq') {
        auxP.querySelector('h3').textContent = 'Score along the sweep (this lag, ÷ floor)';
        const s = app.surf, h = app.hits; const [f0, f1] = fr(); const lag = curLag(); const li = lag + JZ; const xs = [], ys = [];
        for (let i = 0; i < s.nb; i++) if (s.freqs[i] >= f0 && s.freqs[i] <= f1) { xs.push(s.freqs[i]); ys.push(Math.min(V.ymax, s.surface[li * s.nb + i] / (h.base || 1))); }
        linePlot(g, { xs, ys, x: Lx, y: T, w: W, h: H, xmin: f0, xmax: f1, ymin: 0, ymax: V.ymax, color: '#4ea1ff', width: 1 });
        hline(g, Lx, W, T + H - P.syncMin / V.ymax * H, '#ff8c42', [4, 3]);
        vline(g, Lx + (s.freqs[curFreqBin()] - f0) / (f1 - f0) * W, T, H, '#ff5c5c');
        axisX(g, { x: Lx, y: T + H, w: W, min: f0, max: f1, ticks: ticks(f0, f1, 5), fmt: v => v }); axisY(g, { x: Lx, y: T, h: H, min: 0, max: V.ymax, ticks: [0, V.ymax / 2, V.ymax], fmt: v => v });
        ainfo.textContent = 'The template slides across the zoom span at the focus lag (click the surface to change it). Narrow the zoom span to slow the sweep down.';
      } else if (st.mode === 'causal') {
        auxP.querySelector('h3').textContent = 'Candidates found vs audio heard so far';
        const R = causalRows(); const xs = [], ys = []; for (const [k, v] of st.causalCache) { xs.push(k * 0.04); ys.push(v.candidates.length); }
        const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]); const sx = idx.map(i => xs[i]), sy = idx.map(i => ys[i]);
        const ymax = Math.max(10, ...sy) * 1.1;
        if (sx.length > 1) linePlot(g, { xs: sx, ys: sy, x: Lx, y: T, w: W, h: H, xmin: 0, xmax: app.duration, ymin: 0, ymax, color: '#4ea1ff', width: 1.5 });
        for (const [tt, lab] of [[1.62, 'array A heard'], [7.38, 'array B heard'], [13.14, 'array C heard']]) { const px = Lx + tt / app.duration * W; vline(g, px, T, H, '#ff8c42', [3, 3]); text(g, lab, px + 2, T + 2, { color: '#ff8c42', font: '9px system-ui' }); }
        vline(g, Lx + R * 0.04 / app.duration * W, T, H, '#ff5c5c');
        axisX(g, { x: Lx, y: T + H, w: W, min: 0, max: app.duration, ticks: ticks(0, app.duration, 6), fmt: v => v + 's' }); axisY(g, { x: Lx, y: T, h: H, min: 0, max: ymax, ticks: ticks(0, ymax, 3), fmt: v => v.toFixed(0) });
        ainfo.textContent = 'The search is re-run on the spectrogram rows heard so far (cells that are not yet available count as zero). Scores need two of the three arrays before real signals clear the threshold; the curve fills in as the clock plays. This is why a decoder can start ~1.5 s before the slot ends.';
      }
    }
    function drawStats() {
      const { hits, candidates, dropped } = current(); const cands = candidates, tol = (d, c) => Math.abs(d.freq - c.freq) <= 6 && Math.abs(d.dt - c.dt) <= 0.25;
      const p1 = ref().filter(d => d.pass === 1), later = ref().filter(d => d.pass > 1);
      const hit1 = p1.filter(d => cands.some(c => tol(d, c))).length, hitL = later.filter(d => cands.some(c => tol(d, c))).length;
      const unmatched = cands.filter(c => !ref().some(d => tol(d, c))).length;
      const prog = st.mode === 'causal' && st.ladderProgress != null && st.ladderProgress < 1 ? `<br><span class="note">precomputing the causal ladder: ${(st.ladderProgress * 100).toFixed(0)}%</span>` : '';
      statsTxt.innerHTML = `${st.mode === 'causal' ? `<b>after ${(causalRows() * 0.04).toFixed(1)} s heard:</b><br>` : ''}noise floor (raw score at the ${(P.basePct * 100).toFixed(0)}th percentile): <b>${hits.base.toFixed(2)}</b><br>raw hits above threshold: <b>${hits.hits.length}</b> (cap 1000)<br>candidates after dedupe: <b>${cands.length}</b> (dropped ${dropped.length})<br>reference pass-1 decodes with a candidate: <b>${hit1} / ${p1.length}</b><br>later-pass decodes with a candidate: <b>${hitL} / ${later.length}</b> (many only surface after subtraction)<br>candidates with no known decode: <b>${unmatched}</b>${prog}`;
    }
    function drawList() {
      const { candidates } = current(); listWrap.innerHTML = ''; const t = el('table', 'list'); t.innerHTML = '<tr><th>#</th><th>score</th><th>freq</th><th>DT</th><th>from</th><th class="msg">reference decode nearby</th></tr>';
      candidates.forEach((c, i) => { const tr = el('tr'); const d = app.truthFor(c); tr.innerHTML = `<td>${i + 1}</td><td>${c.score.toFixed(2)}</td><td>${c.freq.toFixed(1)}</td><td>${c.dt.toFixed(2)}</td><td>${c.kind}</td><td class="msg">${d ? `<span style="color:${passColor(d.pass)}">p${d.pass}</span> ${d.message} (${d.snr} dB)` : '—'}</td>`; if (app.selected === c) tr.classList.add('sel'); tr.onclick = () => { focusOn(c.bin, c.lag); app.select(c); }; t.append(tr); });
      listWrap.append(t);
    }
    /** Move the highlight instead of rebuilding the table, which would scroll it back to the top. */
    function markSelected() { const rows = listWrap.querySelectorAll('tr'); const cands = current().candidates; for (let i = 1; i < rows.length; i++) rows[i].classList.toggle('sel', cands[i - 1] === app.selected); }
    function focusOn(bin, lag) { st.focus = { bin, lag }; if (st.mode === 'lag') { app.clock.pause(); app.clock.seek((lag + JZ + 0.5) / (2 * JZ + 1) * app.clock.duration); } drawSurface(); drawCross(); drawTemplate(); drawAux(); }
    function drawAll() { lastKey = null; drawSpectrum(); drawSurface(); drawCross(); drawTemplate(); drawAux(); drawStats(); drawList(); }

    const pickFromSurface = (e, cv, useJpeak) => { const r = cv.getBoundingClientRect(); const [f0, f1] = fr(); const W = cv.w - L - 10, H = cvU.h - T - 28; const f = f0 + (e.clientX - r.left - L) / W * (f1 - f0); const s = app.surf; const bin = Math.max(0, Math.min(s.nb - 1, Math.round((f - s.freqs[0]) / s.df))); const lag = useJpeak ? app.hits.jpeak[bin] : Math.max(-JZ, Math.min(JZ, Math.round((e.clientY - r.top - T) / H * 2 * JZ - JZ))); focusOn(bin, lag); const c = app.candidates.find(c => c.bin === bin) || { freq: s.freqs[bin], dt: (lag - 0.5) * 0.04, score: app.hits.red[bin], bin, lag, kind: 'manual' }; app.select(c); };
    cvU.addEventListener('mousemove', e => { const r = cvU.getBoundingClientRect(); const [f0, f1] = fr(); const W = cvU.w - L - 10, H = cvU.h - T - 28; const f = f0 + (e.clientX - r.left - L) / W * (f1 - f0), lag = (e.clientY - r.top - T) / H * 2 * JZ - JZ; hover.textContent = `${f.toFixed(1)} Hz, lag ${lag.toFixed(0)} (DT ${((lag - 0.5) * 0.04).toFixed(2)} s)`; });
    cvU.addEventListener('click', e => pickFromSurface(e, cvU, false));
    cvS.addEventListener('click', e => pickFromSurface(e, cvS, true));

    // The clock is quantized in every mode (125 lags, one bin per step, 4 spectrogram rows), so
    // most frames land on the same picture. Redraw only when the quantized position changes.
    let lastKey = null;
    const tickKey = () => st.mode === 'lag' ? 'l' + curLag() : st.mode === 'freq' ? 'f' + curFreqBin() : 'c' + causalRows();
    st.unsubs.push(app.clock.subscribe(() => {
      const k = tickKey(); if (k === lastKey) return; lastKey = k;
      if (st.mode === 'causal') { drawSpectrum(); drawSurface(); drawCross(); drawTemplate(); drawAux(); drawStats(); drawList(); }
      else { drawCross(); drawTemplate(); if (st.mode === 'freq') drawAux(); }
    }));
    st.unsubs.push(app.on(k => { if (k === 'sync') { st.causalCache.clear(); if (st.mode === 'causal') buildLadder(); drawAll(); } if (k === 'select') markSelected(); }));

    if (app.selected && app.selected.bin != null) st.focus = { bin: app.selected.bin, lag: app.selected.lag };
    else if (app.selected) { const s = app.surf; const bin = Math.round((app.selected.freq - s.freqs[0]) / s.df); if (bin >= 0 && bin < s.nb) st.focus = { bin, lag: Math.round(app.selected.dt / 0.04 + 0.5) }; }
    if (st.focus) V.center = app.surf.freqs[st.focus.bin];
    setupMode(); drawAll();
    if (st.mode === 'causal') buildLadder();
    this.setTab = (id) => { if (!id || id === st.mode || !MODES.some(m => m[0] === id)) return; st.mode = id; tabs.set(id); setupMode(); drawAll(); if (id === 'causal') buildLadder(); else st.ladderToken++; };
  },
  setTab: null,
  // The causal ladder is ~60 MB of sync surfaces. It rebuilds in about two seconds with a
  // progress readout, so hold it only while the page is open rather than for the whole session.
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.setTab = null; st.ladderToken++; st.causalCache.clear(); st.ladderProgress = null; },
};
