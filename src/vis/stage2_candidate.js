// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Stage 2: one candidate -> baseband -> fine sync -> the 79x8 tone grid.
//
// The grid and the baseband envelope depend only on the selected candidate and the nudge
// controls, so they are drawn once per decode into background layers. The transport clock moves
// a one-symbol cursor, which is all the overlay draws.
import { decodeCandidate } from '../dsp/pipeline.js';
import { COSTAS, GRAY_MAP_INV, costasTone, isSyncSymbol } from '../dsp/constants.js';
import { binMag, binPower } from '../dsp/finesync.js';
import { NP2 } from '../dsp/downsample.js';
import { slider, select, checkbox, el, panel, canvas, layers, coalesce, caption, tryThis, fitW, resizePlot, isNarrow } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, text, hline, vline, clear, passColor, linePlot } from '../ui/draw.js';

const st = { p: { dtNudge: 0, freqNudge: 0, power: false, depth: 3, showBits: false }, trace: null, traceKey: null, unsubs: [] };

/**
 * The shared candidate list (stage 3 renders it too). On a phone it drops the index column and a
 * digit of frequency, which is what keeps 201 rows from needing a second, sideways scroll axis,
 * and the window grows to half the viewport: a 260 px box inside ~430 px of content area is a
 * scroll trap for a finger trying to move the page.
 */
