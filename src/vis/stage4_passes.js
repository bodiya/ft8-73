// Stage 4: subtraction and multi-pass. Two views of the same idea: wsjtr's recorded per-pass
// input audio, and this decoder's own passes computed live in a worker.
//
// The three waterfalls and the sync-spectrum plot depend only on the pass data and the zoom
// controls, so they live on background layers; the transport clock moves one playhead line per
// waterfall and nothing else.
import { loadWav } from '../dsp/wav.js';
import { spectrogram, syncSurface, syncHits, dedupeCandidates, dropToneSums } from '../dsp/sync.js';
import { slider, select, checkbox, el, panel, canvas, layers, tabbar, caption, coalesce, button } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, text, hline, vline, clear, passColor, linePlot } from '../ui/draw.js';

const st = { p: { fmin: 1400, fmax: 1700, dbLo: 35, dbHi: 85 }, mode: 'live', recorded: null, live: null, sig: null, recordedError: null, unsubs: [] };
const VIEWS = [['recorded', "wsjtr's recorded residuals"], ['live', 'this decoder, live']];
const CAPTIONS = {
  recorded: ['plays the 13.5 s of audio; the playhead is the same time in all three panels.', 'the same band before and after each outer pass. A signal that is bright on the left and gone in the middle was subtracted, and whatever it was covering is now a candidate.'],
  live: ['plays the 13.5 s of audio; the playhead is the same time in all three panels.', 'panels filling in as the worker finishes each pass. Pass 2 takes a few seconds because every subtraction is 8 FFTs of 180 000 points.'],
};

