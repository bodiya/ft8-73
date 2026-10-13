// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Stage 1: coarse sync. Sync spectrum + full surface + three animated views of the template, with the real knobs.
//
// Performance shape: the sync spectrum and the surface depend only on the sync parameters (and,
// in the causal view, on how much audio has been heard), so they sit on background layers and the
// clock only moves a crosshair. The causal view needs a whole new sync surface every 0.16 s of
// clock time, which is far too much to do inside a frame, so the surfaces of the ladder (84 of
// them, 28 on a phone) are computed in the background as soon as that view opens and simply
// looked up during playback.
import { syncAt, syncSurface, syncHits, dedupeCandidates } from '../dsp/sync.js';
import { COSTAS, JZ } from '../dsp/constants.js';
import { slider, select, checkbox, el, panel, canvas, layers, tabbar, caption, tryThis, isNarrow, coarse, constrained, fitW, resizePlot, onPlot } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, hline, vline, clear, passColor, linePlot } from '../ui/draw.js';

const st = { view: { span: 0, center: 1600, vmax: 5, ymax: 8, rings: true }, spanPicked: false, focus: null, mode: 'lag', causalCache: new Map(), ladderToken: 0, unsubs: [] };
const MODES = [['lag', 'lag sweep'], ['freq', 'frequency sweep'], ['causal', 'causal reveal']];
const CAPTIONS = {
  lag: ['slides the template through all 125 lags at the focused frequency, 0.1 s per lag.', 'the score spiking at one lag. That peak, divided by the noise floor, is the whole candidate test.'],
  freq: ['slides the template across the zoom span at the focused lag, one sweep per 10 s.', 'how narrow each peak is in frequency. Set a 250 Hz zoom span to slow the sweep down enough to follow.'],
  causal: ['plays the window in real time and re-runs the whole search on the audio heard so far.', 'real signals clearing the threshold only once two of the three Costas arrays have arrived, at 7.4 s. That is why a decoder can start before the slot ends.'],
};
// Spectrogram rows per causal step (4 rows = one symbol = 0.16 s). Set at mount, because the
// ladder is one whole sync surface per step: 84 of them is 61 MB, which on a phone is the single
// most likely reason for the tab to be reloaded under memory pressure. A constrained device gets
// 12 rows (0.48 s, 28 surfaces, ~20 MB) and the teaching point survives.
let LADDER_STEP = 4;

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); root.textContent = ''; this.mount(root, app); } }); st.unsubs.push(off); return; }  // cancelled by unmount if you navigate away first
    const P = app.syncParams, V = st.view;
    LADDER_STEP = constrained() ? 12 : 4;
    const ladderBudget = constrained() ? 6 : 12;   // ms of ladder building per timeout, so touch scrolling stays smooth
    let narrow = isNarrow();
    // A phone in landscape is 390 px tall: a 380 px plot fills the whole viewport, so the short
    // heights are for it too. Same test the stylesheet uses for its landscape rules.
    const shortView = () => coarse() && document.documentElement.clientHeight < 500;
    let compact = narrow || shortView();
    // Full range on a phone-width canvas is 13.9 Hz per pixel: a fingertip covers ~470 Hz, so no
    // candidate can be picked by tapping. 600 Hz of span is 2.2 Hz/px, finer than the desktop
    // full-range view. Only as a default: once the reader picks a span it sticks.
    if (narrow && !st.spanPicked && !V.span) V.span = 600;
    const want = app.tabFor('sync', MODES.map(m => m[0])); if (want) st.mode = want;
    app.canonicalTab(st.mode);
    root.append(el('h1', null, '1 · Coarse sync: finding candidates with the Costas arrays'));
    root.append(el('p', 'blurb', 'Every FT8 transmission carries the same 7-tone Costas pattern [3 1 4 0 6 5 2] three times: at symbols 0, 36 and 72. The decoder computes a spectrogram with 3.125 Hz bins and 40 ms steps (2 bins per tone, 4 rows per symbol) and, for every start frequency and every start time (lag), sums the power in the 21 cells where the Costas tones should be, divided by the mean power in the other 6 tone slots of those same symbols. That ratio is the sync score. The surface below is that score for every frequency bin × 125 lags (±2.48 s). Collapse it over lag (keeping the best lag in a ±0.52 s window) and you get the sync spectrum; divide by its 40th percentile so "1.0" means "typical noise", threshold, then dedupe nearby hits → the candidate list. The three views above animate the same computation three ways.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const tabs = tabbar(main, MODES, st.mode, id => app.setTab(id));
    const cap = caption(main);
    // Guided settings for the same knobs the panel exposes. Each one starts from the wsjtr defaults
    // and changes exactly one thing, so the numbers quoted below hold whichever button you press
    // first. They were read off this page on the bundled window; keep them in step with the code.
    const D = { basePct: 0.40, syncMin: 1.2, mlag: 13, maxCandidates: 200, dtTol: 0.04, freqTol: 4, useRed2: true, freqMin: 200, freqMax: 4007 };
    const W = {};   // param name -> control widget, filled in once the panel below is built
    const expt = (over) => { Object.assign(P, D, over); for (const k in P) if (W[k]) W[k].value = P[k]; rerun(); };
    tryThis(main, [
      { label: 'cap the list at 30', see: 'Candidates drop from <b>200</b> to <b>30</b>, and reference pass-1 decodes with a candidate falls from <b>18/18</b> to <b>11/18</b>. The cap, not the threshold, is what decides how much of the band you can still decode.',
        run: () => expt({ maxCandidates: 30 }) },
      { label: 'threshold 3.0', see: 'Raw hits fall from <b>897</b> to <b>162</b>, and every one of the <b>18/18</b> pass-1 decodes still has a candidate. Real signals clear the noise floor by a wide margin; the low default is there for the weak ones.',
        run: () => expt({ syncMin: 3 }) },
      { label: 'threshold 0.8', see: 'Raw hits hit the <b>1000</b> cap, and the numbers that matter do not move: still 200 candidates, still <b>18/18</b> pass 1. Once the budget is full, lowering the bar buys nothing.',
        run: () => expt({ syncMin: 0.8 }) },
      { label: 'short-lag only', see: 'Turning off the full ±2.48 s search drops the largest |DT| in the list from <b>2.50 s</b> to <b>0.54 s</b>. One pass-1 decode loses its candidate, but later-pass coverage rises, because the two searches share one 200-slot budget.',
        run: () => expt({ useRed2: false }) },
      { label: '90th percentile floor', see: 'The floor moves from <b>2.00</b> to <b>5.08</b>, so the same 1.20 threshold now asks for a raw score of <b>6.1</b> instead of 2.4, and hits fall from <b>897</b> to <b>150</b>. This is what "normalize, then threshold" is actually doing.',
        run: () => expt({ basePct: 0.9 }) },
      { label: 'wsjtr defaults', see: '40th percentile, threshold 1.20, ±13 lags, full-lag search on, 200 candidates, dedupe within 4 Hz and 0.04 s.',
        run: () => expt({}) },
    ], () => app.name === '260726_190930' ? '' : ' <i>Numbers here were measured on the bundled window, not the one you have loaded.</i>');
    // First guess only: applySizes() below re-fits every canvas to the column it landed in. It
    // starts narrow on a phone so the page never allocates the 21 MB of desktop backing store.
    const W0 = narrow ? 320 : 1000, W1 = narrow ? 320 : 430;
    const specP = panel(main, 'Sync spectrum: best score per frequency bin ÷ noise floor'); const specL = layers(specP, W0, compact ? 170 : 190); const [cvSb, cvS] = specL;
    const surfP = panel(main, 'Sync surface: score vs frequency (→) and time offset DT (↓)'); const surfL = layers(surfP, W0, compact ? 340 : 380); const [cvUb, cvU] = surfL;
    const hover = el('div', 'stats', ' '); surfP.append(hover); const lg = el('div', 'legend'); lg.innerHTML = '<span>○ white = kept candidate (purple = found via the full-lag red2 search)</span><span>○ colored ring = reference decode (blue p1, green p2, yellow p3, purple A7)</span><span>lighter band = the short-lag window</span>'; surfP.append(lg);
    // The template column goes beside the candidate list, not beside the plots: as a third column of
    // .row it needed 280 + 1067 + 460 + gaps, more than the 1468 px main gets at its max width, so it
    // always wrapped to a line of its own at the far left, under the controls.
    const bottom = el('div', 'row'); main.append(bottom);
    const listP = panel(bottom, 'Candidate list (after dedupe, strongest first)'); const listWrap = el('div', 'scroll'); listP.append(listWrap);   // width pinned in applySizes(): a fixed share of the row so the template column does not slide sideways as the causal list fills
    const side = el('div', 'controls'); bottom.append(side);
    const tmplP = panel(side, 'The template on the spectrogram'); const cvT = canvas(tmplP, W1, compact ? 340 : 380);
    // Four lines of .stats reserved: the readout is three lines and grows to four when there is a
    // reference decode to name, and without this the panels below it move. In em, not px, because
    // at phone width the same text wraps to nine or ten lines and a px floor is then a lie.
    const tinfo = el('div', 'stats'); tinfo.style.minHeight = '6em'; tmplP.append(tinfo);
    const auxP = panel(side, 'Score along the sweep'); const cvA = canvas(auxP, W1, 150); const ainfo = el('div', 'note'); auxP.append(ainfo);
    const stats = panel(side, 'Counts'); const statsTxt = el('div', 'stats'); stats.append(statsTxt);

    const rerun = () => { st.causalCache.clear(); app.recomputeSync(); };
    const slPct = slider(ctl, { label: 'noise-floor percentile', min: 0.05, max: 0.95, step: 0.05, value: P.basePct, fmt: v => (v * 100).toFixed(0) + 'th', oninput: v => { P.basePct = v; rerun(); } });
    const slThresh = slider(ctl, { label: 'sync threshold (× floor)', min: 0.5, max: 6, step: 0.05, value: P.syncMin, fmt: v => v.toFixed(2), oninput: v => { P.syncMin = v; rerun(); } });
    const slMlag = slider(ctl, { label: 'short-lag window ±', min: 0, max: 62, step: 1, value: P.mlag, fmt: v => `${v} = ±${(v * 0.04).toFixed(2)} s`, oninput: v => { P.mlag = v; rerun(); } });
    const cbRed2 = checkbox(ctl, { label: 'also keep best over the full ±2.48 s (red2)', value: P.useRed2, onchange: v => { P.useRed2 = v; rerun(); } });
    const slMax = slider(ctl, { label: 'max candidates', min: 10, max: 1000, step: 10, value: P.maxCandidates, oninput: v => { P.maxCandidates = v; rerun(); } });
    slider(ctl, { label: 'dedupe: freq tolerance', min: 0, max: 25, step: 0.5, value: P.freqTol, fmt: v => v + ' Hz', oninput: v => { P.freqTol = v; rerun(); } });
    slider(ctl, { label: 'dedupe: DT tolerance', min: 0, max: 0.5, step: 0.01, value: P.dtTol, fmt: v => v.toFixed(2) + ' s', oninput: v => { P.dtTol = v; rerun(); } });
    const slFmin = slider(ctl, { label: 'search freq min', min: 100, max: 3000, step: 50, value: P.freqMin, fmt: v => v + ' Hz', oninput: v => { P.freqMin = v; rerun(); } });
    const slFmax = slider(ctl, { label: 'search freq max', min: 500, max: 4007, step: 50, value: P.freqMax, fmt: v => v + ' Hz', oninput: v => { P.freqMax = v; rerun(); } });
    W.basePct = slPct; W.syncMin = slThresh; W.mlag = slMlag; W.maxCandidates = slMax; W.useRed2 = cbRed2; W.freqMin = slFmin; W.freqMax = slFmax;
    ctl.append(el('h3', null, 'view'));
    select(ctl, { label: 'zoom span', options: [[0, 'full range'], [1500, '1500 Hz'], [600, '600 Hz'], [250, '250 Hz'], [100, '100 Hz']], value: V.span, onchange: v => { V.span = +v; st.spanPicked = true; drawAll(); } });
    slider(ctl, { label: 'zoom center', min: 200, max: 4000, step: 5, value: V.center, fmt: v => v + ' Hz', oninput: v => { V.center = v; drawAll(); } });
    slider(ctl, { label: 'color ceiling (score)', min: 2, max: 40, step: 1, value: V.vmax, oninput: v => { V.vmax = v; drawAll(); } });
    slider(ctl, { label: 'spectrum y max', min: 2, max: 60, step: 1, value: V.ymax, oninput: v => { V.ymax = v; drawAll(); } });
    checkbox(ctl, { label: 'draw candidate rings', value: V.rings, onchange: v => { V.rings = v; drawAll(); } });
    ctl.append(el('div', 'note', 'Defaults are wsjtr / WSJT-X defaults: 40th percentile, threshold 1.2, ±13 lags, 200 candidates, dedupe within 4 Hz and 0.04 s. Turn the rings off in the causal view: before two Costas arrays have arrived most of them are noise, which is the point but also a lot of clutter.'));

    // Left gutter and bottom margin of the wide plots. On a phone the gutter shrinks (the widest
    // y label there is "-2 s") and the bottom margin grows, to make room for a "Hz" axis title:
    // that is where the unit goes once it is too expensive to repeat on every tick.
    let L = 46, T = 6, B = 28;
    /**
     * Canvas sizes and the two column pins for the current viewport. Called at mount and from
     * resize(). The widths are measured with the plot column temporarily stretched: on a wide
     * screen it hugs its content, so measuring a panel would just hand back the width of the
     * canvas already inside it.
     */
    function applySizes() {
      narrow = isNarrow(); compact = narrow || shortView();
      L = narrow ? 34 : 46; B = narrow ? 40 : 28;
      // Bottom row. On a phone it is one column, and the template goes above the 200-row candidate
      // list because it is the payoff of every tap on the surface. The max-width has to be cleared,
      // not just unpinned: .controls caps itself at 280 px.
      listP.style.flex = narrow ? '1 1 100%' : '1 1 460px';
      side.style.minWidth = narrow ? '0' : '460px';
      side.style.maxWidth = narrow ? 'none' : '460px';
      side.style.order = narrow ? '-1' : '';
      // The hover readout sits above the surface on a phone, where a tapping finger covers what is
      // under it, and below it on a desktop, where the pointer is already at the top of the plot.
      surfP.insertBefore(hover, narrow ? surfL.box : lg);
      const wPlot = fitW(specP, 1000), wSide = fitW(tmplP, 430);
      resizePlot(specL, wPlot, compact ? 170 : 190);
      resizePlot(surfL, wPlot, compact ? 340 : 380);   // 125 lags on the y axis is the scarce direction, so this height is kept
      resizePlot(cvT, wSide, compact ? 340 : 380);
      resizePlot(cvA, wSide, 150);
    }
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
      app.clockFormat = st.mode === 'lag' ? () => `lag ${curLag()} · DT ${((curLag() - 0.5) * 0.04).toFixed(2)} s`
        : st.mode === 'freq' ? () => `${app.surf.freqs[curFreqBin()].toFixed(1)} Hz`
          : () => `heard ${(causalRows() * 0.04).toFixed(2)} s of ${app.duration.toFixed(1)} s`;
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
     * One surface is ~30 ms, and there are 84 of them (28 at the coarse phone step); chunking
     * through setTimeout keeps the page responsive while it runs and lets a mode change or an
     * unmount cancel it.
     */
    function buildLadder() {
      const token = ++st.ladderToken;
      const steps = []; for (let R = 0; R <= app.spec.rows; R += LADDER_STEP) steps.push(Math.min(R, app.spec.rows));
      let i = 0;
      const tick = () => {
        if (token !== st.ladderToken || st.mode !== 'causal') return;
        const t0 = performance.now();
        while (i < steps.length && performance.now() - t0 < ladderBudget) { causal(steps[i]); i++; }
        st.ladderProgress = i / steps.length;
        drawStats();
        if (i < steps.length) setTimeout(tick, 0); else { st.ladderProgress = 1; drawAux(); }
      };
      st.ladderProgress = 0; setTimeout(tick, 0);
    }
    /** The (surface, hits, candidates) being displayed. */
    function current() { if (st.mode === 'causal') return causal(causalRows()); return { surf: app.surf, hits: app.hits, candidates: app.candidates, dropped: app.dropped }; }

    /**
     * The x axis both wide plots share. Eight " Hz" labels are 324 px of text, which does not fit
     * on a 274 px phone axis, so there the count comes from the width and the unit moves to the
     * axis title (that is what the wider bottom margin B is for). The desktop axis is unchanged.
     */
    const hzAxis = (f0, f1, W) => narrow
      ? { min: f0, max: f1, ticks: ticks(f0, f1, tickCount(W, 44)), fmt: v => v, label: 'Hz' }
      : { min: f0, max: f1, ticks: ticks(f0, f1, 8), fmt: v => v + ' Hz' };
    function drawSpectrum() {
      const { surf: s, hits: h, candidates, dropped } = current(); const g = cvSb.g; clear(cvSb); const [f0, f1] = fr(); const W = cvSb.w - L - 10, H = cvSb.h - T - B;
      const fx = f => L + (f - f0) / (f1 - f0) * W, sy = v => T + H - Math.min(v, V.ymax) / V.ymax * H;
      const xs = [], ys = []; for (let i = 0; i < s.nb; i++) if (s.freqs[i] >= f0 - 5 && s.freqs[i] <= f1 + 5) { xs.push(s.freqs[i]); ys.push(Math.min(h.red[i], V.ymax)); }
      if (P.useRed2) { const x2 = [], y2 = []; for (let i = 0; i < s.nb; i++) if (s.freqs[i] >= f0 - 5 && s.freqs[i] <= f1 + 5) { x2.push(s.freqs[i]); y2.push(Math.min(h.red2[i], V.ymax)); } linePlot(g, { xs: x2, ys: y2, x: L, y: T, w: W, h: H, xmin: f0, xmax: f1, ymin: 0, ymax: V.ymax, color: '#5a6478', width: 1 }); }
      linePlot(g, { xs, ys, x: L, y: T, w: W, h: H, xmin: f0, xmax: f1, ymin: 0, ymax: V.ymax, color: '#4ea1ff', width: 1 });
      hline(g, L, W, sy(1), '#8b93a3', [2, 4]); text(g, 'floor = 1.0', L + W - 4, sy(1) - 13, { color: '#8b93a3', align: 'right', max: W - 8 });
      hline(g, L, W, sy(P.syncMin), '#ff8c42', [6, 3]); text(g, `threshold ${P.syncMin.toFixed(2)}`, L + 4, sy(P.syncMin) - 13, { color: '#ff8c42', max: W - 8 });
      if (V.rings) {
        for (const d of dropped) if (d.freq >= f0 && d.freq <= f1) { g.fillStyle = '#5a6478'; g.beginPath(); g.arc(fx(d.freq), sy(d.score), 2, 0, 7); g.fill(); }
        for (const c of candidates) if (c.freq >= f0 && c.freq <= f1) { g.fillStyle = c.kind === 'red2' ? '#c792ea' : '#ffffff'; g.beginPath(); g.arc(fx(c.freq), sy(c.score), 2.5, 0, 7); g.fill(); }
      }
      for (const d of ref()) if (d.freq >= f0 && d.freq <= f1) { g.fillStyle = passColor(d.pass); g.fillRect(fx(d.freq) - 1, T, 2, 6); }
      if (st.mode === 'causal') text(g, `heard ${(causalRows() * 0.04).toFixed(1)} s of ${app.duration.toFixed(1)} s`, L + W / 2, T, { align: 'center', bg: 'rgba(0,0,0,0.6)', max: W - 8 });
      axisX(g, { x: L, y: T + H, w: W, ...hzAxis(f0, f1, W) });
      axisY(g, { x: L, y: T, h: H, min: 0, max: V.ymax, ticks: ticks(0, V.ymax, 4) });
    }
    function drawSurface() {
      const { surf: s, hits: h, candidates } = current(); const g = cvUb.g; clear(cvUb); const [f0, f1] = fr(); const W = cvUb.w - L - 10, H = cvUb.h - T - B;
      const fx = f => L + (f - f0) / (f1 - f0) * W, ly = lag => T + (lag + JZ) / (2 * JZ) * H;
      const c0 = Math.max(0, Math.floor((f0 - s.freqs[0]) / s.df)), c1 = Math.min(s.nb, Math.ceil((f1 - s.freqs[0]) / s.df) + 1);
      const norm = h.base || 1;
      heatmap(g, { data: s.surface, rows: s.nl, cols: s.nb, x: fx(s.freqs[c0]), y: ly(-JZ - 0.5), w: fx(s.freqs[c1 - 1]) - fx(s.freqs[c0]), h: ly(JZ + 0.5) - ly(-JZ - 0.5), vmin: 0, vmax: V.vmax * norm, cmap: 'viridis', colRange: [c0, c1], nearest: V.span > 0 && V.span <= 250, pool: true });
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(L, ly(-P.mlag - 0.5), W, ly(P.mlag + 0.5) - ly(-P.mlag - 0.5));
      if (V.rings) for (const c of candidates) if (c.freq >= f0 && c.freq <= f1) { g.strokeStyle = c.kind === 'red2' ? '#c792ea' : '#ffffff'; g.lineWidth = 1; g.beginPath(); g.arc(fx(c.freq), ly(c.lag), 3.2, 0, 7); g.stroke(); }
      for (const d of ref()) if (d.freq >= f0 - 20 && d.freq <= f1 + 20) { g.strokeStyle = passColor(d.pass); g.lineWidth = 1.5; g.beginPath(); g.arc(fx(d.freq), ly(d.dt / 0.04 + 0.5), 7, 0, 7); g.stroke(); }
      axisX(g, { x: L, y: T + H, w: W, ...hzAxis(f0, f1, W) });
      axisY(g, { x: L, y: T, h: H, min: -JZ * 0.04, max: JZ * 0.04, ticks: [-2, -1, 0, 1, 2], fmt: v => v + ' s', flip: true });
    }
    /** Crosshair on the surface and the sweep marker on the spectrum: the only per-frame drawing. */
    function drawCross() {
      const s = app.surf; const [f0, f1] = fr();
      const gu = cvU.g; clear(cvU);
      if (st.focus || st.mode === 'freq') {
        const W = cvU.w - L - 10, H = cvU.h - T - B;
        const fx = f => L + (f - f0) / (f1 - f0) * W, ly = lag => T + (lag + JZ) / (2 * JZ) * H;
        vline(gu, fx(s.freqs[curFreqBin()]), T, H, '#ff5c5c', [3, 3]); hline(gu, L, W, ly(curLag()), '#ff5c5c', [3, 3]);
      }
      const gs = cvS.g; clear(cvS);
      if (st.mode === 'freq') { const W = cvS.w - L - 10, H = cvS.h - T - B; vline(gs, L + (s.freqs[curFreqBin()] - f0) / (f1 - f0) * W, T, H, '#ff5c5c', [3, 3]); }
    }
    function drawTemplate() {
      const g = cvT.g; clear(cvT); const s = app.surf, spec = app.spec;
      if (!st.focus && st.mode !== 'freq') { text(g, coarse() ? 'tap the surface or the spectrum to pick a point' : 'click the surface or the spectrum to pick a point', 10, 10, { color: '#8b93a3', max: cvT.w - 20 }); tinfo.textContent = ''; return; }
      const bin = curFreqBin() + s.ia, lag = curLag(); const maxRow = st.mode === 'causal' ? causalRows() : spec.rows;
      const nbShow = 26, b0 = Math.max(0, bin - nbShow), b1 = Math.min(spec.nbins, bin + nbShow + 14);
      const Lx = narrow ? 26 : 38, Ty = 6, W = cvT.w - Lx - 8, H = cvT.h - Ty - 26;
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
      axisX(g, { x: Lx, y: Ty + H, w: W, min: b0 * s.df, max: b1 * s.df, ticks: ticks(b0 * s.df, b1 * s.df, narrow ? tickCount(W, 44) : 4), fmt: v => v.toFixed(0) });
      axisY(g, { x: Lx, y: Ty, h: H, min: 0, max: spec.rows * 0.04, ticks: [0, 2, 4, 6, 8, 10, 12], fmt: v => v + 's', flip: true });
      const { hits } = current(); const bi = bin - s.ia;
      const tr = app.truthFor({ freq: bin * s.df, dt: (lag - 0.5) * 0.04 });
      tinfo.innerHTML = `f = <b>${(bin * s.df).toFixed(1)} Hz</b>, lag = <b>${lag}</b> (DT ${((lag - 0.5) * 0.04).toFixed(2)} s) → raw score <b>${r.score.toFixed(2)}</b> (all three arrays: ${r.abc.toFixed(2)}, last two only: ${r.bc.toFixed(2)}) = <b>${(r.score / (hits.base || 1)).toFixed(2)}</b> × floor. Best lag in ±${P.mlag} at this frequency: <b>${hits.jpeak[bi]}</b> → ${hits.red[bi].toFixed(2)}.` + (tr ? `<br>reference decode here: <b>${tr.message}</b> (pass ${tr.pass}, ${tr.snr} dB, DT ${tr.dt}).` : '<br>no reference decode within 6 Hz and 0.25 s of this point.');
    }
    function drawAux() {
      const g = cvA.g; clear(cvA); const Lx = narrow ? 26 : 34, W = cvA.w - Lx - 8, H = cvA.h - T - 24;
      if (st.mode === 'freq') {
        auxP.querySelector('h3').textContent = 'Score along the sweep (this lag, ÷ floor)';
        const s = app.surf, h = app.hits; const [f0, f1] = fr(); const lag = curLag(); const li = lag + JZ; const xs = [], ys = [];
        for (let i = 0; i < s.nb; i++) if (s.freqs[i] >= f0 && s.freqs[i] <= f1) { xs.push(s.freqs[i]); ys.push(Math.min(V.ymax, s.surface[li * s.nb + i] / (h.base || 1))); }
        linePlot(g, { xs, ys, x: Lx, y: T, w: W, h: H, xmin: f0, xmax: f1, ymin: 0, ymax: V.ymax, color: '#4ea1ff', width: 1 });
        hline(g, Lx, W, T + H - P.syncMin / V.ymax * H, '#ff8c42', [4, 3]);
        vline(g, Lx + (s.freqs[curFreqBin()] - f0) / (f1 - f0) * W, T, H, '#ff5c5c');
        axisX(g, { x: Lx, y: T + H, w: W, min: f0, max: f1, ticks: ticks(f0, f1, narrow ? tickCount(W, 44) : 5), fmt: v => v }); axisY(g, { x: Lx, y: T, h: H, min: 0, max: V.ymax, ticks: [0, V.ymax / 2, V.ymax], fmt: v => v });
        ainfo.textContent = `The template slides across the zoom span at the focus lag (${coarse() ? 'tap' : 'click'} the surface to change it). Narrow the zoom span to slow the sweep down.`;
      } else if (st.mode === 'causal') {
        auxP.querySelector('h3').textContent = 'Candidates found vs audio heard so far';
        const R = causalRows(); const xs = [], ys = []; for (const [k, v] of st.causalCache) { xs.push(k * 0.04); ys.push(v.candidates.length); }
        const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]); const sx = idx.map(i => xs[i]), sy = idx.map(i => ys[i]);
        const ymax = Math.max(10, ...sy) * 1.1;
        if (sx.length > 1) linePlot(g, { xs: sx, ys: sy, x: Lx, y: T, w: W, h: H, xmin: 0, xmax: app.duration, ymin: 0, ymax, color: '#4ea1ff', width: 1.5 });
        // "array C heard" sits at 13.14 s of a 13.4 s axis, so left-aligned it ran 51 px off the
        // right edge even at the desktop width. Flip the label to the left of its own line when it
        // would not fit, and on a phone there is only room for the letter.
        for (const [tt, lab, ab] of [[1.62, 'array A heard', 'A'], [7.38, 'array B heard', 'B'], [13.14, 'array C heard', 'C']]) {
          const px = Lx + tt / app.duration * W; vline(g, px, T, H, '#ff8c42', [3, 3]);
          const lb = narrow ? ab : lab, font = '9px system-ui';
          g.save(); g.font = font; const tw = g.measureText(lb).width; g.restore();
          const flip = px + 2 + tw > Lx + W;
          text(g, lb, flip ? px - 2 : px + 2, T + 2, { color: '#ff8c42', font, align: flip ? 'right' : 'left', max: flip ? px - Lx - 2 : Lx + W - px - 2 });
        }
        vline(g, Lx + R * 0.04 / app.duration * W, T, H, '#ff5c5c');
        axisX(g, { x: Lx, y: T + H, w: W, min: 0, max: app.duration, ticks: ticks(0, app.duration, narrow ? tickCount(W, 44) : 6), fmt: v => v + 's' }); axisY(g, { x: Lx, y: T, h: H, min: 0, max: ymax, ticks: ticks(0, ymax, 3), fmt: v => v.toFixed(0) });
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

    /** Canvas x/y on either wide plot -> the frequency and the (fractional) lag under it. The
     *  height comes from the canvas passed in: the two plots are no longer the same height. */
    const at = (cv, x, y) => { const [f0, f1] = fr(); const W = cv.w - L - 10, H = cv.h - T - B; return { f: f0 + (x - L) / W * (f1 - f0), lag: (y - T) / H * 2 * JZ - JZ }; };
    const showHover = (f, lag) => { hover.textContent = `${f.toFixed(1)} Hz, lag ${lag.toFixed(0)} (DT ${((lag - 0.5) * 0.04).toFixed(2)} s)`; };
    // A touch screen has no hover, so the pick fills the readout too: without it the line under
    // the surface stays blank forever on a phone and a tap never says what it landed on.
    const pick = (cv, x, y, useJpeak) => {
      const { f, lag: raw } = at(cv, x, y); const s = app.surf;
      const bin = Math.max(0, Math.min(s.nb - 1, Math.round((f - s.freqs[0]) / s.df)));
      const lag = useJpeak ? app.hits.jpeak[bin] : Math.max(-JZ, Math.min(JZ, Math.round(raw)));
      showHover(s.freqs[bin], lag);
      focusOn(bin, lag);
      const c = app.candidates.find(c => c.bin === bin) || { freq: s.freqs[bin], dt: (lag - 0.5) * 0.04, score: app.hits.red[bin], bin, lag, kind: 'manual' };
      app.select(c);
    };
    st.unsubs.push(onPlot(cvU, { onmove: (x, y) => { const { f, lag } = at(cvU, x, y); showHover(f, lag); }, onpick: (x, y) => pick(cvU, x, y, false) }));
    st.unsubs.push(onPlot(cvS, { onpick: (x, y) => pick(cvS, x, y, true) }));

    // The clock is quantized in every mode (125 lags, one bin per step, one ladder step), so most
    // frames land on the same picture. Redraw only when the quantized position changes.
    let lastKey = null;
    const tickKey = () => st.mode === 'lag' ? 'l' + curLag() : st.mode === 'freq' ? 'f' + curFreqBin() : 'c' + causalRows();
    /**
     * Counts and the candidate table, at most twice a second. drawList() wipes and rebuilds up to
     * 200 rows with innerHTML: 16 ms on a desktop and several times that on a phone, against a
     * causal step of 0.16 s, and every rebuild also throws away the reader's scroll position. The
     * trailing timer is what keeps the last step honest when the clock stops mid-throttle.
     */
    let heavyAt = 0, heavyTimer = 0;
    const heavyRefresh = () => {
      const wait = 500 - (performance.now() - heavyAt);
      if (wait <= 0) { clearTimeout(heavyTimer); heavyTimer = 0; heavyAt = performance.now(); drawStats(); drawList(); }
      else if (!heavyTimer) heavyTimer = setTimeout(() => { heavyTimer = 0; heavyAt = performance.now(); drawStats(); drawList(); }, wait);
    };
    st.unsubs.push(() => clearTimeout(heavyTimer));
    st.unsubs.push(app.clock.subscribe(() => {
      const k = tickKey(); if (k === lastKey) return; lastKey = k;
      if (st.mode === 'causal') { drawSpectrum(); drawSurface(); drawCross(); drawTemplate(); drawAux(); heavyRefresh(); }
      else { drawCross(); drawTemplate(); if (st.mode === 'freq') drawAux(); }
    }));
    st.unsubs.push(app.on(k => { if (k === 'sync') { st.causalCache.clear(); if (st.mode === 'causal') buildLadder(); drawAll(); } if (k === 'select') markSelected(); }));

    if (app.selected && app.selected.bin != null) st.focus = { bin: app.selected.bin, lag: app.selected.lag };
    else if (app.selected) { const s = app.surf; const bin = Math.round((app.selected.freq - s.freqs[0]) / s.df); if (bin >= 0 && bin < s.nb) st.focus = { bin, lag: Math.round(app.selected.dt / 0.04 + 0.5) }; }
    if (st.focus) V.center = app.surf.freqs[st.focus.bin];
    applySizes(); setupMode(); drawAll();
    if (st.mode === 'causal') buildLadder();
    // Rotation or a desktop zoom: re-fit the canvases to the new column and repaint. Cheaper and
    // less disruptive than app.js's fallback remount, which would drop the focused point.
    this.resize = () => { applySizes(); drawAll(); };
    this.setTab = (id) => { if (!id || !MODES.some(m => m[0] === id)) { app.canonicalTab(st.mode); return; } if (id === st.mode) return; st.mode = id; tabs.set(id); setupMode(); drawAll(); if (id === 'causal') buildLadder(); else st.ladderToken++; };
  },
  setTab: null,
  resize: null,
  // The causal ladder is ~60 MB of sync surfaces (~20 MB at the coarse phone step). It rebuilds in
  // about two seconds with a progress readout, so hold it only while the page is open rather than
  // for the whole session.
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.setTab = null; this.resize = null; st.ladderToken++; st.causalCache.clear(); st.ladderProgress = null; },
};
