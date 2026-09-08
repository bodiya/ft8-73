// Stage 2: one candidate -> baseband -> fine sync -> the 79x8 tone grid.
//
// The grid and the baseband envelope depend only on the selected candidate and the nudge
// controls, so they are drawn once per decode into background layers. The transport clock moves
// a one-symbol cursor, which is all the overlay draws.
import { decodeCandidate } from '../dsp/pipeline.js';
import { COSTAS, GRAY_MAP_INV, costasTone, isSyncSymbol } from '../dsp/constants.js';
import { binMag, binPower } from '../dsp/finesync.js';
import { NP2 } from '../dsp/downsample.js';
import { slider, select, checkbox, el, panel, canvas, layers } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, text, hline, vline, clear, passColor, linePlot } from '../ui/draw.js';

const st = { p: { dtNudge: 0, freqNudge: 0, power: false, depth: 3, showBits: false }, trace: null, unsubs: [] };

export function candidateTable(parent, app, onpick) {
  const wrap = el('div', 'scroll'); wrap.style.maxHeight = '260px'; parent.append(wrap);
  const render = () => {
    wrap.innerHTML = ''; const t = el('table', 'list'); t.innerHTML = '<tr><th>#</th><th>score</th><th>freq</th><th>DT</th><th class="msg">wsjtr decode nearby</th></tr>';
    (app.candidates || []).forEach((c, i) => { const tr = el('tr'); const d = app.truthFor(c); tr.innerHTML = `<td>${i + 1}</td><td>${c.score.toFixed(2)}</td><td>${c.freq.toFixed(1)}</td><td>${c.dt.toFixed(2)}</td><td class="msg">${d ? `<span style="color:${passColor(d.pass)}">p${d.pass}</span> ${d.message}` : '—'}</td>`; if (app.selected === c) tr.classList.add('sel'); tr.onclick = () => onpick(c); t.append(tr); });
    wrap.append(t);
  };
  render(); return render;
}

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); this.mount(root, app); } }); return; }
    const p = st.p; app.clock.setDuration(79 * 0.16);
    if (!app.selected) app.select(app.candidates[0]);
    root.append(el('h1', null, '2 · One candidate: baseband, fine sync, and the tone grid'));
    root.append(el('p', 'blurb', 'A candidate is just (frequency, DT, score). To read its tones the decoder takes a 192 000-point FFT of the whole window, cuts out a ~62 Hz slice around the candidate frequency, tapers the edges and inverse-FFTs it into 200 Hz complex baseband: 32 samples per symbol, carrier at DC, everything else on the band filtered away. Then a coherent matched filter for the three Costas arrays refines the start time in 5 ms steps (±50 ms) and the frequency in 0.5 Hz steps (±2.5 Hz), the slice is re-cut at the refined frequency and time is refined again (±20 ms). Finally each of the 79 symbols is a 32-point FFT whose first 8 bins are the 8 tones. That 79 × 8 grid is what the rest of the decoder sees. Play to step through the symbols; drag the nudge sliders to misalign the grid on purpose.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div'); main.style.flex = '1'; row.append(main);
    const gridP = panel(main, 'Tone grid: 79 symbols (→) × 8 tones (↑). Orange = expected Costas tone, dot = strongest tone, green = tone of the decoded message where it differs'); const [cvG, cvGo] = layers(gridP, 1000, 230);
    const bbP = panel(main, 'Baseband envelope |x(t)| at 200 Hz with the symbol boundaries'); const [cvB, cvBo] = layers(bbP, 1000, 100);
    const curves = el('div', 'row'); main.append(curves);
    const c1P = panel(curves, 'Fine sync, step 1: time search ±10 samples (5 ms each)'); const cv1 = canvas(c1P, 310, 150);
    const c2P = panel(curves, 'Step 2: frequency tweak ±2.5 Hz'); const cv2 = canvas(c2P, 310, 150);
    const c3P = panel(curves, 'Step 3: time refine ±4 after re-cutting the slice'); const cv3 = canvas(c3P, 310, 150);
    const infoP = panel(main, 'Readout'); const info = el('div', 'stats'); infoP.append(info);
    const pickP = panel(main, 'Pick a candidate'); const renderTable = candidateTable(pickP, app, c => app.select(c));

    slider(ctl, { label: 'time nudge (after fine sync)', min: -32, max: 32, step: 1, value: p.dtNudge, fmt: v => `${v} smp = ${(v * 5)} ms`, oninput: v => { p.dtNudge = v; run(); } });
    slider(ctl, { label: 'frequency nudge (after fine sync)', min: -8, max: 8, step: 0.25, value: p.freqNudge, fmt: v => v.toFixed(2) + ' Hz', oninput: v => { p.freqNudge = v; run(); } });
    checkbox(ctl, { label: 'show power |x|² instead of magnitude', value: p.power, onchange: v => { p.power = v; drawGridBg(); drawOverlays(); } });
    checkbox(ctl, { label: 'label cells with Gray-decoded 3-bit values', value: p.showBits, onchange: v => { p.showBits = v; drawGridBg(); drawOverlays(); } });
    select(ctl, { label: 'depth (sync gate strictness)', options: [[1, '1: need nsync > 8'], [2, '2: need nsync > 8'], [3, '3: nsync > 6 (amp) / > 7 (pow)']], value: p.depth, onchange: v => { p.depth = +v; run(); } });
    ctl.append(el('div', 'note', 'nsync counts how many of the 21 Costas symbols have their expected tone as the strongest bin. Below the gate the candidate is abandoned before any LDPC work. The nudges are applied after the decoder\'s own refinement, so they show what would happen if fine sync had landed there.'));
    const goto = el('div', 'note'); goto.innerHTML = '<a href="#ldpc" style="color:var(--accent)">→ take these tones to stage 3 (LLRs + LDPC)</a>'; ctl.append(goto);

    function run() { const c = app.selected; if (!c) return; st.trace = decodeCandidate(app.getCtx(), c, { dtNudge: p.dtNudge, freqNudge: p.freqNudge, depth: p.depth }); app.trace = st.trace; st.snrBase = null; drawAll();
      const tr = st.trace; if (tr.result) app.getBaseline().then(b => { if (st.trace !== tr) return; const xb = b.mod.xbaseFromSbaseDb(b.sbaseDb, tr.freq); const { xsig, xnoi } = b.mod.signalAndNoisePower(tr.bins, tr.result.tones); const v = b.mod.computeXsnrDb(tr.syncQuality.nsync, xsig, xnoi, xb); st.snrBase = v ? Math.round(Math.max(-25, v.snr)) : null; drawInfo(); }); }
    const L = 48, T = 6;
    function curSym() { return Math.min(78, Math.floor(app.clock.t / 0.16)); }

    function drawGridBg() {
      const g = cvG.g, tr = st.trace; clear(cvG); if (!tr) return; const W = cvG.w - L - 8, H = cvG.h - T - 26; const cw = W / 79, ch = H / 8;
      const data = new Float32Array(79 * 8); let vals = []; for (let s = 0; s < 79; s++) for (let t = 0; t < 8; t++) { const v = p.power ? binPower(tr.bins, s, t) : binMag(tr.bins, s, t); data[(7 - t) * 79 + s] = v; vals.push(v); }
      vals.sort((a, b) => a - b); const vmax = vals[Math.floor(vals.length * 0.985)] || 1;
      heatmap(g, { data, rows: 8, cols: 79, x: L, y: T, w: W, h: H, vmin: 0, vmax, cmap: 'viridis', nearest: true });
      for (let s = 0; s < 79; s++) {
        const x = L + s * cw; const ct = costasTone(s);
        if (ct >= 0) { g.strokeStyle = '#ff8c42'; g.lineWidth = 1.2; g.strokeRect(x + 0.5, T + (7 - ct) * ch + 0.5, cw - 1, ch - 1); }
        const ht = tr.hardTones[s]; g.fillStyle = '#fff'; g.beginPath(); g.arc(x + cw / 2, T + (7 - ht) * ch + ch / 2, 1.8, 0, 7); g.fill();
        if (tr.result && tr.result.tones[s] !== ht) { g.strokeStyle = '#3ddc97'; g.lineWidth = 1.5; g.strokeRect(x + 1.5, T + (7 - tr.result.tones[s]) * ch + 1.5, cw - 3, ch - 3); }
        if (p.showBits && !isSyncSymbol(s)) text(g, GRAY_MAP_INV[ht].toString(2).padStart(3, '0'), x + cw / 2, T + H + 2, { color: '#8b93a3', align: 'center', font: '8px monospace' });
      }
      for (const s0 of [0, 36, 72]) { g.fillStyle = 'rgba(255,140,66,0.15)'; g.fillRect(L + s0 * cw, T, 7 * cw, H); }
      axisY(g, { x: L, y: T, h: H, min: -0.5, max: 7.5, ticks: [0, 1, 2, 3, 4, 5, 6, 7], fmt: v => 'tone ' + v });
      if (!p.showBits) axisX(g, { x: L, y: T + H, w: W, min: -0.5, max: 78.5, ticks: [0, 7, 36, 43, 72, 78], fmt: v => 'sym ' + v });
    }
    function drawBasebandBg() {
      const g = cvB.g, tr = st.trace; clear(cvB); if (!tr) return; const W = cvB.w - L - 8, H = cvB.h - T - 22; const cd = tr.cd1;
      const xs = [], ys = []; let m = 0; for (let i = 0; i < NP2; i++) { const v = Math.hypot(cd.re[i], cd.im[i]); xs.push(i); ys.push(v); if (v > m) m = v; }
      linePlot(g, { xs, ys, x: L, y: T, w: W, h: H, xmin: 0, xmax: NP2, ymin: 0, ymax: m * 1.05, color: '#4ea1ff', width: 0.8 });
      const sx = i => L + i / NP2 * W;
      for (let s = 0; s <= 79; s++) { const i = tr.ibest2 + s * 32; vline(g, sx(i), T, H, s % 36 === 0 || s === 79 || s === 43 || s === 7 ? '#ff8c42' : 'rgba(255,255,255,0.12)'); }
      for (const s0 of [0, 36, 72]) { g.fillStyle = 'rgba(255,140,66,0.18)'; g.fillRect(sx(tr.ibest2 + s0 * 32), T, sx(tr.ibest2 + (s0 + 7) * 32) - sx(tr.ibest2 + s0 * 32), H); }
      axisX(g, { x: L, y: T + H, w: W, min: 0, max: NP2 / 200, ticks: ticks(0, NP2 / 200, 7), fmt: v => v + ' s' });
    }
    /** The symbol cursor on both plots: everything the clock touches. */
    function drawOverlays() {
      const tr = st.trace; const g = cvGo.g; clear(cvGo); const gb = cvBo.g; clear(cvBo); if (!tr) return;
      const sym = curSym();
      const W = cvG.w - L - 8, H = cvG.h - T - 26, cw = W / 79;
      g.strokeStyle = '#ff5c5c'; g.lineWidth = 1.5; g.strokeRect(L + sym * cw, T, cw, H);
      text(g, `symbol ${sym}: ${isSyncSymbol(sym) ? 'Costas sync, expected tone ' + costasTone(sym) : 'data'}, strongest tone ${tr.hardTones[sym]}` + (tr.result ? `, decoded tone ${tr.result.tones[sym]}` : ''), L + W, T + 2, { align: 'right', bg: 'rgba(0,0,0,0.6)' });
      const W2 = cvB.w - L - 8, H2 = cvB.h - T - 22;
      vline(gb, L + (tr.ibest2 + sym * 32 + 16) / NP2 * W2, T, H2, '#ff5c5c');
    }
    function drawCurve(cv, pts, xkey, best, xfmt) {
      const g = cv.g; clear(cv); const Lx = 40, W = cv.w - Lx - 8, H = cv.h - T - 24; const xs = pts.map(q => q[xkey]), ys = pts.map(q => q.sync); const ymax = Math.max(...ys) * 1.05 || 1;
      linePlot(g, { xs, ys, x: Lx, y: T, w: W, h: H, xmin: xs[0], xmax: xs[xs.length - 1], ymin: 0, ymax, color: '#4ea1ff', width: 1.5 });
      const bx = Lx + (best - xs[0]) / (xs[xs.length - 1] - xs[0]) * W; vline(g, bx, T, H, '#ff8c42', [3, 3]);
      axisX(g, { x: Lx, y: T + H, w: W, min: xs[0], max: xs[xs.length - 1], ticks: ticks(xs[0], xs[xs.length - 1], 4), fmt: xfmt }); axisY(g, { x: Lx, y: T, h: H, min: 0, max: ymax, ticks: [0, ymax / 2, ymax], fmt: v => v.toExponential(0) });
    }
    function drawInfo() {
      const tr = st.trace, c = tr.cand, d = app.truthFor(c); const sq = tr.syncQuality;
      const bad = sq.perSymbol.filter(q => !q.ok).map(q => q.sym);
      info.innerHTML = `candidate: <b>${c.freq.toFixed(1)} Hz, DT ${c.dt.toFixed(2)} s</b>, coarse score ${c.score != null ? c.score.toFixed(2) : '—'}${d ? ` — wsjtr decoded <b>${d.message}</b> here on pass ${d.pass} (${d.snr} dB)` : ''}<br>`
        + `fine sync: time best at sample ${tr.fineSync.ibest} (Δ ${((tr.fineSync.ibest - Math.round((c.dt + 0.5) * 200)) * 5)} ms), frequency tweak ${tr.fineSync.delf >= 0 ? '+' : ''}${tr.fineSync.delf.toFixed(1)} Hz, refine Δ ${(tr.timeRefine.ibest2 - tr.fineSync.ibest) * 5} ms → <b>${tr.freq.toFixed(2)} Hz, DT ${tr.dt.toFixed(3)} s</b><br>`
        + `nsync = <b>${sq.nsync} / 21</b>${bad.length ? ` (wrong at symbols ${bad.join(', ')})` : ''}; sync gate: amplitude metric ${tr.allowAmp ? '<span class="pill ok">pass</span>' : '<span class="pill bad">blocked</span>'} power metric ${tr.allowPow ? '<span class="pill ok">pass</span>' : '<span class="pill bad">blocked</span>'}<br>`
        + (tr.result ? `decoded: <b>${tr.result.message.text}</b> (type ${tr.result.message.type}, LLR set ${tr.result.metric}/${tr.result.pass} via ${tr.result.how}${tr.result.ap ? ' with AP' + tr.result.ap : ''}, BP iterations ${tr.result.bp.iterations.length - 1}, hard errors ${tr.result.hardErrors}/174, SNR ${st.snrBase != null ? '<b>' + st.snrBase + ' dB</b> (baseline method, as wsjtr reports)' : ''}; tone-vs-off-tone estimate ${tr.snrEstimate.toFixed(0)} dB)` : `<b>no decode</b> at depth ${p.depth} (${tr.attempts.filter(a => !a.skipped).length} attempts)`)
        + `<br>hard tones: <span class="bits">${Array.from(tr.hardTones).join(' ')}</span>`;
    }
    function drawAll() { const tr = st.trace; if (!tr) return; drawGridBg(); drawBasebandBg(); drawOverlays(); drawCurve(cv1, tr.fineSync.timeCurve, 'idt', tr.fineSync.ibest, v => ((v - Math.round((tr.cand.dt + 0.5) * 200)) * 5) + 'ms'); drawCurve(cv2, tr.fineSync.freqCurve, 'delf', tr.fineSync.delf, v => v + 'Hz'); drawCurve(cv3, tr.timeRefine.curve, 'idt', tr.timeRefine.ibest2 - tr.fineSync.ibest, v => (v * 5) + 'ms'); drawInfo(); renderTable(); }
    st.unsubs.push(app.clock.subscribe(() => drawOverlays()));
    st.unsubs.push(app.on(k => { if (k === 'select') run(); if (k === 'sync') renderTable(); }));
    run();
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; },
};
