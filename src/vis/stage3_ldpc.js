// Stage 3: LLRs, belief propagation (four views), OSD and AP tabs.
import { decodeCandidate } from '../dsp/pipeline.js';
import { bpDecodeTrace, graph, N, K, M } from '../dsp/ldpc.js';
import { bpWithZsum, osdDecode, osdParamsFromDepth } from '../dsp/osd.js';
import { applyApCq, applyApMyCall, callsignToApBits, AP_CONSTRAINED_BITS } from '../dsp/ap.js';
import { LLR_PASS_INFO } from '../dsp/llr.js';
import { unpack77 } from '../dsp/unpack77.js';
import { slider, select, checkbox, el, panel, canvas, caption, coalesce, button, tryThis, textInput, fitW, resizePlot, onPlot, isNarrow, coarse, vw } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, text, hline, vline, clear, linePlot, passColor, AXIS_FONT } from '../ui/draw.js';
import { candidateTable } from './stage2_candidate.js';

const st = { p: { metric: 'amp', pass: 'a', maxIter: 30, earlyStop: true, noise: 0, scale: 1, edges: true, seed: 1, checkIdx: 0, osdOrder: 2, osdSource: 'zsum1', mycall: 'KC1WIH' }, view: 'tanner', trace: null, llr: null, bp: null, truthCw: null, unsubs: [] };
const VIEWS = [['tanner', 'Tanner graph'], ['circle', 'circular'], ['heat', 'reliability heatmap'], ['check', 'one check node'], ['osd', 'OSD fallback'], ['ap', 'a-priori (AP)']];
// The first four are four renderings of the same belief-propagation run and follow the clock.
// The last two are different algorithms, tried when BP gives up, and do not depend on the iteration.
const BP_VIEWS = ['tanner', 'circle', 'heat', 'check'];
// Six buttons in two labelled groups do not fit a phone line even wrapped, and these two labels
// are the only ones long enough to force a third row.
const SHORT = { heat: 'heatmap', check: 'check node' };
const CAPTIONS = {
  tanner: ['one belief-propagation iteration per half second.', 'red check squares turning green, and red rings on bits whose hard decision is still wrong.'],
  circle: ['one belief-propagation iteration per half second.', 'the same graph without the left-to-right bias: edge colors show which checks are still arguing.'],
  heat: ['one iteration per half second; the white box marks the row you are on.', 'the whole run at once. A clean decode goes blue-and-orange within a few rows; a failing one stays mottled.'],
  check: ['one iteration per half second.', 'the arithmetic itself: five numbers per bit, and how one confident wrong bit poisons every message this check sends.'],
  osd: ['still steps the BP iteration in the panels below, but this view does not depend on it: OSD is one shot.', 'where the 91 most reliable bits fall, and which of the least reliable ones the winning pattern had to flip.'],
  ap: ['still steps the BP iteration in the panels below. This view is a second, separate BP run with 32 bits forced.', 'the 32 yellow bars in the lower plot, and whether forcing them turns a failure into a decode.'],
};
function gauss(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FIELDS = [[0, 28, 'f0', 'call 1 (28 bits)'], [28, 29, 'f1', '/R or /P flag'], [29, 57, 'f0', 'call 2 (28 bits)'], [57, 58, 'f1', '/R or /P flag'], [58, 59, 'f1', 'R flag'], [59, 74, 'f2', 'grid or report (15 bits)'], [74, 77, 'f3', 'i3 (message type, 3 bits)'], [77, 91, 'f4', 'CRC-14'], [91, 174, 'f5', 'LDPC parity (83 bits)']];
function fieldOf(i) { for (const f of FIELDS) if (i >= f[0] && i < f[1]) return f; return FIELDS[FIELDS.length - 1]; }
const FIELD_COLORS = { f0: '#4ea1ff', f1: '#ff8c42', f2: '#3ddc97', f3: '#ffd166', f4: '#c792ea', f5: '#8b93a3' };
const bitColor = (v, m) => { const a = Math.min(1, Math.abs(v) / m); return v < 0 ? `rgba(255,140,66,${0.25 + 0.75 * a})` : `rgba(78,161,255,${0.25 + 0.75 * a})`; };

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); root.textContent = ''; this.mount(root, app); } }); st.unsubs.push(off); return; }  // cancelled by unmount if you navigate away first
    const p = st.p;
    const want = app.tabFor('ldpc', VIEWS.map(v => v[0])); if (want) st.view = want;
    app.canonicalTab(st.view);
    if (!app.selected) app.select(app.candidates[0]);
    root.append(el('h1', null, '3 · From tone magnitudes to bits: LLRs and LDPC belief propagation'));
    root.append(el('p', 'blurb', 'The 58 data symbols carry 174 bits: 3 per symbol, Gray-coded so that adjacent tones differ in one bit. For each bit the decoder does not decide 0 or 1; it computes a log-likelihood ratio: (largest tone magnitude among tones where that bit is 1) minus (largest where it is 0), normalized to unit variance and scaled by 2.83. Positive means "probably 0". Those 174 LLRs feed a (174,91) LDPC code: 91 message bits (77 payload + 14 CRC) plus 83 parity bits, where each parity check says "these 6 or 7 bits XOR to zero". Belief propagation repeatedly lets each check tell each of its bits what the other bits imply, and each bit sum up what it hears. The candidate is decoded when all 83 checks are satisfied and the CRC-14 matches. Press play to step through iterations; add noise to the LLRs to see how much margin there is, then look at the OSD and AP tabs for what the decoder tries when BP gives up.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const llrP = panel(main, 'Input LLRs (174). Color = field. Red shading = hard decision disagrees with the true codeword'); const cvL = canvas(llrP, fitW(llrP, 1000), 150);
    const tabs = el('div', 'tabs'); main.append(tabs);
    const tabBtns = new Map();
    const gA = el('div', 'group'); gA.append(el('span', 'grouplab', 'belief propagation:'));
    const gB = el('div', 'group'); gB.append(el('span', 'grouplab', 'when BP fails:'));
    for (const [v, label] of VIEWS) { const b = el('button', v === st.view ? 'active' : '', label); b.dataset.tab = v; b.onclick = () => app.setTab(v); (BP_VIEWS.includes(v) ? gA : gB).append(b); tabBtns.set(v, b); }
    const tabDiv = el('div', 'div'); tabs.append(gA, tabDiv, gB);
    // Below ~600 px the two groups already wrap onto their own lines, so the 1 px rule between
    // them is just a stray mark, and the two longest labels lose their qualifier.
    function fitTabs() { const n = vw() < 600; for (const [v, label] of VIEWS) tabBtns.get(v).textContent = n && SHORT[v] ? SHORT[v] : label; tabDiv.style.display = n ? 'none' : ''; }
    const cap = caption(main);
    // The LLRs are normalized to unit variance before this noise is added, so sigma is in units of
    // "one standard deviation of the channel itself". Numbers below were read off the Result panel
    // for the strongest candidate in the bundled window unless the label says otherwise.
    const setNoise = (v) => { p.noise = v; slNoise.value = v; runBPSoon(); };
    const pick = (test) => { const c = app.candidates.find(test); if (c) app.select(c); };
    tryThis(main, [
      { label: 'noise σ 2', see: 'Still decodes, but BP now needs <b>2</b> iterations where the clean LLRs needed <b>0</b>: the hard decisions alone were already a valid codeword. The parity checks are doing real work now.',
        run: () => { pick(c => c === app.candidates[0]); setNoise(2); } },
      { label: 'noise σ 3', see: 'Still decodes, in <b>6</b> iterations. Watch the heatmap: the first rows are mottled and the run cleans up from the reliable bits outward. This is belief propagation actually propagating.',
        run: () => { pick(c => c === app.candidates[0]); setNoise(3); } },
      { label: 'noise σ 3.5', see: 'It breaks, and it breaks sharply: no convergence in <b>30</b> iterations. There is no graceful degradation here, so a decoder gets a clean message or nothing, which is why FT8 output is never garbled text.',
        run: () => { pick(c => c === app.candidates[0]); setNoise(3.5); } },
      { label: 'a −17 dB signal', see: 'Every LLR set fails on this one (<b>amp/a</b> through <b>amp/e</b>, then both AP hypotheses), and the power metric never runs at all because the sync gate sees nsync = 7. The Result panel explains the ending: this message only decodes on a <a href="#passes">later pass</a>, once the loud signals have been subtracted out from under it.',
        run: () => { setNoise(0); pick(c => { const d = app.truthFor(c); return d && d.snr <= -15; }); } },
      { label: 'clean, strongest signal', see: 'Back to the −1 dB candidate with no added noise: BP is done before it starts, in <b>0</b> iterations, parity and CRC both satisfied.',
        run: () => { setNoise(0); pick(c => c === app.candidates[0]); } },
    ], () => app.name === '260726_190930' ? '' : ' <i>Numbers here were measured on the bundled window, not the one you have loaded.</i>');
    const viewP = panel(main, ' ');
    /**
     * The six drawings have very different width needs, so the shared canvas is sized per view.
     * The Tanner graph puts 174 bit nodes and 83 check squares in a row and the check view stacks
     * five 10 px readouts under each of 6-7 bit columns: below these floors they merge into a bar
     * and a smear, so they keep an intrinsic width and the panel scrolls sideways instead. The
     * other four scale down cleanly.
     */
    function viewSize() {
      const w = fitW(viewP, 1000);
      if (st.view === 'tanner') return [Math.max(700, w), 330];
      if (st.view === 'check') return [Math.max(810, w), 330];
      if (st.view === 'circle') return [w, Math.min(330, w)];   // R is h/2 - 14, so h must not exceed w
      if (st.view === 'osd') return [w, 306];                   // 24 px shorter: its legend is DOM now
      return [w, 330];
    }
    const cvV = canvas(viewP, ...viewSize());
    // The tanner and check views keep an intrinsic width inside a panel that pans sideways, so this
    // canvas must let a horizontal drag through; onPlot only picks on a tap that did not move.
    cvV.style.touchAction = 'pan-x pan-y';
    const vnote = el('div', 'note'); viewP.append(vnote);       // canvas prose that did not fit, wrapped
    const vlegend = el('div', 'legend'); viewP.append(vlegend);
    const vinfo = el('div', 'stats'); viewP.append(vinfo);
    // The per-view controls sit under the panel, not inside it: the Tanner and check views keep an
    // intrinsic width wider than a phone, and inside the panel's horizontal scroller you would have
    // to drag the plot sideways to reach the "my callsign" field.
    const vctl = el('div', 'row'); vctl.style.margin = '6px 0 8px'; main.append(vctl);
    const r2 = el('div', 'row'); main.append(r2);
    const convP = panel(r2, 'Convergence');
    // convP is a shrink-to-fit flex item, so measuring it just gives back whatever the canvas
    // inside it is: measure the column and take off the panel's own 12 px padding and 1 px border.
    const convW = () => Math.max(240, Math.min(330, fitW(main, 1000, 0) - 26));
    const cvC = canvas(convP, convW(), 170);
    const resP = panel(r2, 'Result'); resP.style.flex = '1'; const res = el('div', 'stats'); resP.append(res);
    const bitsP = panel(main, 'The 174 bits after this iteration (hard decisions)'); const bits = el('div', 'bits'); bitsP.append(bits); const legend = el('div', 'legend'); legend.innerHTML = FIELDS.map(f => `<span><i style="background:${FIELD_COLORS[f[2]]}"></i>${f[3]}</span>`).join(''); bitsP.append(legend);
    const pickP = panel(main, 'Pick a candidate'); const renderTable = candidateTable(pickP, app, c => app.select(c));

    select(ctl, { label: 'metric', options: [['amp', 'amplitude |bin|'], ['pow', 'power |bin|²']], value: p.metric, onchange: v => { p.metric = v; runBP(); } });
    select(ctl, { label: 'LLR set (symbol grouping)', options: [['a', 'a: single symbol'], ['b', 'b: 2-symbol blocks'], ['c', 'c: 3-symbol blocks'], ['d', 'd: single, normalized'], ['e', 'e: best of a/b/c']], value: p.pass, onchange: v => { p.pass = v; runBP(); } });
    const passNote = el('div', 'note'); ctl.append(passNote);
    slider(ctl, { label: 'max BP iterations', min: 1, max: 100, step: 1, value: p.maxIter, oninput: v => { p.maxIter = v; runBPSoon(); } });
    checkbox(ctl, { label: 'early stop (no progress for 5 iters after 10)', value: p.earlyStop, onchange: v => { p.earlyStop = v; runBP(); } });
    slider(ctl, { label: 'LLR scale', min: 0.1, max: 4, step: 0.1, value: p.scale, fmt: v => v.toFixed(1) + '×', oninput: v => { p.scale = v; runBPSoon(); } });
    const slNoise = slider(ctl, { label: 'added Gaussian noise σ', min: 0, max: 6, step: 0.1, value: p.noise, fmt: v => v.toFixed(1), oninput: v => { p.noise = v; runBPSoon(); } });
    slider(ctl, { label: 'noise seed', min: 1, max: 50, step: 1, value: p.seed, oninput: v => { p.seed = v; runBPSoon(); } });
    checkbox(ctl, { label: 'draw all 522 edges', value: p.edges, onchange: v => { p.edges = v; drawView(); } });
    ctl.append(el('div', 'note', 'The decoder tries LLR sets a, b, c, d, e with the amplitude metric, then the same five with the power metric, stopping at the first success; at depth ≥ 2 each failed BP attempt falls through to OSD, and at depth 3 the CQ / MyCall a-priori passes come last. Typical LLR magnitudes are 1–5; noise σ of 2–3 is roughly a 6–9 dB weaker signal.'));

    // per-view controls
    const checkCtl = el('div', 'controls'); checkCtl.style.flexDirection = 'row'; checkCtl.style.maxWidth = 'none'; checkCtl.style.alignItems = 'flex-end'; checkCtl.style.flexWrap = 'wrap';
    const checkSl = slider(checkCtl, { label: 'check node', min: 0, max: 82, step: 1, value: p.checkIdx, oninput: v => { p.checkIdx = v; drawView(); } });
    button(checkCtl, 'jump to first unsatisfied', () => { if (!st.bp) return; const it = st.bp.iterations[curIter()]; if (it.unsat.length) { p.checkIdx = it.unsat[0]; checkSl.value = p.checkIdx; drawView(); } });
    const osdCtl = el('div', 'controls'); osdCtl.style.flexDirection = 'row'; osdCtl.style.maxWidth = 'none'; osdCtl.style.alignItems = 'flex-end'; osdCtl.style.flexWrap = 'wrap';
    const osdSl = slider(osdCtl, { label: 'OSD order', min: 0, max: 2, step: 1, value: p.osdOrder, oninput: v => { p.osdOrder = v; drawView(); } });
    const osdSrc = select(osdCtl, { label: 'reliabilities from', options: [['llr', 'channel LLRs'], ['zsum1', 'BP soft sum after iteration 1'], ['zsum2', 'BP soft sum after iteration 2']], value: p.osdSource, onchange: v => { p.osdSource = v; drawView(); } });
    const apCtl = el('div', 'controls'); apCtl.style.flexDirection = 'row'; apCtl.style.maxWidth = 'none'; apCtl.style.alignItems = 'flex-end'; apCtl.style.flexWrap = 'wrap';
    const apKind = select(apCtl, { label: 'a-priori hypothesis', options: [['cq', 'CQ: call 1 = CQ, i3 = 1'], ['mycall', 'MyCall: call 1 = my callsign, i3 = 1']], value: 'cq', onchange: () => drawView() });
    const myIn = textInput(apCtl, { label: 'my callsign', value: p.mycall, oninput: v => { p.mycall = v.toUpperCase(); drawView(); } });
    /**
     * These three rows are the only controls on the page that are laid out horizontally. On a
     * desktop the min widths keep each slider long enough to be worth dragging; on a phone they
     * are exactly what pushes the row off the screen (apCtl measured 434 px against 332), so the
     * row wraps instead and each control may grow to the full line.
     */
    function fitVctl() {
      const n = isNarrow();
      checkSl.style.minWidth = n ? '0' : '220px'; checkSl.style.flex = n ? '1 1 200px' : '';
      osdSl.style.minWidth = n ? '0' : '160px'; osdSl.style.flex = n ? '1 1 160px' : '';
      for (const c of [osdSrc, apKind, myIn]) { c.style.minWidth = n ? '0' : ''; c.style.flex = n ? '1 1 180px' : ''; }
      for (const e of [osdSrc.select, apKind.select]) e.style.maxWidth = n ? '100%' : '';
    }
    function layoutView() {
      fitTabs(); fitVctl();
      for (const [k, b] of tabBtns) b.classList.toggle('active', k === st.view);
      resizePlot(cvV, ...viewSize());
      const c = CAPTIONS[st.view] || [];
      // The 8 px check squares are a poor tap target however wide the band around them is, and the
      // slider that picks one is a tab away, so say so where the taps are hardest.
      cap.set(c[0], (c[1] || '') + (st.view === 'tanner' && (isNarrow() || coarse()) ? ' To pick a check node, tap one of the squares in the bottom row, or use the "check node" slider in the next view.' : ''));
      vnote.textContent = ''; vlegend.innerHTML = '';
      vctl.innerHTML = ''; if (st.view === 'check') vctl.append(checkCtl); if (st.view === 'osd') vctl.append(osdCtl); if (st.view === 'ap') vctl.append(apCtl);
      // Four of the six views have no controls: keep the 6 px this row used to occupy inside the
      // panel so nothing below the plot moves when you switch views, but not the 8 px under it.
      vctl.style.margin = vctl.children.length ? '6px 0 8px' : '6px 0 0';
      viewP.querySelector('h3').textContent = { tanner: 'Tanner graph: 174 bit nodes (top, current belief) ↔ 83 parity checks (bottom, red = unsatisfied)', circle: 'Circular layout: bits on the outer ring, checks on the inner ring, edges colored by the check→bit message', heat: 'Belief per bit (columns) per iteration (rows): blue = leaning 0, orange = leaning 1. Below: the 83 checks per iteration', check: 'One parity check and its bits: what it hears, what it tells them', osd: 'Ordered statistics decoding: sort bits by reliability, re-encode from the 91 most reliable, flip a few of the least reliable of those', ap: 'A-priori decoding: overwrite 32 LLRs with a guess about the message, then run BP again' }[st.view];
    }

    function run() { const c = app.selected; if (!c) return; st.trace = decodeCandidate(app.getCtx(), c, { depth: 3, mycallBits: callsignToApBits(p.mycall) }); app.trace = st.trace; st.truthCw = st.trace.result ? st.trace.result.codeword : null; const d = app.truthFor(c); st.truthText = d ? d.message : null; runBP(); }
    // The LLR sliders fire per pixel and each run is a traced BP decode plus six redraws.
    const runBPSoon = coalesce(() => runBP());
    function runBP() {
      const tr = st.trace; if (!tr) return; passNote.textContent = LLR_PASS_INFO[p.pass];
      const base = tr.llr[p.metric][p.pass]; const rng = mulberry(p.seed * 7919);
      st.llr = Float64Array.from(base, v => -v * p.scale + (p.noise ? gauss(rng) * p.noise : 0));
      st.bp = bpDecodeTrace(st.llr, { maxIter: p.maxIter, earlyStop: p.earlyStop });
      st._osd = null; st._ap = null; st._heat = null;
      const n = st.bp.iterations.length; app.clock.setDuration(Math.max(1, n) * 0.5); app.clock.seek(app.clock.duration - 0.001);
      app.clockFormat = () => `iteration ${curIter()} of ${st.bp.iterations.length - 1}`;
      drawAll();
    }
    const curIter = () => Math.min(st.bp.iterations.length - 1, Math.floor(app.clock.t / 0.5));
    const L = 34, T = 6;
    /**
     * A canvas cannot wrap text, so a sentence that is wider than the plot paints over it (the
     * check view's header measures 871 px). Draw it where it fits and hand it to the note under
     * the panel where it does not, which wraps for free and keeps every word.
     */
    let noteBuf = [];
    function prose(g, s, x, y, o = {}) {
      g.save(); g.font = o.font || AXIS_FONT; const w = g.measureText(s).width; g.restore();
      if (w <= (o.max || 0)) text(g, s, x, y, o); else noteBuf.push(s);
    }
    function bars(cv, vals, opts = {}) {
      const g = cv.g; clear(cv); const W = cv.w - L - 8, H = cv.h - T - 26; const bw = W / N; let m = 0; for (const v of vals) m = Math.max(m, Math.abs(v)); m = m || 1;
      const y0 = T + H / 2;
      for (let i = 0; i < N; i++) { const f = fieldOf(i); g.fillStyle = opts.mark && opts.mark.has(i) ? '#ffd166' : FIELD_COLORS[f[2]]; const h = vals[i] / m * H / 2; g.fillRect(L + i * bw, Math.min(y0, y0 - h), Math.max(bw - 0.6, 0.5), Math.abs(h)); if (st.truthCw && !opts.noTruth && ((vals[i] < 0 ? 1 : 0) !== st.truthCw[i])) { g.fillStyle = 'rgba(255,92,92,0.35)'; g.fillRect(L + i * bw, T, bw, H); } }
      hline(g, L, W, y0, '#2a3242');
      for (const b of [77, 91]) vline(g, L + b * bw, T, H, '#5a6478', [2, 3]);
      axisX(g, { x: L, y: T + H, w: W, min: 0, max: N, ticks: [0, 28, 57, 77, 91, 174], fmt: v => v });
      // Two short lines rather than "+4.2 (bit 0)": the gutter is 30 px, and the one-line version
      // was clipped at every width, desktop included.
      const gl = { align: 'right', color: '#8b93a3', font: '9px system-ui', max: L - 6 };
      text(g, `+${m.toFixed(1)}`, L - 4, T, gl); text(g, 'bit 0', L - 4, T + 10, gl);
      text(g, 'bit 1', L - 4, T + H - 20, gl); text(g, `−${m.toFixed(1)}`, L - 4, T + H - 10, gl);
      if (opts.title) text(g, opts.title, L + W, T, { align: 'right', bg: 'rgba(0,0,0,0.6)', max: W });
    }
    const edgeColor = (v, unsatC) => { const a = Math.min(1, Math.abs(v) / 4); return unsatC ? `rgba(255,92,92,${0.25 + 0.6 * a})` : v === 0 ? 'rgba(120,130,150,0.12)' : (v < 0 ? `rgba(255,140,66,${0.08 + 0.5 * a})` : `rgba(78,161,255,${0.08 + 0.5 * a})`); };
    const wrongCount = it => st.truthCw ? it.hard.reduce((s, b, i) => s + (b !== st.truthCw[i]), 0) : null;

    function drawTanner(g, it) {
      const W = cvV.w - 16, x0 = 8; const yb = 40, yc = cvV.h - 46;
      const bx = i => x0 + (i + 0.5) / N * W, cx = j => x0 + (j + 0.5) / M * W; const unsat = new Set(it.unsat);
      let m = 0; for (const v of it.zn) m = Math.max(m, Math.abs(v)); m = m || 1;
      if (p.edges) { g.lineWidth = 0.5; for (let e = 0; e < graph.nEdges; e++) { const b = graph.edgeBit[e], c = graph.edgeCheck[e]; g.strokeStyle = edgeColor(it.tov[e], unsat.has(c)); g.beginPath(); g.moveTo(bx(b), yb + 6); g.lineTo(cx(c), yc - 6); g.stroke(); } }
      for (let i = 0; i < N; i++) { g.fillStyle = bitColor(it.zn[i], m); g.beginPath(); g.arc(bx(i), yb, 2.6, 0, 7); g.fill(); if (st.truthCw && it.hard[i] !== st.truthCw[i]) { g.strokeStyle = '#ff5c5c'; g.lineWidth = 1; g.beginPath(); g.arc(bx(i), yb, 4.5, 0, 7); g.stroke(); } }
      for (let j = 0; j < M; j++) { g.fillStyle = unsat.has(j) ? '#ff5c5c' : '#3ddc97'; g.fillRect(cx(j) - 4, yc - 4, 8, 8); if (j === p.checkIdx) { g.strokeStyle = '#fff'; g.strokeRect(cx(j) - 6, yc - 6, 12, 12); } }
      prose(g, 'bits: blue = leaning 0, orange = leaning 1; red ring = differs from true codeword', 10, yb + 10, { color: '#8b93a3', max: cvV.w - 20 });
      prose(g, `checks: green = satisfied, red = XOR ≠ 0. Edges: check→bit messages, colored by sign. ${coarse() ? 'Tap' : 'Click'} a check to inspect it in view D`, 10, yc + 10, { color: '#8b93a3', max: cvV.w - 20 });
    }
    function drawCircle(g, it) {
      const cx0 = cvV.w / 2, cy0 = cvV.h / 2 + 4, R = cvV.h / 2 - 14, r = R * 0.55; const unsat = new Set(it.unsat);
      const bp = i => { const a = -Math.PI / 2 + i / N * 2 * Math.PI; return [cx0 + R * Math.cos(a), cy0 + R * Math.sin(a)]; };
      const cp = j => { const a = -Math.PI / 2 + (j + 0.5) / M * 2 * Math.PI; return [cx0 + r * Math.cos(a), cy0 + r * Math.sin(a)]; };
      let m = 0; for (const v of it.zn) m = Math.max(m, Math.abs(v)); m = m || 1;
      if (p.edges) { g.lineWidth = 0.6; for (let e = 0; e < graph.nEdges; e++) { const [x1, y1] = bp(graph.edgeBit[e]), [x2, y2] = cp(graph.edgeCheck[e]); g.strokeStyle = edgeColor(it.tov[e], unsat.has(graph.edgeCheck[e])); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); } }
      for (let i = 0; i < N; i++) { const [x, y] = bp(i); g.fillStyle = bitColor(it.zn[i], m); g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); if (st.truthCw && it.hard[i] !== st.truthCw[i]) { g.strokeStyle = '#ff5c5c'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.stroke(); } }
      for (let j = 0; j < M; j++) { const [x, y] = cp(j); g.fillStyle = unsat.has(j) ? '#ff5c5c' : '#3ddc97'; g.fillRect(x - 3.5, y - 3.5, 7, 7); }
      for (const b of [0, 28, 57, 77, 91]) { const [x, y] = bp(b); text(g, String(b), x + (x > cx0 ? 6 : -6), y - 5, { color: '#8b93a3', align: x > cx0 ? 'left' : 'right' }); }
      text(g, `iteration ${it.iter}`, cx0, cy0 - 8, { align: 'center', font: '13px system-ui' });
    }
    function drawHeat(g) {
      const its = st.bp.iterations; const rows = its.length; const W = cvV.w - L - 8, Hb = Math.round((cvV.h - T - 40) * 0.68), Hc = cvV.h - T - 40 - Hb - 10;
      let m = 0; for (const it of its) for (const v of it.zn) m = Math.max(m, Math.abs(v)); m = m || 1;
      if (!st._heat || st._heat.bp !== st.bp) {
        const data = new Float32Array(rows * N); its.forEach((it, r) => { for (let i = 0; i < N; i++) data[r * N + i] = Math.max(-m, Math.min(m, it.zn[i])); });
        const cdata = new Float32Array(rows * M); its.forEach((it, r) => { const u = new Set(it.unsat); for (let j = 0; j < M; j++) cdata[r * M + j] = u.has(j) ? 1 : 0; });
        st._heat = { bp: st.bp, data, cdata, m };
      }
      const data = st._heat.data;
      heatmap(g, { data, rows, cols: N, x: L, y: T, w: W, h: Hb, vmin: -m, vmax: m, cmap: 'diverging', nearest: true });
      const cdata = st._heat.cdata;
      heatmap(g, { data: cdata, rows, cols: M, x: L, y: T + Hb + 10, w: W, h: Hc, vmin: 0, vmax: 1, cmap: 'hot', nearest: true });
      const rh = Hb / rows, k = curIter(); g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(L, T + k * rh, W, rh); g.strokeRect(L, T + Hb + 10 + k * (Hc / rows), W, Hc / rows);
      if (st.truthCw) { const bw = W / N; g.fillStyle = '#ff5c5c'; its.forEach((it, r) => { for (let i = 0; i < N; i++) if (it.hard[i] !== st.truthCw[i]) g.fillRect(L + i * bw + bw / 2 - 0.5, T + r * rh + rh / 2 - 0.5, 1.2, 1.2); }); }
      for (const b of [28, 57, 77, 91]) vline(g, L + b / N * W, T, Hb, 'rgba(255,255,255,0.35)', [2, 3]);
      axisY(g, { x: L, y: T, h: Hb, min: rows - 0.5, max: -0.5, ticks: ticks(0, rows - 1, 5), fmt: v => 'it ' + v, flip: true });
      axisX(g, { x: L, y: T + Hb + 10 + Hc, w: W, min: 0, max: M, ticks: [0, 20, 40, 60, 83], fmt: v => 'check ' + v });
      text(g, isNarrow() ? 'red dot = wrong bit' : 'red dot = hard decision wrong vs true codeword', L + W, T + 2, { align: 'right', bg: 'rgba(0,0,0,0.6)', max: W });
    }
    function drawCheck(g, it) {
      const j = p.checkIdx, bitsOf = graph.checkBits[j], s = graph.checkStart[j]; const nb = bitsOf.length; const next = st.bp.iterations[it.iter + 1];
      const W = cvV.w - 40, x0 = 20; const yb = 70, yc = cvV.h - 60; const cx = cvV.w / 2;
      const unsat = it.unsat.includes(j); g.fillStyle = unsat ? '#ff5c5c' : '#3ddc97'; g.fillRect(cx - 14, yc - 14, 28, 28); text(g, `check ${j}`, cx, yc + 18, { align: 'center' });
      let parity = 0; for (const b of bitsOf) parity ^= it.hard[b];
      text(g, `XOR of the ${nb} hard decisions = ${parity} → ${unsat ? 'UNSATISFIED' : 'satisfied'} at iteration ${it.iter}`, cx, yc + 32, { align: 'center', color: unsat ? '#ff5c5c' : '#3ddc97' });
      // tanh product for the outgoing messages: tov_e = 2 atanh( prod_{e' != e} tanh(toc_e' / 2) )
      const toc = bitsOf.map((b, k) => it.zn[b] - it.tov[s + k]);
      const tanh = toc.map(v => Math.max(-0.999999, Math.min(0.999999, Math.tanh(v / 2))));
      bitsOf.forEach((b, k) => {
        const x = x0 + (k + 0.5) / nb * W; const f = fieldOf(b);
        g.strokeStyle = edgeColor(it.tov[s + k], unsat); g.lineWidth = 2; g.beginPath(); g.moveTo(x, yb + 22); g.lineTo(cx, yc - 14); g.stroke();
        g.fillStyle = FIELD_COLORS[f[2]]; g.beginPath(); g.arc(x, yb, 9, 0, 7); g.fill(); text(g, String(it.hard[b]), x, yb - 6, { align: 'center', color: '#000', font: 'bold 11px system-ui' });
        if (st.truthCw && it.hard[b] !== st.truthCw[b]) { g.strokeStyle = '#ff5c5c'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, yb, 13, 0, 7); g.stroke(); }
        const colW = W / nb - 4;   // the five readouts are centred on the column and must not reach the next one
        text(g, `bit ${b}`, x, yb - 32, { align: 'center', max: colW }); text(g, f[3].split(' (')[0], x, yb - 20, { align: 'center', color: '#8b93a3', font: '9px system-ui', max: colW });
        let prodOthers = 1; tanh.forEach((t, kk) => { if (kk !== k) prodOthers *= t; }); const out = 2 * Math.atanh(Math.max(-0.999999, Math.min(0.999999, prodOthers)));
        const lines = [`channel LLR ${st.llr[b].toFixed(2)}`, `belief now ${it.zn[b].toFixed(2)}`, `bit→check ${toc[k].toFixed(2)}`, `tanh(/2) ${tanh[k].toFixed(3)}`, `check→bit next ${out.toFixed(2)}`];
        lines.forEach((ln, li) => text(g, ln, x, yb + 30 + li * 13, { align: 'center', color: li === 4 ? '#ffd166' : li === 2 ? '#c792ea' : '#e6e9ef', font: '10px system-ui', max: colW }));
      });
      prose(g, 'Each outgoing message = 2·atanh( product over the OTHER bits of tanh(their bit→check message / 2) ). One confident wrong bit poisons every message this check sends.', cvV.w / 2, 4, { align: 'center', color: '#8b93a3', max: cvV.w - 20 });
      if (!next) noteBuf.push('This is the last iteration of the run, so those outgoing messages are never sent.');
    }
    /** OSD does not depend on the transport clock, so one run is cached per (LLRs, order, source). */
    function osdRun() {
      const key = `${p.osdSource}|${p.osdOrder}|${p.maxIter}`;
      if (st._osd && st._osd.llr === st.llr && st._osd.key === key) return st._osd;
      const src = p.osdSource === 'llr' ? st.llr : (() => { const z = bpWithZsum(st.llr, p.maxIter, 2); return z.saves[p.osdSource === 'zsum1' ? 0 : 1] || z.saves[z.saves.length - 1] || st.llr; })();
      const params = osdParamsFromDepth(p.osdOrder === 0 ? 1 : p.osdOrder === 1 ? 2 : 3, 'default');
      st._osd = { llr: st.llr, key, src, r: osdDecode(src, p.osdOrder, params) };
      return st._osd;
    }
    function drawOsd(g) {
      const { src, r } = osdRun(); const t = r.trace; st.osdResult = r;
      const W = cvV.w - L - 8, H = cvV.h - T - 70; const order = t.perm || t.reliabilityOrder || []; const n = order.length || N; const bw = W / n;
      let m = 0; for (const v of src) m = Math.max(m, Math.abs(v)); m = m || 1;
      const mrb = new Set(t.mrb || []); const pool = new Set(t.flipPool || []); const swapped = new Set((t.swappedIn || []).map(x => x.bit)); const win = new Set((t.winner && t.winner.flipsCodeword) || []);
      order.forEach((b, k) => { const x = L + k * bw; const h = Math.abs(src[b]) / m * H; g.fillStyle = win.has(b) ? '#ff5c5c' : swapped.has(b) ? '#c792ea' : pool.has(b) ? '#ffd166' : mrb.has(b) ? '#4ea1ff' : '#5a6478'; g.fillRect(x, T + H - h, Math.max(bw - 0.5, 0.5), h); if (st.truthCw && ((src[b] < 0 ? 1 : 0) !== st.truthCw[b])) { g.fillStyle = 'rgba(255,92,92,0.35)'; g.fillRect(x, T, bw, H); } });
      vline(g, L + 91 * bw, T, H, '#fff', [3, 3]);
      // The full sentence needs 489 px; the short one still names both halves of the split.
      const split = isNarrow() ? '← 91 most reliable | 83 re-derived →' : '← 91 most reliable (information set) | 83 least reliable (re-derived from the parity equations) →';
      text(g, split, L + 91 * bw, T + H + 4, { align: 'center', color: '#8b93a3', max: W });
      axisX(g, { x: L, y: T + H + 16, w: W, min: 0, max: n, ticks: [0, 55, 91, 174], fmt: v => v });
      text(g, 'bits sorted by |reliability| (descending)', L + W, T, { align: 'right', bg: 'rgba(0,0,0,0.6)', max: W });
      // Five swatches at a fixed 190 px pitch wanted 950 px of canvas. As DOM they wrap.
      const lg = [['#4ea1ff', 'information set'], ['#ffd166', `flip pool (${pool.size} least reliable of the set)`], ['#c792ea', 'swapped in (dependent column)'], ['#ff5c5c', 'flipped by the winning pattern'], ['#5a6478', 'derived bits']];
      vlegend.innerHTML = lg.map(([c, s]) => `<span><i style="background:${c}"></i>${s}</span>`).join('');
      const un = r.ok ? unpack77(r.bits77) : null;
      vinfo.innerHTML = `${p.osdSource === 'llr' ? 'Channel LLRs' : 'BP soft sums'} sorted by |reliability|. Gaussian elimination on the ${t.mrb ? t.mrb.length : 91} most reliable columns${t.swappedIn && t.swappedIn.length ? ` (${t.swappedIn.length} dependent columns swapped for the next most reliable)` : ''}. Order 0 = re-encode from the hard decisions of the information set: <b>${t.order0 ? t.order0.dist.toFixed(2) : '?'}</b> weighted distance to the received LLRs, ${t.order0 ? t.order0.hardErrorsVsReceived : '?'} hard disagreements. Patterns tried: <b>${t.patternsTried ?? 0}</b>${t.patternsPruned ? ` (${t.patternsPruned} pre-screened by the fast order-1 pass)` : ''}. `
        + (r.ok ? `<b>OSD decoded: ${un ? un.text : '?'}</b> with ${t.winner && t.winner.flipsCodeword ? t.winner.flipsCodeword.length + ' flips at codeword bits ' + t.winner.flipsCodeword.join(', ') : 'no flips'} — CRC ok.` : `<b>OSD failed</b>${t.reason ? ': ' + t.reason : ''}.`)
        + (t.best && t.best.length ? `<br>best patterns by distance: ${t.best.slice(0, 5).map(b => `${b.dist.toFixed(1)} [${(b.flipsCodeword || []).join(',') || 'none'}]`).join(' · ')}` : '');
    }
    function drawAp(g) {
      const mc = callsignToApBits(p.mycall); const useMy = apKind.value === 'mycall';
      if (useMy && !mc) { vinfo.innerHTML = `<b>${p.mycall}</b> is not a standard callsign that fits 28 bits.`; return; }
      const key = `${useMy ? p.mycall : 'cq'}|${p.maxIter}|${p.earlyStop}`;
      if (!st._ap || st._ap.llr !== st.llr || st._ap.key !== key) st._ap = { llr: st.llr, key, l2: useMy ? applyApMyCall(st.llr, mc) : applyApCq(st.llr) };
      if (!st._ap.bp2) st._ap.bp2 = bpDecodeTrace(st._ap.l2, { maxIter: p.maxIter, earlyStop: p.earlyStop });
      const l2 = st._ap.l2, bp2 = st._ap.bp2;
      const W = cvV.w - L - 8, H = (cvV.h - T - 40) / 2 - 8; const bw = W / N; let m = 0; for (const v of l2) m = Math.max(m, Math.abs(v)); for (const v of st.llr) m = Math.max(m, Math.abs(v)); m = m || 1;
      const forced = new Set(AP_CONSTRAINED_BITS);
      const drawRow = (vals, y, title) => { const y0 = y + H / 2; for (let i = 0; i < N; i++) { const h = vals[i] / m * H / 2; g.fillStyle = forced.has(i) ? '#ffd166' : FIELD_COLORS[fieldOf(i)[2]]; g.fillRect(L + i * bw, Math.min(y0, y0 - h), Math.max(bw - 0.6, 0.5), Math.abs(h)); if (st.truthCw && ((vals[i] < 0 ? 1 : 0) !== st.truthCw[i])) { g.fillStyle = 'rgba(255,92,92,0.35)'; g.fillRect(L + i * bw, y, bw, H); } } hline(g, L, W, y0, '#2a3242'); text(g, title, L + W, y, { align: 'right', bg: 'rgba(0,0,0,0.6)', max: W }); };
      // 411 px of title over a 302 px plot on a phone; the long form is repeated in the readout
      // under the panel either way.
      const after = isNarrow() ? `after: 32 bits forced to ${useMy ? p.mycall : 'CQ'}` : `after: bits 0–28 and 74–76 forced to the ${useMy ? p.mycall : 'CQ'} hypothesis at 1.1 × the largest |LLR|`;
      drawRow(st.llr, T, 'before: channel LLRs'); drawRow(l2, T + H + 16, after);
      axisX(g, { x: L, y: T + 2 * H + 16, w: W, min: 0, max: N, ticks: [0, 28, 57, 77, 91, 174], fmt: v => v });
      const un = bp2.ok ? unpack77(bp2.bits77) : null; const last = bp2.iterations[bp2.iterations.length - 1];
      vinfo.innerHTML = `Hypothesis: call 1 = <b>${useMy ? p.mycall : 'CQ'}</b> (29 bits incl. the /R flag) and i3 = 1 (3 bits): 32 of 174 bits are no longer in doubt, so BP effectively works a (142, 59) code. Result on this LLR set${p.noise ? ' + noise' : ''}: <b>${bp2.ok ? 'DECODED ' + (un ? un.text : '?') : 'failed'}</b> after ${last.iter} iterations (${bp2.reason}); plain BP on the same LLRs: <b>${st.bp.ok ? 'decoded' : 'failed'}</b>. ${bp2.ok && !st.bp.ok ? 'AP rescued it.' : ''}${!bp2.ok && st.truthText && !/^CQ /.test(st.truthText) && !useMy ? 'The reference message is not a CQ, so the CQ hypothesis is simply wrong here.' : ''}`;
    }
    function drawView() {
      const g = cvV.g; clear(cvV); noteBuf = []; if (!st.bp) { vnote.textContent = ''; return; }
      const it = st.bp.iterations[curIter()];
      if (st.view === 'osd') drawOsd(g);
      else if (st.view === 'ap') drawAp(g);
      else {
        if (st.view === 'tanner') drawTanner(g, it); else if (st.view === 'circle') drawCircle(g, it); else if (st.view === 'heat') drawHeat(g); else drawCheck(g, it);
        vinfo.innerHTML = `iteration <b>${it.iter}</b>: ${it.nUnsat} unsatisfied checks${st.truthCw ? `, ${wrongCount(it)} bits wrong` : ''}`;
      }
      vnote.textContent = noteBuf.join(' ');
    }
    function drawConv() {
      const g = cvC.g, bp = st.bp; clear(cvC); const Lx = 30, W = cvC.w - Lx - 8, H = cvC.h - T - 26; const xs = bp.iterations.map(i => i.iter), ys = bp.iterations.map(i => i.nUnsat); const xmax = Math.max(1, xs[xs.length - 1]);
      linePlot(g, { xs, ys, x: Lx, y: T, w: W, h: H, xmin: 0, xmax, ymin: 0, ymax: 83, color: '#ff5c5c', width: 1.5 });
      if (st.truthCw) { const ys2 = bp.iterations.map(wrongCount); linePlot(g, { xs, ys: ys2, x: Lx, y: T, w: W, h: H, xmin: 0, xmax, ymin: 0, ymax: 83, color: '#ffd166', width: 1.2 }); text(g, 'yellow: wrong bits', Lx + W, T + 12, { align: 'right', color: '#ffd166' }); }
      text(g, 'red: unsatisfied checks', Lx + W, T, { align: 'right', color: '#ff5c5c' });
      vline(g, Lx + curIter() / xmax * W, T, H, '#fff', [2, 2]);
      axisX(g, { x: Lx, y: T + H, w: W, min: 0, max: xmax, ticks: ticks(0, xmax, 5), fmt: v => v }); axisY(g, { x: Lx, y: T, h: H, min: 0, max: 83, ticks: [0, 20, 40, 60, 83], fmt: v => v });
    }
    function drawBits() {
      const it = st.bp.iterations[curIter()]; let html = '';
      for (let i = 0; i < N; i++) { const f = fieldOf(i); const wrong = st.truthCw && it.hard[i] !== st.truthCw[i]; html += `<span class="${f[2]}${wrong ? ' wrong' : ''}" title="bit ${i}: ${f[3]}">${it.hard[i]}</span>`; if (i === 27 || i === 28 || i === 56 || i === 57 || i === 58 || i === 73 || i === 76 || i === 90) html += ' '; }
      bits.innerHTML = html;
    }
    function drawRes() {
      const bp = st.bp, tr = st.trace; const it = bp.iterations[curIter()]; const last = bp.iterations[bp.iterations.length - 1];
      let html = `LLR set <b>${p.metric}/${p.pass}</b>${p.noise ? ` + noise σ ${p.noise}` : ''}${p.scale !== 1 ? ` × ${p.scale}` : ''}: <b>${bp.ok ? 'DECODED by BP' : 'BP failed'}</b> after ${last.iter} iterations — ${bp.reason}<br>`;
      if (bp.ok) { const u = unpack77(bp.bits77); html += `message: <b style="font-family:monospace;font-size:14px">${u ? u.text : '?'}</b> (type ${u ? u.type : '?'})<br>`; }
      else if (it.nUnsat === 0) html += 'parity satisfied but CRC wrong.<br>';
      if (st.truthCw) html += `True codeword known (this candidate decodes with ${tr.result.metric}/${tr.result.pass} via ${tr.result.how}${tr.result.ap ? ', AP ' + tr.result.ap : ''}): <b>${tr.result.message.text}</b>.`;
      else html += st.truthText ? `Reference decode <b>${st.truthText}</b> came from a later pass; nothing here decodes it on this pass's audio, so there is no true codeword to compare.` : 'No known decode at this candidate.';
      html += `<br>Order the decoder tries (depth 3): ${tr.attempts.map(a => a.skipped ? `<span class="pill bad">${a.metric}: ${a.reason}</span>` : `<span class="pill ${a.ok ? 'ok' : ''}">${a.ap ? 'AP' + a.ap + ' ' : ''}${a.metric}/${a.pass} ${a.ok ? '✓ ' + a.how : a.reject ? '✗ ' + a.reject : '✗ bp ' + (a.bp.iterations.length - 1) + ' it' + (a.osd ? ', osd ' + a.osd.attempts.length + '×' : '')}</span>`).join(' ')}`;
      res.innerHTML = html;
    }
    function drawAll() { if (!st.bp) return; bars(cvL, st.llr); drawView(); drawConv(); drawBits(); drawRes(); lastIter = curIter(); }
    // The check squares are 8 px wide and 3.8 px apart at the narrowest width this view is drawn
    // at, so the band around the row is what makes them hittable: 32 px tall (a finger), and the
    // x snaps to the nearest check rather than the one whose cell was hit.
    st.unsubs.push(onPlot(cvV, { onpick: (x, y) => {
      if (st.view !== 'tanner') return;
      if (Math.abs(y - (cvV.h - 46)) > 16) return;
      p.checkIdx = Math.max(0, Math.min(M - 1, Math.round((x - 8) / (cvV.w - 16) * M - 0.5)));
      checkSl.value = p.checkIdx; app.setTab('check');
    } }));
    // One BP iteration lasts half a second of clock time, so ~30 of every 31 ticks would redraw
    // exactly the same picture. Redraw only when the iteration index actually changes, and never
    // for the two views that do not depend on it at all.
    let lastIter = -1;
    st.unsubs.push(app.clock.subscribe(() => {
      if (!st.bp) return;
      const it = curIter(); if (it === lastIter) return; lastIter = it;
      if (BP_VIEWS.includes(st.view)) drawView();
      drawConv(); drawBits(); drawRes();
    }));
    st.unsubs.push(app.on(k => { if (k === 'select') { run(); renderTable(); } if (k === 'sync') renderTable(); }));
    layoutView(); run();
    this.setTab = (id) => { if (!id || !VIEWS.some(v => v[0] === id)) { app.canonicalTab(st.view); return; } if (id === st.view) return; st.view = id; layoutView(); drawAll(); };
    // Rotation or a desktop zoom: every canvas is built from the column it sits in, so re-measure
    // all three (layoutView() does the view canvas, the tab labels and the control row) and repaint.
    this.resize = () => {
      resizePlot(cvL, fitW(llrP, 1000), 150);
      resizePlot(cvC, convW(), 170);
      layoutView(); renderTable(); drawAll();
    };
  },
  setTab: null,
  resize: null,
  // The traces are the big holdings here: a BP run keeps one message array per edge per iteration
  // (522 edges x up to 100), plus the cached OSD, AP and heatmap arrays.
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.setTab = null; this.resize = null; st.trace = null; st.bp = null; st.llr = null; st.truthCw = null; st._heat = null; st._osd = null; st._ap = null; },
};
