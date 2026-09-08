// Stage 4: subtraction and multi-pass. Tab A: wsjtr's recorded per-pass input audio. Tab B: the JS decoder's own passes, live.
import { loadWav } from '../dsp/wav.js';
import { spectrogram, syncSurface, syncHits, dedupeCandidates } from '../dsp/sync.js';
import { slider, select, checkbox, el, panel, canvas, button } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, text, hline, vline, clear, passColor, linePlot } from '../ui/draw.js';

const st = { p: { fmin: 1400, fmax: 1700, dbLo: 35, dbHi: 85 }, mode: 'live', recorded: null, live: null, unsubs: [] };

function analyze(app, audio, label) { const spec = spectrogram(audio); const surf = syncSurface(spec, app.syncParams.freqMin, app.syncParams.freqMax); const hits = syncHits(surf, app.syncParams); const c = dedupeCandidates(hits.hits, app.syncParams); return { audio, label, spec, surf, hits, candidates: c.kept }; }
async function loadRecorded(app) {
  if (st.recorded) return st.recorded;
  app.status('loading residual WAVs…');
  const [p2, p3] = await Promise.all([loadWav('data/260726_190930_pass2.wav'), loadWav('data/260726_190930_pass3.wav')]);
  st.recorded = [analyze(app, app.exampleAudio, 'input to outer pass 1 (raw)'), analyze(app, p2.samples, 'input to outer pass 2'), analyze(app, p3.samples, 'input to outer pass 3')];
  app.status(''); return st.recorded;
}

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); this.mount(root, app); } }); return; }
    const p = st.p; app.clock.setDuration(app.duration);
    const hasRecorded = app.name === '260726_190930';
    if (!hasRecorded) st.mode = 'live';
    root.append(el('h1', null, '4 · Subtraction and passes: the same band, three times'));
    root.append(el('p', 'blurb', 'Once a message is decoded the decoder knows exactly what was transmitted, so it re-synthesizes the 79-tone GFSK waveform, estimates its complex amplitude against the received audio with a low-pass filtered correlation, and subtracts it. Whatever was hiding underneath is now visible to the next pass, which re-runs the coarse sync from scratch on the residual. Tab A shows wsjtr\'s actual per-pass input audio for the recorded window (each outer pass there contains up to four internal decode/subtract rounds, so "input to pass 2" is already missing more than the first burst of decodes). Tab B runs this JS decoder\'s own three passes (depth 1 → 2 → 3, one subtraction round between passes) in a background worker and shows its residuals as they arrive. Zoom on 1500–1600 Hz: the strong KY9L at 1551 Hz is subtracted after pass 1, and two signals inside its footprint (1543 and 1555 Hz) only become candidates afterwards.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div'); main.style.flex = '1'; row.append(main);
    const tabs = el('div', 'tabs'); main.append(tabs);
    const MODES = [['recorded', 'A · wsjtr\'s recorded residuals'], ['live', 'B · this JS decoder, live']];
    for (const [m, label] of MODES) { const b = el('button', m === st.mode ? 'active' : '', label); if (m === 'recorded' && !hasRecorded) { b.disabled = true; b.title = 'only for the bundled window'; } b.onclick = () => { st.mode = m; for (const x of tabs.children) x.classList.toggle('active', x.textContent === label); refresh(); }; tabs.append(b); }
    const wfP = panel(main, 'Per-pass input audio (time ↓, frequency →), boxes = decodes made on that pass'); const cvs = [0, 1, 2].map(() => canvas(wfP, 330, 360)); wfP.querySelectorAll('canvas').forEach(c => { c.style.display = 'inline-block'; c.style.marginRight = '6px'; });
    const spP = panel(main, 'Coarse-sync spectrum on each pass input (÷ its own noise floor)'); const cvS = canvas(spP, 1010, 200);
    const listP = panel(main, 'Decodes by pass'); const list = el('div', 'stats'); listP.append(list);
    slider(ctl, { label: 'freq min', min: 200, max: 3500, step: 10, value: p.fmin, fmt: v => v + ' Hz', oninput: v => { p.fmin = v; if (p.fmax <= v + 50) p.fmax = v + 50; draw(); } });
    slider(ctl, { label: 'freq max', min: 300, max: 4000, step: 10, value: p.fmax, fmt: v => v + ' Hz', oninput: v => { p.fmax = v; if (p.fmin >= v - 50) p.fmin = v - 50; draw(); } });
    slider(ctl, { label: 'color floor', min: 0, max: 100, value: p.dbLo, fmt: v => v + ' dB', oninput: v => { p.dbLo = v; draw(); } });
    slider(ctl, { label: 'color ceiling', min: 20, max: 140, value: p.dbHi, fmt: v => v + ' dB', oninput: v => { p.dbHi = v; draw(); } });
    ctl.append(el('div', 'note', 'Presets: '));
    for (const [a, b, l] of [[1400, 1700, '1543/1551/1555 Hz pileup'], [800, 1000, '850–900 Hz cluster'], [200, 3200, 'whole band']]) { const btn = el('button', null, l); btn.style.margin = '2px'; btn.onclick = () => { p.fmin = a; p.fmax = b; ctl.querySelectorAll('input[type=range]')[0].value = a; ctl.querySelectorAll('input[type=range]')[1].value = b; ctl.querySelectorAll('.ctl b')[0].textContent = a + ' Hz'; ctl.querySelectorAll('.ctl b')[1].textContent = b + ' Hz'; draw(); }; ctl.append(btn); }
    const rerun = button(ctl, 'rerun the JS decoder (3 passes)', () => { app.runJsDecoder(3, [1, 2, 3]); st.live = null; refresh(); }); rerun.style.marginTop = '8px';
    ctl.append(el('div', 'note', 'The JS run uses the current stage-1 sync parameters and my-call from the encode of KC1WIH for AP. Each subtraction costs ~0.4 s in JS (8 FFTs of 180 000 points), so pass 2 appears after a few seconds.'));
    ctl.append(el('div', 'note', hasRecorded ? 'wsjtr ran with -p 3 -d 1,1,3: outer passes 1 and 2 at depth 1, pass 3 at depth 3 (BP + OSD + AP). Purple entries came from A7 cross-sequence decoding after pass 3, using callsigns heard in earlier windows.' : ''));

    const L = 40, T = 6;
    function passesData() {
      if (st.mode === 'recorded') return st.recorded;
      const inputs = app.jsPassInputs || []; if (!st.live) st.live = [];
      inputs.forEach((a, i) => { if (!st.live[i] || st.live[i].audio !== a) st.live[i] = analyze(app, a, i === 0 ? 'input to pass 1 (raw)' : `input to pass ${i + 1} (after ${i} subtraction round${i > 1 ? 's' : ''})`); });
      return st.live.slice(0, 3);
    }
    function decodesList() { return st.mode === 'recorded' ? app.truth.wsjtr : (app.truth.js || []); }
    function draw() {
      const passes = passesData(); if (!passes || !passes.length) { cvs.forEach(cv => { clear(cv); text(cv.g, st.mode === 'live' ? 'waiting for the JS decoder…' : 'loading…', 10, 10, { color: '#8b93a3' }); }); return; }
      const decs = decodesList();
      cvs.forEach((cv, k) => {
        const g = cv.g; clear(cv); const ps = passes[k]; if (!ps) { text(g, `pass ${k + 1}: not yet`, 10, 10, { color: '#8b93a3' }); return; }
        const s = ps.spec; const W = cv.w - L - 6, H = cv.h - T - 40;
        const c0 = Math.max(0, Math.floor(p.fmin / s.df)), c1 = Math.min(s.nbins, Math.ceil(p.fmax / s.df));
        const fx = f => L + (f - p.fmin) / (p.fmax - p.fmin) * W, ty = t => T + t / app.duration * H;
        const y0 = ty(0.08), y1 = ty(0.08 + (s.rows - 1) * 0.04);
        heatmap(g, { data: s.data, rows: s.rows, cols: s.nbins, x: fx(c0 * s.df), y: y0, w: fx(c1 * s.df) - fx(c0 * s.df), h: y1 - y0, vmin: p.dbLo - 10 * Math.log10(3840 / 300), vmax: p.dbHi - 10 * Math.log10(3840 / 300), cmap: 'viridis', log: true, colRange: [c0, c1] });
        for (const d of decs) { if (d.pass !== k + 1 || d.freq + 44 < p.fmin || d.freq > p.fmax) continue; const x = fx(d.freq), w = fx(d.freq + 43.75) - x, y = ty(d.dt + 0.5), h = ty(d.dt + 0.5 + 12.64) - y; g.strokeStyle = passColor(d.pass); g.lineWidth = 1.5; g.strokeRect(x - 2, y, w + 4, h); text(g, d.message.split(' ')[1] || d.message, x + w / 2, y + h + 3, { color: passColor(d.pass), font: '10px system-ui', align: 'center', bg: 'rgba(0,0,0,0.6)' }); }
        hline(g, L, W, ty(app.clock.t), '#ff5c5c');
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
    function refresh() { if (st.mode === 'recorded') loadRecorded(app).then(draw); else draw(); }
    st.unsubs.push(app.clock.subscribe((c, k) => { if (k === 'tick' || k === 'seek') draw(); }));
    st.unsubs.push(app.on(k => { if (k === 'jspass' || k === 'jsdecodes') { if (st.mode === 'live') draw(); } }));
    if (st.mode === 'live' && !(app.jsPassInputs && app.jsPassInputs.length) && !app.worker) app.runJsDecoder(3, [1, 2, 3]);
    refresh();
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; },
};