export function candidateTable(parent, app, onpick) {
  const wrap = el('div', 'scroll'); parent.append(wrap);
  const render = () => {
    const narrow = isNarrow();
    wrap.style.maxHeight = narrow ? '50vh' : '260px';
    wrap.innerHTML = ''; const t = el('table', 'list'); t.innerHTML = `<tr>${narrow ? '' : '<th>#</th>'}<th>score</th><th>freq</th><th>DT</th><th class="msg">wsjtr decode nearby</th></tr>`;
    (app.candidates || []).forEach((c, i) => { const tr = el('tr'); const d = app.truthFor(c); tr.innerHTML = `${narrow ? '' : `<td>${i + 1}</td>`}<td>${c.score.toFixed(2)}</td><td>${c.freq.toFixed(narrow ? 0 : 1)}</td><td>${c.dt.toFixed(2)}</td><td class="msg">${d ? `<span style="color:${passColor(d.pass)}">p${d.pass}</span> ${d.message}` : '—'}</td>`; if (app.selected === c) tr.classList.add('sel'); tr.onclick = () => onpick(c); t.append(tr); });
    wrap.append(t);
  };
  render(); return render;
}

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); root.textContent = ''; this.mount(root, app); } }); st.unsubs.push(off); return; }  // cancelled by unmount if you navigate away first
    const p = st.p; app.clock.setDuration(79 * 0.16);
    app.clockFormat = () => `symbol ${curSym()} of 78`;
    if (!app.selected) app.select(app.candidates[0]);
    root.append(el('h1', null, '2 · One candidate: baseband, fine sync, and the tone grid'));
    root.append(el('p', 'blurb', 'A candidate is just (frequency, DT, score). To read its tones the decoder takes a 192 000-point FFT of the whole window, cuts out a ~62 Hz slice around the candidate frequency, tapers the edges and inverse-FFTs it into 200 Hz complex baseband: 32 samples per symbol, carrier at DC, everything else on the band filtered away. Then a coherent matched filter for the three Costas arrays refines the start time in 5 ms steps (±50 ms) and the frequency in 0.5 Hz steps (±2.5 Hz), the slice is re-cut at the refined frequency and time is refined again (±20 ms). Finally each of the 79 symbols is a 32-point FFT whose first 8 bins are the 8 tones. That 79 × 8 grid is what the rest of the decoder sees. Play to step through the symbols; drag the nudge sliders to misalign the grid on purpose.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const cap = caption(main); cap.set('steps through the 79 symbols, one every 160 ms, and the cursor marks that symbol in the grid and in the baseband envelope.', 'the white dot, the strongest tone in each column, sitting inside the orange box on all 21 Costas symbols. Counting those is exactly what nsync does.');
    // Each experiment starts from a clean alignment and moves one thing, so the numbers below hold
    // whichever you press first. All of them were read off the Readout panel for the default
    // candidate (737.5 Hz, the strongest decode in the bundled window).
    const D = { dtNudge: 0, freqNudge: 0, power: false, showBits: false, depth: 3 };
    let bitStep = 1;   // Gray-bit labels go on every bitStep'th column, 0 = no room; set by drawGridBg
    const expt = (over) => { Object.assign(p, D, over); slDt.value = p.dtNudge; slDf.value = p.freqNudge; cbBits.value = p.showBits; cbPow.value = p.power; run(); };
    tryThis(main, [
      { label: 'time off by 50 ms', see: 'Nothing breaks: <b>nsync 21/21</b>, <b>0</b> hard bit errors, same message. A third of a symbol of timing error costs nothing, which is why the coarse search only has to land within about half a symbol.',
        run: () => expt({ dtNudge: 10 }) },
      { label: 'time off by 70 ms', see: 'Now it hurts but holds: <b>nsync 13/21</b> and <b>14 of 174</b> bits come out wrong, and the message still decodes. Those 14 errors are what the LDPC code is there to absorb.',
        run: () => expt({ dtNudge: 14 }) },
      { label: 'time off by 80 ms', see: 'Half a symbol, and it falls off a cliff: <b>nsync 3/21</b>, the sync gate reads <b>blocked</b>, and the decoder abandons the candidate before doing any LDPC work at all. Cheap test first, expensive work second.',
        run: () => expt({ dtNudge: 16 }) },
      { label: 'frequency off by 3 Hz', see: 'Half a tone spacing (tones are 6.25 Hz apart): <b>nsync 13/21</b> and <b>20 of 174</b> bits wrong, and it still decodes. At 4 Hz the gate blocks it instead, so the whole usable window is about ±3 Hz.',
        run: () => expt({ freqNudge: 3 }) },
      { label: 'label the Gray bits', see: 'Each data column now shows the 3 bits its tone carries. Gray coding means neighbouring tones differ in one bit, so the most likely confusion costs one bit rather than three. These 174 bits are what stage 3 receives.',
        run: () => expt({ showBits: true }) },
      { label: 'perfect alignment', see: 'Back to the decoder\'s own fine sync: <b>nsync 21/21</b>, <b>0</b> hard errors, <b>CQ W3JFK FM09</b>.',
        run: () => expt({}) },
    ], () => (app.name === '260726_190930' ? '' : ' <i>Numbers here were measured on the bundled window, not the one you have loaded.</i>')
      // Said at click time, because on a narrow grid the bit labels are thinned to fit.
      + (p.showBits && bitStep > 1 ? ` <i>This screen is too narrow to label all of them: every ${bitStep}th data column is shown.</i>` : ''));
    const gridP = panel(main, 'Tone grid: 79 symbols (→) × 8 tones (↑). Orange = expected Costas tone, dot = strongest tone, green = tone of the decoded message where it differs');
    const bbP = panel(main, 'Baseband envelope |x(t)| at 200 Hz with the symbol boundaries');
    const curves = el('div', 'row'); main.append(curves);
    const c1P = panel(curves, 'Fine sync, step 1: time search ±10 samples (5 ms each)');
    const c2P = panel(curves, 'Step 2: frequency tweak ±2.5 Hz');
    const c3P = panel(curves, 'Step 3: time refine ±4 after re-cutting the slice');
    // The tone grid is the one plot here that cannot be shrunk to fit. 79 columns in 276 px is a
    // 3.5 px column, which makes the Costas strokeRect a 2.5 px box and the green mismatch box
    // 0.5 px wide; so the grid keeps a 520 px floor (6.5 px a column) and gridP scrolls sideways
    // under that (.panel is overflow-x:auto below 1100 px). Its height only owes ch = H/8 ~20 px.
    const sizes = () => ({
      gW: Math.max(520, fitW(gridP, 1000)), gH: isNarrow() ? 190 : 230,
      bW: fitW(bbP, 1000), bH: isNarrow() ? 80 : 100,
      cW: fitW(c1P, 310, 240), cH: 150,
    });
    const sz = sizes();
    const gridL = layers(gridP, sz.gW, sz.gH), [cvG, cvGo] = gridL;
    // The grid holds a 520 px floor inside a panel that pans sideways, so a horizontal drag has to
    // reach the scroller rather than being claimed by the canvas.
    for (const c of gridL) c.style.touchAction = 'pan-x pan-y';
    const bbL = layers(bbP, sz.bW, sz.bH), [cvB, cvBo] = bbL;
    const cv1 = canvas(c1P, sz.cW, sz.cH), cv2 = canvas(c2P, sz.cW, sz.cH), cv3 = canvas(c3P, sz.cW, sz.cH);
    const infoP = panel(main, 'Readout'); const info = el('div', 'stats'); infoP.append(info);
    const pickP = panel(main, 'Pick a candidate'); const renderTable = candidateTable(pickP, app, c => app.select(c));

    const slDt = slider(ctl, { label: 'time nudge (after fine sync)', min: -32, max: 32, step: 1, value: p.dtNudge, fmt: v => `${v} smp = ${(v * 5)} ms`, oninput: v => { p.dtNudge = v; runSoon(); } });
    const slDf = slider(ctl, { label: 'frequency nudge (after fine sync)', min: -8, max: 8, step: 0.25, value: p.freqNudge, fmt: v => v.toFixed(2) + ' Hz', oninput: v => { p.freqNudge = v; runSoon(); } });
    const cbPow = checkbox(ctl, { label: 'show power |x|² instead of magnitude', value: p.power, onchange: v => { p.power = v; drawGridBg(); drawOverlays(); } });
    const cbBits = checkbox(ctl, { label: 'label cells with Gray-decoded 3-bit values', value: p.showBits, onchange: v => { p.showBits = v; drawGridBg(); drawOverlays(); } });
    select(ctl, { label: 'depth (sync gate strictness)', options: [[1, '1: need nsync > 8'], [2, '2: need nsync > 8'], [3, '3: nsync > 6 (amp) / > 7 (pow)']], value: p.depth, onchange: v => { p.depth = +v; run(); } });
    ctl.append(el('div', 'note', 'nsync counts how many of the 21 Costas symbols have their expected tone as the strongest bin. Below the gate the candidate is abandoned before any LDPC work. The nudges are applied after the decoder\'s own refinement, so they show what would happen if fine sync had landed there.'));
    const goto = el('div', 'note'); goto.innerHTML = '<a href="#ldpc" style="color:var(--accent)">→ take these tones to stage 3 (LLRs + LDPC)</a>'; ctl.append(goto);

    // A full depth-3 decode is 15 ms and up, and the nudge sliders fire an input event per pixel.
    // Coalesce to one decode per frame, and skip it when nothing it depends on has changed (a
    // remount, or a slider returning to a value it already produced a trace for).
    const traceKey = () => `${app.name}|${app.selected && app.selected.freq}|${app.selected && app.selected.dt}|${p.dtNudge}|${p.freqNudge}|${p.depth}`;
    const runSoon = coalesce(() => run());
    function run() { const c = app.selected; if (!c) return;
      const k = traceKey();
      if (st.traceKey === k && st.trace) { app.trace = st.trace; drawAll(); return; }
      st.traceKey = k;
      st.trace = decodeCandidate(app.getCtx(), c, { dtNudge: p.dtNudge, freqNudge: p.freqNudge, depth: p.depth }); app.trace = st.trace; st.snrBase = null; drawAll();
      const tr = st.trace; if (tr.result) app.getBaseline().then(b => { if (st.trace !== tr) return; const xb = b.mod.xbaseFromSbaseDb(b.sbaseDb, tr.freq); const { xsig, xnoi } = b.mod.signalAndNoisePower(tr.bins, tr.result.tones); const v = b.mod.computeXsnrDb(tr.syncQuality.nsync, xsig, xnoi, xb); st.snrBase = v ? Math.round(Math.max(-25, v.snr)) : null; drawInfo(); }); }
    const L = 48, T = 6;
    function curSym() { return Math.min(78, Math.floor(app.clock.t / 0.16)); }

    function drawGridBg() {
      const g = cvG.g, tr = st.trace; clear(cvG); if (!tr) return; const W = cvG.w - L - 8, H = cvG.h - T - 26; const cw = W / 79, ch = H / 8;
      // A 3-character 8 px monospace label measures 14 px. The desktop grid gives a column 12 px,
      // which is the density this page shipped with; below that only every 4th column can carry
      // one, and below ~3.5 px even that would touch, so the row goes away.
      bitStep = cw >= 11 ? 1 : cw * 4 >= 14 ? 4 : 0;
      const data = new Float32Array(79 * 8); let vals = []; for (let s = 0; s < 79; s++) for (let t = 0; t < 8; t++) { const v = p.power ? binPower(tr.bins, s, t) : binMag(tr.bins, s, t); data[(7 - t) * 79 + s] = v; vals.push(v); }
      vals.sort((a, b) => a - b); const vmax = vals[Math.floor(vals.length * 0.985)] || 1;
      heatmap(g, { data, rows: 8, cols: 79, x: L, y: T, w: W, h: H, vmin: 0, vmax, cmap: 'viridis', nearest: true });
      for (let s = 0; s < 79; s++) {
        const x = L + s * cw; const ct = costasTone(s);
        if (ct >= 0) { g.strokeStyle = '#ff8c42'; g.lineWidth = 1.2; g.strokeRect(x + 0.5, T + (7 - ct) * ch + 0.5, cw - 1, ch - 1); }
        const ht = tr.hardTones[s]; g.fillStyle = '#fff'; g.beginPath(); g.arc(x + cw / 2, T + (7 - ht) * ch + ch / 2, 1.8, 0, 7); g.fill();
        if (tr.result && tr.result.tones[s] !== ht) { g.strokeStyle = '#3ddc97'; g.lineWidth = 1.5; g.strokeRect(x + 1.5, T + (7 - tr.result.tones[s]) * ch + 1.5, cw - 3, ch - 3); }
        if (p.showBits && bitStep && s % bitStep === 0 && !isSyncSymbol(s)) text(g, GRAY_MAP_INV[ht].toString(2).padStart(3, '0'), x + cw / 2, T + H + 2, { color: '#8b93a3', align: 'center', font: '8px monospace' });
      }
      for (const s0 of [0, 36, 72]) { g.fillStyle = 'rgba(255,140,66,0.15)'; g.fillRect(L + s0 * cw, T, 7 * cw, H); }
      axisY(g, { x: L, y: T, h: H, min: -0.5, max: 7.5, ticks: [0, 1, 2, 3, 4, 5, 6, 7], fmt: v => 'tone ' + v });
      // "sym 36" and "sym 43" are 37 px each and land 24 px apart once the axis is under ~700 px,
      // so a narrow grid keeps only the three Costas starts and says "sym" once.
      const wideX = W >= 700;
      if (!p.showBits) axisX(g, { x: L, y: T + H, w: W, min: -0.5, max: 78.5, ticks: wideX ? [0, 7, 36, 43, 72, 78] : [0, 36, 72], fmt: wideX ? (v => 'sym ' + v) : (v => v ? String(v) : 'sym 0') });
    }
    function drawBasebandBg() {
      const g = cvB.g, tr = st.trace; clear(cvB); if (!tr) return; const W = cvB.w - L - 8, H = cvB.h - T - 22; const cd = tr.cd1;
      const xs = [], ys = []; let m = 0; for (let i = 0; i < NP2; i++) { const v = Math.hypot(cd.re[i], cd.im[i]); xs.push(i); ys.push(v); if (v > m) m = v; }
      linePlot(g, { xs, ys, x: L, y: T, w: W, h: H, xmin: 0, xmax: NP2, ymin: 0, ymax: m * 1.05, color: '#4ea1ff', width: 0.8 });
      const sx = i => L + i / NP2 * W;
      // All 80 boundaries in a 288 px plot is a grey wash: under 500 px keep only the six that
      // bound the three Costas arrays, which the colour ternary already picks out.
      const allBounds = cvB.w >= 500;
      for (let s = 0; s <= 79; s++) { const key = s % 36 === 0 || s === 79 || s === 43 || s === 7; if (!key && !allBounds) continue; const i = tr.ibest2 + s * 32; vline(g, sx(i), T, H, key ? '#ff8c42' : 'rgba(255,255,255,0.12)'); }
      for (const s0 of [0, 36, 72]) { g.fillStyle = 'rgba(255,140,66,0.18)'; g.fillRect(sx(tr.ibest2 + s0 * 32), T, sx(tr.ibest2 + (s0 + 7) * 32) - sx(tr.ibest2 + s0 * 32), H); }
      axisX(g, { x: L, y: T + H, w: W, min: 0, max: NP2 / 200, ticks: ticks(0, NP2 / 200, 7), fmt: v => v + ' s' });
    }
    /** The symbol cursor on both plots: everything the clock touches. */
    function drawOverlays() {
      const tr = st.trace; const g = cvGo.g; clear(cvGo); const gb = cvBo.g; clear(cvBo); if (!tr) return;
      const sym = curSym();
      const W = cvG.w - L - 8, H = cvG.h - T - 26, cw = W / 79;
      g.strokeStyle = '#ff5c5c'; g.lineWidth = 1.5; g.strokeRect(L + sym * cw, T, cw, H);
      // The one label the transport updates on this page, so it is the one that has to survive.
      // The full string measures 384 px; on a narrow grid it is both too long and right-aligned off
      // the visible part of a panel the reader has to scroll, so it shortens and moves to the left
      // edge, where the grid starts.
      const wideLbl = cvG.w >= 600;
      const what = isSyncSymbol(sym) ? (wideLbl ? 'Costas sync, expected tone ' : 'Costas, exp ') + costasTone(sym) : 'data';
      text(g, wideLbl
        ? `symbol ${sym}: ${what}, strongest tone ${tr.hardTones[sym]}` + (tr.result ? `, decoded tone ${tr.result.tones[sym]}` : '')
        : `sym ${sym}: ${what}, max ${tr.hardTones[sym]}` + (tr.result ? `, dec ${tr.result.tones[sym]}` : ''),
        wideLbl ? L + W : L + 2, T + 2, { align: wideLbl ? 'right' : 'left', bg: 'rgba(0,0,0,0.6)', max: W - 4 });
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
    function drawAll() { const tr = st.trace; if (!tr) return; drawGridBg(); drawBasebandBg(); drawOverlays(); drawCurve(cv1, tr.fineSync.timeCurve, 'idt', tr.fineSync.ibest, v => ((v - Math.round((tr.cand.dt + 0.5) * 200)) * 5) + 'ms'); drawCurve(cv2, tr.fineSync.freqCurve, 'delf', tr.fineSync.delf, v => v + 'Hz'); drawCurve(cv3, tr.timeRefine.curve, 'idt', tr.timeRefine.ibest2 - tr.fineSync.ibest, v => (v * 5) + 'ms'); drawInfo(); }
    // The clock ticks every frame, but the cursor only moves every 160 ms: the other nine ticks
    // would redraw the same two shapes and remeasure the same label.
    let lastSym = -1;
    st.unsubs.push(app.clock.subscribe(() => { const s = curSym(); if (s === lastSym) return; lastSym = s; drawOverlays(); }));
    st.unsubs.push(app.on(k => { if (k === 'select') { run(); renderTable(); } if (k === 'sync') renderTable(); }));
    run();
    // Rotation, or a desktop zoom: rebuild at the new column width. Without this app.js remounts,
    // which is slower and loses the selected candidate's scroll position in the table.
    this.resize = () => {
      const n = sizes();
      resizePlot(gridL, n.gW, n.gH); resizePlot(bbL, n.bW, n.bH);
      for (const cv of [cv1, cv2, cv3]) resizePlot(cv, n.cW, n.cH);
      lastSym = -1; renderTable(); drawAll();
    };
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.resize = null; st.trace = null; st.traceKey = null; },
  resize: null,
};