// The spectrogram is kept for the waterfall, but each pass is searched exactly once, so the
// tone-sum table it built is dead weight afterwards (5 MB x 6 passes).
function analyze(app, audio, label) { const spec = spectrogram(audio); const surf = syncSurface(spec, app.syncParams.freqMin, app.syncParams.freqMax); const hits = syncHits(surf, app.syncParams); const c = dedupeCandidates(hits.hits, app.syncParams); dropToneSums(spec); return { audio, label, spec, surf, hits, candidates: c.kept }; }
/** Signature of everything analyze() depends on, so stage 1's knobs invalidate these caches. */
function paramSig(app) { const p = app.syncParams; return `${app.name}|${p.basePct}|${p.syncMin}|${p.mlag}|${p.useRed2}|${p.maxCandidates}|${p.dtTol}|${p.freqTol}|${p.freqMin}|${p.freqMax}`; }
function invalidate(app) { const sig = paramSig(app); if (st.sig !== sig) { st.sig = sig; st.recorded = null; st.live = null; } }
async function loadRecorded(app) {
  if (st.recorded) return st.recorded;
  app.status('loading residual WAVs…');
  try {
    const [p2, p3] = await Promise.all([loadWav(app.asset('data/260726_190930_pass2.wav')), loadWav(app.asset('data/260726_190930_pass3.wav'))]);
    st.recorded = [analyze(app, app.exampleAudio, 'input to outer pass 1 (raw)'), analyze(app, p2.samples, 'input to outer pass 2'), analyze(app, p3.samples, 'input to outer pass 3')];
    app.status('');
  } catch (e) { st.recordedError = 'could not load the residual WAVs: ' + e.message; app.status(st.recordedError); }
  return st.recorded;
}

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); root.textContent = ''; this.mount(root, app); } }); st.unsubs.push(off); return; }  // cancelled by unmount if you navigate away first
    const p = st.p; app.clock.setDuration(app.duration);
    invalidate(app);
    const hasRecorded = app.name === '260726_190930';
    const want = app.tabFor('passes', VIEWS.map(v => v[0]));
    if (want) st.mode = want;
    if (!hasRecorded) st.mode = 'live';
    app.canonicalTab(st.mode);
    root.append(el('h1', null, '4 · Subtraction and passes: the same band, three times'));
    root.append(el('p', 'blurb', 'Once a message is decoded the decoder knows exactly what was transmitted, so it re-synthesizes the 79-tone GFSK waveform, estimates its complex amplitude against the received audio with a low-pass filtered correlation, and subtracts it. Whatever was hiding underneath is now visible to the next pass, which re-runs the coarse sync from scratch on the residual. Zoom on 1500–1600 Hz: the strong KY9L at 1551 Hz is subtracted after pass 1, and two signals inside its footprint (1543 and 1555 Hz) only become candidates afterwards.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div'); main.style.flex = '1'; row.append(main);
    const tabs = tabbar(main, VIEWS, st.mode, id => app.setTab(id));
    if (!hasRecorded) { const b = tabs.el.querySelector('[data-tab=recorded]'); b.disabled = true; b.title = 'only for the bundled window'; }
    const cap = caption(main);
    const wfP = panel(main, 'Per-pass input audio (time ↓, frequency →), boxes = decodes made on that pass');
    const cvs = [0, 1, 2].map(() => { const l = layers(wfP, 330, 360); l.box.style.display = 'inline-block'; l.box.style.marginRight = '6px'; return l; });
    const spP = panel(main, 'Coarse-sync spectrum on each pass input (÷ its own noise floor)'); const cvS = canvas(spP, 1010, 200);
    const listP = panel(main, 'Decodes by pass'); const list = el('div', 'stats'); listP.append(list);
    slider(ctl, { label: 'freq min', min: 200, max: 3500, step: 10, value: p.fmin, fmt: v => v + ' Hz', oninput: v => { p.fmin = v; if (p.fmax <= v + 50) p.fmax = v + 50; drawBgSoon(); } });
    slider(ctl, { label: 'freq max', min: 300, max: 4000, step: 10, value: p.fmax, fmt: v => v + ' Hz', oninput: v => { p.fmax = v; if (p.fmin >= v - 50) p.fmin = v - 50; drawBgSoon(); } });
    slider(ctl, { label: 'color floor', min: 0, max: 100, value: p.dbLo, fmt: v => v + ' dB', oninput: v => { p.dbLo = v; drawBgSoon(); } });
    slider(ctl, { label: 'color ceiling', min: 20, max: 140, value: p.dbHi, fmt: v => v + ' dB', oninput: v => { p.dbHi = v; drawBgSoon(); } });
    ctl.append(el('div', 'note', 'Presets: '));
    for (const [a, b, l] of [[1400, 1700, '1543/1551/1555 Hz pileup'], [800, 1000, '850–900 Hz cluster'], [200, 3200, 'whole band']]) { const btn = el('button', null, l); btn.style.margin = '2px'; btn.onclick = () => { p.fmin = a; p.fmax = b; ctl.querySelectorAll('input[type=range]')[0].value = a; ctl.querySelectorAll('input[type=range]')[1].value = b; ctl.querySelectorAll('.ctl b')[0].textContent = a + ' Hz'; ctl.querySelectorAll('.ctl b')[1].textContent = b + ' Hz'; drawBgSoon(); }; ctl.append(btn); }
    const rerun = button(ctl, 'rerun the JS decoder (3 passes)', () => { app.runJsDecoder(3, [1, 2, 3]); st.live = null; refresh(); }); rerun.style.marginTop = '8px';
    ctl.append(el('div', 'note', 'The JS run uses the current stage-1 sync parameters and my-call from the encode of KC1WIH for AP. Each subtraction costs ~0.4 s in JS (8 FFTs of 180 000 points), so pass 2 appears after a few seconds.'));
    ctl.append(el('div', 'note', hasRecorded ? 'wsjtr ran with -p 3 -d 1,1,3: outer passes 1 and 2 at depth 1, pass 3 at depth 3 (BP + OSD + AP). Purple entries came from A7 cross-sequence decoding after pass 3, using callsigns heard in earlier windows.' : ''));

    const L = 40, T = 6;
    const liveLabel = i => i === 0 ? 'input to pass 1 (raw)' : `input to pass ${i + 1} (after ${i} subtraction round${i > 1 ? 's' : ''})`;
    /**
     * Analysing one pass input is a spectrogram plus a sync surface, about 200 ms. The worker
     * posts three of them while the clock may be playing, so do one per idle slot and redraw
     * after each rather than blocking the frame that happened to receive the message.
     */
    function ensureAnalyses() {
      if (st.mode !== 'live') return;
      const inputs = app.jsPassInputs || []; if (!st.live) st.live = [];
      for (let i = 0; i < Math.min(3, inputs.length); i++) {
        const a = inputs[i];
        if (st.live[i] && st.live[i].audio === a) continue;
        app.idle(() => {
          if (st.mode !== 'live' || !st.live || (st.live[i] && st.live[i].audio === a)) return;
          st.live[i] = analyze(app, a, liveLabel(i));
          drawBg(); drawOv(); ensureAnalyses();
        });
        return;
      }
    }
    function passesData() {
      if (st.mode === 'recorded') return st.recorded;
      if (!st.live) st.live = [];
      return st.live.slice(0, 3);
    }
    function decodesList() { return st.mode === 'recorded' ? app.truth.wsjtr : (app.truth.js || []); }

    /** Backgrounds: three waterfalls, the sync spectra, and the decode list. */
    function drawBg() {
      const passes = passesData(); if (!passes || !passes.length) { const msg = st.mode === 'live' ? 'waiting for the JS decoder…' : (st.recordedError || 'loading…'); cvs.forEach(l => { clear(l[0]); clear(l[1]); text(l[0].g, msg, 10, 10, { color: '#8b93a3' }); }); clear(cvS); list.innerHTML = ''; return; }
      const decs = decodesList();
      cvs.forEach((l, k) => {
        const cv = l[0], g = cv.g; clear(cv); const ps = passes[k]; if (!ps) { text(g, `pass ${k + 1}: not yet`, 10, 10, { color: '#8b93a3' }); return; }
        const s = ps.spec; const W = cv.w - L - 6, H = cv.h - T - 40;
        const c0 = Math.max(0, Math.floor(p.fmin / s.df)), c1 = Math.min(s.nbins, Math.ceil(p.fmax / s.df));
        const fx = f => L + (f - p.fmin) / (p.fmax - p.fmin) * W, ty = t => T + t / app.duration * H;
        const y0 = ty(0.08), y1 = ty(0.08 + (s.rows - 1) * 0.04);
        heatmap(g, { data: s.data, rows: s.rows, cols: s.nbins, x: fx(c0 * s.df), y: y0, w: fx(c1 * s.df) - fx(c0 * s.df), h: y1 - y0, vmin: p.dbLo - 10 * Math.log10(3840 / 300), vmax: p.dbHi - 10 * Math.log10(3840 / 300), cmap: 'viridis', log: true, colRange: [c0, c1] });
        // A7 and other post-pass-3 decodes (pass > 3) are drawn on the pass-3 panel: that is the
        // audio they came out of, and the blurb promises them.
        for (const d of decs) { const panel = Math.min(d.pass, 3) - 1; if (panel !== k || d.freq + 44 < p.fmin || d.freq > p.fmax) continue; const x = fx(d.freq), w = fx(d.freq + 43.75) - x, y = ty(d.dt + 0.5), h = ty(d.dt + 0.5 + 12.64) - y; g.strokeStyle = passColor(d.pass); g.lineWidth = 1.5; g.strokeRect(x - 2, y, w + 4, h); text(g, d.message.split(' ')[1] || d.message, x + w / 2, y + h + 3, { color: passColor(d.pass), font: '10px system-ui', align: 'center', bg: 'rgba(0,0,0,0.6)' }); }
        axisX(g, { x: L, y: T + H, w: W, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, 4), fmt: v => v }); axisY(g, { x: L, y: T, h: H, min: 0, max: app.duration, ticks: [0, 3, 6, 9, 12], fmt: v => v + 's', flip: true });
        text(g, ps.label, L + W / 2, T + H + 22, { align: 'center', color: '#e6e9ef' });
      });
      const g = cvS.g; clear(cvS); const W = cvS.w - L - 8, H = cvS.h - T - 26; const ymax = 12;
      passes.forEach((ps, k) => { const s = ps.surf, xs = [], ys = []; for (let i = 0; i < s.nb; i++) if (s.freqs[i] >= p.fmin && s.freqs[i] <= p.fmax) { xs.push(s.freqs[i]); ys.push(Math.min(ps.hits.red[i], ymax)); } linePlot(g, { xs, ys, x: L, y: T, w: W, h: H, xmin: p.fmin, xmax: p.fmax, ymin: 0, ymax, color: passColor(k + 1), width: 1.2 }); });
      hline(g, L, W, T + H - app.syncParams.syncMin / ymax * H, '#ff8c42', [5, 3]);
      axisX(g, { x: L, y: T + H, w: W, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, 8), fmt: v => v + ' Hz' }); axisY(g, { x: L, y: T, h: H, min: 0, max: ymax, ticks: [0, 4, 8, 12], fmt: v => v });
      text(g, passes.map((ps, k) => `pass ${k + 1} input: ${ps.hits.hits.length} hits, ${ps.candidates.length} candidates`).join('   ·   '), L + W, T, { align: 'right', bg: 'rgba(0,0,0,0.6)' });
      const byPass = {}; for (const d of decs) (byPass[d.pass] = byPass[d.pass] || []).push(d);
      list.innerHTML = (Object.keys(byPass).sort().map(k => `<div><b style="color:${passColor(+k)}">${+k <= 3 ? 'pass ' + k : 'A7 / after pass 3'}</b> (${byPass[k].length}): <span style="font-family:monospace">${byPass[k].sort((a, b) => a.freq - b.freq).map(d => `${d.freq} ${d.message} (${d.snr}${d.how ? ', ' + d.how : ''})`).join(' · ')}</span></div>`).join('')) || '<span class="note">no decodes yet</span>';
      if (st.mode === 'live' && app.truth.wsjtr.length) { const ref = new Set(app.truth.wsjtr.map(d => d.message)); const got = decs.filter(d => ref.has(d.message)).length; const extra = decs.filter(d => !ref.has(d.message)); list.append(el('div', 'note', `JS decoder: ${decs.length} messages, ${got} of them in wsjtr's list of ${app.truth.wsjtr.length}${extra.length ? '; not in wsjtr\'s list: ' + extra.map(d => d.message).join(', ') : ''}.`)); }
    }
    /** Overlay: one playhead per waterfall. */
    function drawOv() {
      const t = app.clock.t;
      cvs.forEach(l => { const cv = l[1], g = cv.g; clear(cv); const W = cv.w - L - 6, H = cv.h - T - 40; hline(g, L, W, T + t / app.duration * H, '#ff5c5c'); });
    }
    const drawBgSoon = coalesce(() => { drawBg(); drawOv(); });
    function refresh() { cap.set(...CAPTIONS[st.mode]); if (st.mode === 'recorded') loadRecorded(app).then(() => { drawBg(); drawOv(); }); else { ensureAnalyses(); drawBg(); drawOv(); } }
    st.unsubs.push(app.clock.subscribe(() => drawOv()));
    st.unsubs.push(app.on(k => {
      if (k === 'sync') { invalidate(app); refresh(); }
      if (k === 'jspass' || k === 'jsdecodes') { if (st.mode === 'live') { ensureAnalyses(); drawBgSoon(); } }
    }));
    if (st.mode === 'live') app.ensureJsDecoder();
    refresh();
    this.setTab = (id) => { if (!id || !VIEWS.some(v => v[0] === id) || (id === 'recorded' && !hasRecorded)) { app.canonicalTab(st.mode); return; } if (id === st.mode) return; st.mode = id; tabs.set(id); if (id === 'live') app.ensureJsDecoder(); refresh(); };
  },
  setTab: null,
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.setTab = null; },
};
