// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// J · JTTY: WSJT-X 3.2's keyboard-to-keyboard mode, one page with four views.
//
//   #jtty/signal   the recording, the receive window as it fills, and the decode log
//   #jtty/encode   text -> fewest frames -> 34 bits -> CRC-12 -> K=10 tail-biting code -> 4-GFSK
//   #jtty/sync     how the receiver finds a frame with no time slots: the sync surface per window
//   #jtty/trellis  the list-Viterbi (WAVA) decode of one frame, and the L = 1, 2, 4 ladder
//
// Everything runs on this page's own audio (the WSJT-X sample by default, or a transmission made
// on the encode view, or a WAV you open here), not on the FT8 window the other pages share. The
// receiver runs in a worker and streams one decode window at a time, which is what it does on the
// air too; every plot uses what has arrived so far.
//
// Drawing follows the app's rule: each plot is a background layer redrawn when its inputs change
// and a transparent overlay that is all the clock touches, and the clock is quantized per view
// (a window, a symbol, a trellis step) so a 60 Hz tick is mostly a no-op.
import { loadWav, parseWav } from '../dsp/wav.js';
import { resampleTo12k } from '../dsp/resample.js';
import { powerSpectrum } from '../dsp/fft.js';
import { packMessage, payloadFields, describeAtom, unpackFrame, PROFILE } from '../dsp/jtty/codec.js';
import { SYNC13, G0, G1, tbccEncode, tbccDecode, encodeInfo, transition, NSTATES } from '../dsp/jtty/fec.js';
import { messageTones, phaseIncrements, simulate, gaussian } from '../dsp/jtty/wave.js';
import { frameCorrelations, DF2 } from '../dsp/jtty/receiver.js';
import { slider, select, checkbox, el, panel, layers, tabbar, caption, coalesce, debounce, button, tryThis, textInput, fitW, resizePlot, onPlot, isNarrow, coarse, constrained } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, hline, vline, clear, linePlot } from '../ui/draw.js';

const FS = 12000, SYM = 0.032, FRAME = 59 * SYM, STEP = FRAME / 4, CHUNK = FRAME * 1.25, BAUD = 31.25;
const VIEWS = [['signal', 'the signal'], ['encode', 'encode'], ['sync', 'finding frames'], ['trellis', 'the trellis']];
const MSG_COLORS = ['#4ea1ff', '#3ddc97', '#ffd166', '#c792ea', '#ff8c42', '#5ce1e6'];
const FIELD_COLORS = { call28: '#4ea1ff', n2: '#ff8c42', role: '#ff8c42', kind: '#ffd166', family: '#c792ea', i2: '#ff5c5c', reserved: '#8b93a3', EOM: '#3ddc97', zero5: '#555c6b', zero1: '#555c6b', zero: '#555c6b' };
const fieldColor = n => FIELD_COLORS[n] || (n.startsWith('char') ? ['#4ea1ff', '#3ddc97', '#ffd166', '#c792ea', '#ff8c42'][+n.slice(4) - 1] : '#e6e9ef');
const EXAMPLES = ['CQ KA1ABC CQ', 'WB9XYZ', 'WB9XYZ 599 101', '599 057', 'TU NOW JA6DEF 599 102', 'JA6DEF AGN?', 'TU KA1ABC CQ', '1D EMA', 'THE QUICK BROWN FOX'];
const RESULT_COLORS = { decoded: '#3ddc97', 'seen before': '#4ea1ff', duplicate: '#4ea1ff', gate: '#8b93a3', 'no codeword': '#ff5c5c', 'invalid source': '#ff5c5c', 'symbol errors': '#ff5c5c' };

const st = {
  view: 'signal', audio: null, name: '', base: null, sample: null, sampleRef: null, loading: null,
  run: null, worker: null, job: 0, spec: null,
  rx: { f0: 1500, ftol: 50, noiseDb: 0 },
  sig: { zoom: 'signal', range: 22, boxes: true, volume: 0.6 },
  enc: { msg: 'CQ KA1ABC CQ', profile: 0, f0: 1500, snr: -8, frame: 0 },
  syn: { contours: true, held: true, pick: -1, span: 'qso' },
  tre: { key: '', noise: 0, df: 0, L: 'ladder', width: 4, wraps: 2, seed: 1, rung: -1 },
  unsubs: [], viewUnsubs: [], audioCtx: null, gain: null, src: null, buf: null, bufFor: null,
};
let mountTok = 0;

// ---- audio ----
function stopAudio() { if (st.src) { try { st.src.stop(); } catch { } st.src = null; } }
function syncAudio(app, samples, vol) {
  try {
    const c = app.clock; stopAudio(); if (!c.playing || !samples) return;
    if (!st.audioCtx) { st.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); st.gain = st.audioCtx.createGain(); st.gain.connect(st.audioCtx.destination); }
    if (st.audioCtx.state !== 'running') Promise.resolve(st.audioCtx.resume()).catch(() => { });
    if (st.bufFor !== samples) { let m = 1; for (const v of samples) m = Math.max(m, Math.abs(v)); const b = st.audioCtx.createBuffer(1, samples.length, FS), ch = b.getChannelData(0); for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / m * 0.8; st.buf = b; st.bufFor = samples; }
    st.gain.gain.value = vol;
    const s = st.audioCtx.createBufferSource(); s.buffer = st.buf; s.loop = c.loop; s.playbackRate.value = c.speed; s.connect(st.gain);
    s.start(0, Math.min(c.t, st.buf.duration - 0.01)); st.src = s;
  } catch (e) { app.status('audio unavailable: ' + (e && e.message || e)); }
}
function setSpeed(s) { const r = document.getElementById('speed'); if (r) { r.value = Math.log2(s); r.dispatchEvent(new Event('input')); } }

// ---- the page's audio and the receiver run ----
/** RMS of the recording, standing in for its noise level (a weak JTTY signal is a small part of it). */
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); }
function withNoise(base, db) {
  if (!db) return base;
  const sig = rms(base) * Math.sqrt(Math.pow(10, db / 10) - 1), g = gaussian(4321), out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(base[i] + sig * g())));
  return out;
}
/** Hann-windowed 384-sample frames zero-padded to 1536 (7.8 Hz bins), every 8 ms, 0-3 kHz, stored [bin][frame]. */
function spectrogramT(x) {
  const win = 384, nfft = 1536, hop = 96, nb = 385, cols = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const data = new Float32Array(nb * cols), fr = new Float64Array(win), w = new Float64Array(win);
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / win);
  const sample = [];
  for (let c = 0; c < cols; c++) {
    for (let i = 0; i < win; i++) fr[i] = (x[c * hop + i] || 0) * w[i];
    const ps = powerSpectrum(fr, nfft);
    for (let b = 0; b < nb; b++) { const v = 10 * Math.log10(ps[b] + 1); data[b * cols + c] = v; if (b > 128 && b < 256 && (c & 7) === 0) sample.push(v); }
  }
  sample.sort((a, b) => a - b);
  return { data, rows: nb, cols, df: FS / nfft, hop, t0: win / 2 / FS, dt: hop / FS, floor: sample[Math.floor(sample.length / 2)] || 0 };
}

function runKey() { return `${st.name}|${st.rx.f0}|${st.rx.ftol}|${st.rx.noiseDb}`; }
/** (Re)start the worker unless a run with these settings exists. onUpdate fires per decode window. */
function ensureRun(app, onUpdate) {
  const key = runKey();
  if (st.run && st.run.key === key) return;
  if (st.worker) { st.worker.terminate(); st.worker = null; }
  const job = ++st.job, audio = st.audio;
  st.run = { key, steps: [], events: [], messages: [], n: 0, done: false, err: null, t0: performance.now() };
  if (audio.length < CHUNK * FS) { st.run.done = true; st.run.err = 'the audio is shorter than one 2.36 s decode window'; onUpdate(); return; }
  let w;
  try { w = st.worker = new Worker(new URL('../dsp/jtty/worker.js', import.meta.url), { type: 'module' }); }
  catch (e) { st.run.err = 'could not start the decoder worker: ' + e.message; st.run.done = true; onUpdate(); return; }
  const run = st.run;
  w.onmessage = ev => {
    const m = ev.data; if (m.id !== job || st.run !== run) return;
    if (m.type === 'start') run.n = m.n;
    if (m.type === 'step') { run.steps[m.k] = m.call; for (const e of m.events) run.events.push(e); run.messages = m.messages; run.k = m.k; }
    if (m.type === 'done') { run.done = true; run.ms = performance.now() - run.t0; w.terminate(); if (st.worker === w) st.worker = null; }
    if (m.type === 'error') { run.err = m.message; run.done = true; w.terminate(); if (st.worker === w) st.worker = null; }
    onUpdate(m.type);
  };
  w.onerror = e => { run.err = e.message || 'worker failed'; run.done = true; if (st.worker === w) st.worker = null; onUpdate('error'); };
  w.postMessage({ id: job, audio: Float32Array.from(audio), opts: { f0: st.rx.f0, ftol: st.rx.ftol } });
}
function runStatus() {
  const r = st.run; if (!r) return '';
  if (r.err) return 'decoder: ' + r.err;
  const nf = r.events.filter(e => !e.pure).length;
  if (!r.done) return `decoding: window ${Math.min(r.n, (r.k ?? -1) + 1)} of ${r.n}, ${nf} frames so far`;
  return `${r.n} windows, ${nf} frames, ${r.messages.length} message${r.messages.length === 1 ? '' : 's'}` + (r.ms ? ` in ${(r.ms / 1000).toFixed(1)} s` : '');
}
const frames = () => (st.run ? st.run.events.filter(e => !e.pure) : []);
const msgColor = id => MSG_COLORS[((id || 1) - 1) % MSG_COLORS.length];

function setAudio(app, samples, name) {
  st.base = samples; st.audio = withNoise(samples, st.rx.noiseDb); st.name = name;
  st.spec = null; st.run = null; st.tre.key = ''; st.syn.pick = -1;
  if (st.worker) { st.worker.terminate(); st.worker = null; }
}

// ---- small drawing helpers ----
const L = 46, T = 8, R = 8, B = 24;
function box(cv) { return { x: L, y: T, w: cv.w - L - R, h: cv.h - T - B }; }
/** A frequency x time waterfall from spectrogramT, time across. */
function drawWaterfall(g, spec, bx, t0, t1, f0, f1, range) {
  const c0 = Math.max(0, Math.floor((t0 - spec.t0) / spec.dt)), c1 = Math.min(spec.cols, Math.ceil((t1 - spec.t0) / spec.dt) + 1);
  const r0 = Math.max(0, Math.floor(f0 / spec.df)), r1 = Math.min(spec.rows, Math.ceil(f1 / spec.df) + 1);
  if (c1 <= c0 || r1 <= r0) return;
  const X = t => bx.x + (t - t0) / (t1 - t0) * bx.w, Y = f => bx.y + bx.h - (f - f0) / (f1 - f0) * bx.h;
  const xa = X(spec.t0 + (c0 - 0.5) * spec.dt), xb = X(spec.t0 + (c1 - 0.5) * spec.dt), ya = Y((r1 - 0.5) * spec.df), yb = Y((r0 - 0.5) * spec.df);
  g.save(); g.beginPath(); g.rect(bx.x, bx.y, bx.w, bx.h); g.clip();
  heatmap(g, { data: spec.data, rows: spec.rows, cols: spec.cols, x: xa, y: ya, w: xb - xa, h: yb - ya, vmin: spec.floor + 1, vmax: spec.floor + range, cmap: 'viridis', flipY: true, colRange: [c0, c1], rowRange: [r0, r1] });
  g.restore();
}
function freqAxis(g, bx, f0, f1) { axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: f0, max: f1, ticks: ticks(f0, f1, Math.max(2, Math.min(6, Math.floor(bx.h / 34)))), fmt: v => v }); }
function timeAxis(g, bx, t0, t1, fmt = v => v + ' s') { axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: t0, max: t1, ticks: ticks(t0, t1, Math.min(10, tickCount(bx.w, 50))), fmt }); }
function signalFreq() { const f = frames(); if (!f.length) return st.rx.f0; const s = f.map(e => e.f1).sort((a, b) => a - b); return s[s.length >> 1]; }

export default {
  mount(root, app) {
    // This page has its own audio, but app.js's first setAudio() (the FT8 window) resets the shared
    // clock, so mount after it like every other page does.
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); root.textContent = ''; this.mount(root, app); } }); st.unsubs.push(off); return; }
    const tok = ++mountTok;
    const want = app.tabFor('jtty', VIEWS.map(v => v[0])); if (want) st.view = want;
    app.canonicalTab(st.view);
    root.append(el('h1', null, 'J · JTTY: keyboard to keyboard, no time slots'));
    root.append(el('p', 'blurb', 'JTTY is the RTTY-style mode in WSJT-X 3.2. A transmission starts whenever you press send and is a run of 1.888 s frames; each frame carries 34 bits (one callsign action, one contest exchange, or five characters), protected by a 12-bit CRC and a rate-1/2 convolutional code, and sent as 59 four-tone symbols. The receiver never waits for a slot: it re-examines the last 2.36 s every 0.47 s and prints each frame as soon as it decodes. Every algorithm here is a JavaScript port of WSJT-X\'s lib/jtty, checked value by value against the Fortran.'));
    const cmp = el('table', 'list'); cmp.style.marginBottom = '12px';
    cmp.innerHTML = '<tr><th class="msg"></th><th class="msg">JTTY</th><th class="msg">FT8</th></tr>' + [
      ['timing', '15 s slots, everyone in step', 'none: a frame can start any time'],
      ['one transmission', '12.64 s, 77 bits', '1.888 s per frame, 34 bits, 1 to 16 frames'],
      ['modulation', '8-GFSK, 6.25 Hz, 79 symbols', '4-GFSK, 31.25 Hz, 59 symbols (13 sync + 46 data)'],
      ['bandwidth', 'about 50 Hz', 'about 127 Hz (99% of power)'],
      ['error control', 'CRC-14 + LDPC (174,91)', 'CRC-12 + tail-biting convolutional K=10, rate 1/2'],
      ['decoder', 'belief propagation, then OSD', 'list Viterbi (WAVA), coherent over 1, 2 then 4 symbols'],
      ['text', '13 characters of free text at most', 'any length: 5 characters per frame, contest atoms packed tighter'],
    ].map(r => `<tr><td class="msg"><b>${r[0]}</b></td><td class="msg">${r[2]}</td><td class="msg" style="color:var(--muted)">${r[1]}</td></tr>`).join('');
    cmp.querySelectorAll('td, th').forEach(c => { c.style.fontFamily = 'inherit'; });
    const cmpWrap = el('div'); cmpWrap.style.overflowX = 'auto'; cmpWrap.append(cmp); root.append(cmpWrap);
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const tabs = tabbar(main, VIEWS, st.view, id => app.setTab(id));
    const cap = caption(main);
    const viewMain = el('div'); main.append(viewMain);

    // -- receiver block: the audio and the decoder settings, shared by three views --
    const rxBox = el('div'); ctl.append(rxBox);
    rxBox.append(el('div', 'lab', 'audio'));
    const src = el('div', 'stats'); rxBox.append(src);
    const btnRow = el('div'); btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:4px 0';
    const fileLab = el('label', 'filebtn', 'open a JTTY WAV'); fileLab.htmlFor = 'jtty-wav';
    const fileIn = el('input'); fileIn.type = 'file'; fileIn.id = 'jtty-wav'; fileIn.className = 'vh'; fileIn.accept = 'audio/wav,audio/x-wav,audio/wave,audio/*,.wav';
    const sampleB = el('button', 'filebtn', 'WSJT-X sample'); sampleB.style.fontSize = '12px';
    btnRow.append(fileLab, sampleB); rxBox.append(btnRow);
    root.append(fileIn);   // outside the controls panel: a 1 px input is not a tap target, its label is
    const noiseS = slider(rxBox, { label: 'add noise', min: 0, max: 18, step: 1, value: st.rx.noiseDb, fmt: v => v ? `+${v} dB` : 'none', oninput: v => { st.rx.noiseDb = v; renoise(); } });
    const f0S = slider(rxBox, { label: 'QSO window centre (channel 0)', min: 400, max: 2600, step: 10, value: st.rx.f0, fmt: v => v + ' Hz', oninput: v => { st.rx.f0 = v; rerun(); } });
    const ftolS = select(rxBox, { label: 'QSO window width (± ftol)', options: [['20', '± 20 Hz'], ['50', '± 50 Hz (default)'], ['100', '± 100 Hz'], ['200', '± 200 Hz'], ['500', '± 500 Hz']], value: String(st.rx.ftol), onchange: v => { st.rx.ftol = +v; rerun(); } });
    const runLine = el('div', 'stats'); rxBox.append(runLine);
    rxBox.append(el('div', 'note', 'Channel 0 is the QSO window around your own frequency: it searches first, with the gentler gate. Channels 1 and 2 always watch 1200 to 1500 and 1500 to 1800 Hz with a stricter one. Changing either knob reruns the decoder.'));
    const viewCtl = el('div'); viewCtl.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:8px'; ctl.append(viewCtl);

    let view = null;
    const onRunUpdate = coalesce(() => { if (tok !== mountTok) return; runLine.textContent = runStatus(); if (view && view.onRun) view.onRun(); });
    const rerun = debounce(() => { if (tok !== mountTok || !st.audio) return; ensureRun(app, onRunUpdate); onRunUpdate(); }, 300);
    function renoise() { st.audio = withNoise(st.base, st.rx.noiseDb); st.spec = null; st.tre.key = ''; if (view && view.onAudio) view.onAudio(); rerun(); }
    function describeSource() { src.innerHTML = st.audio ? `<b>${st.name}</b>: ${(st.audio.length / FS).toFixed(1)} s at 12 kHz` : 'loading…'; }
    const useAudio = (samples, name) => { setAudio(app, samples, name); describeSource(); if (view && view.onAudio) view.onAudio(); ensureRun(app, onRunUpdate); onRunUpdate(); };
    fileIn.onchange = async () => {
      const f = fileIn.files[0]; if (!f) return;
      try { const w = parseWav(await f.arrayBuffer()); let s = w.rate === FS ? w.samples : resampleTo12k(w.samples, w.rate); if (s.length > 120 * FS) s = s.slice(0, 120 * FS);
        useAudio(s, f.name.replace(/\.wav$/i, '')); } catch (e) { app.status('could not load WAV: ' + e.message); }
      fileIn.value = '';
    };
    sampleB.onclick = () => { if (st.sample) useAudio(st.sample, '260807_134110 (WSJT-X sample)'); };
    const shared = { app, tok, ctl: viewCtl, main: viewMain, cap, rxBox, useAudio, setView: id => app.setTab(id), f0S, ftolS, noiseS, rerun };

    function show(id) {
      if (view && view.destroy) view.destroy();
      for (const u of st.viewUnsubs) u(); st.viewUnsubs = [];
      stopAudio(); app.clock.pause();
      viewCtl.innerHTML = ''; viewMain.innerHTML = '';
      st.view = id; tabs.set(id);
      rxBox.style.display = id === 'encode' ? 'none' : '';
      view = VIEW_IMPL[id](shared);
      if (st.audio) { if (view.onAudio) view.onAudio(); if (view.onRun) view.onRun(); }
    }
    this.setTab = id => { if (!id || !VIEWS.some(v => v[0] === id)) { app.canonicalTab(st.view); return; } if (id === st.view) return; show(id); };
    this.resize = () => { if (view && view.resize) view.resize(); };
    st.unsubs.push(app.clock.subscribe((c, kind) => { if (view && view.tick) view.tick(c, kind); }));

    describeSource();
    show(st.view);
    // The sample is 726 KB and only this page wants it, so it is fetched on first visit, not preloaded.
    if (!st.sample) {
      app.status('loading the JTTY sample…');
      st.loading = st.loading || Promise.all([loadWav(app.asset('data/260807_134110.wav')), fetch(app.asset('data/260807_134110.jtty.json')).then(r => r.json())]);
      st.loading.then(([w, ref]) => {
        st.sample = w.samples; st.sampleRef = ref; app.status('');
        if (tok !== mountTok) return;
        if (!st.audio) useAudio(st.sample, '260807_134110 (WSJT-X sample)');
      }).catch(e => { app.status('could not load the JTTY sample: ' + e.message); st.loading = null; });
    } else if (!st.audio) useAudio(st.sample, '260807_134110 (WSJT-X sample)');
    else { describeSource(); ensureRun(app, onRunUpdate); onRunUpdate(); }
  },
  setTab: null,
  resize: null,
  unmount() {
    mountTok++; stopAudio(); if (st.audioCtx && st.audioCtx.state === 'running') st.audioCtx.suspend();
    for (const u of st.unsubs) u(); for (const u of st.viewUnsubs) u(); st.unsubs = []; st.viewUnsubs = [];
    this.setTab = null; this.resize = null;
    // The run and its per-window surfaces (up to ~12 MB for the sample) are kept on a desktop so
    // coming back is instant; a phone gets the memory back and re-decodes on return.
    if (constrained()) { if (st.worker) { st.worker.terminate(); st.worker = null; } st.run = null; st.spec = null; }
  },
};

// ======================================================================================
// view: the signal
// ======================================================================================
function signalView(S) {
  const { app, ctl, main, cap } = S, p = st.sig;
  cap.set('plays the recording; the bracket on the waterfall is the 2.36 s the receiver is decoding at that moment, and the text below is what an operator would have on screen by then.',
    'frames appearing in the receive window about 2.4 s after they were sent, five characters at a time. A frame that fails leaves a " ... " gap and the message carries on.');
  tryThis(main, [
    { label: 'watch it arrive', see: 'Each frame is printed when the decode window that first contains all of it closes, so text lags the audio by 2 to 2.4 s. <b>RAN A</b> at 3.1 s, then five more characters every 1.888 s: 10 frames, 47 characters, 18.9 s on the air.', run: () => { app.clock.seek(0); setSpeed(1); app.clock.play(); } },
    { label: 'one frame, up close', see: 'The lower plot follows the frame under the playhead: 13 sync symbols (orange boxes: tones 0 2 2 3 0 0 3 2 1 3 1 2 0), then 46 data symbols, each one of four tones 31.25 Hz apart for 32 ms.', run: () => { app.clock.pause(); app.clock.seek(4.2); } },
    { label: 'bury it in noise', see: 'Adds 11 dB of noise and decodes again (about 30 s of worker time, so watch the log fill). Two frames in the middle no longer decode and the message reads <b>RAN ALL NIGHT O ... SE - NO FALSE DECODES!</b>: JTTY prints what it can and marks the gap. At +12 dB the gap is four frames, longer than the three it will bridge, and the text arrives as two messages. The sync gate and the CRC keep garbage off the screen either way.', run: () => { S.noiseS.value = 11; S.noiseS.input.dispatchEvent(new Event('input')); } },
    { label: 'the whole passband', see: 'Zoomed out to 200 to 2800 Hz: one 127 Hz wide trace. Channels 1 and 2 cover 1200 to 1800 Hz, so a station that calls off your frequency is still seen.', run: () => { p.zoom = 'wide'; zoomSel.value = 'wide'; drawBg(); } },
    { label: 'at quarter speed', see: 'Slowed down you can hear the four tones and the 13-symbol sync burst that opens every frame.', run: () => { setSpeed(0.25); app.clock.seek(2.8); app.clock.play(); } },
  ]);
  const wfP = panel(main, 'Waterfall (time across), with decoded frames'); const wf = layers(wfP, fitW(wfP, 1100), 240);
  const legend = el('div', 'note'); wfP.append(legend);
  const rxP = panel(main, 'Receive window, as of the playhead'); const rxDiv = el('div'); rxDiv.style.cssText = 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.6;min-height:3em;white-space:pre-wrap;word-break:break-word'; rxP.append(rxDiv);
  const fP = panel(main, 'The frame under the playhead'); const fr = layers(fP, fitW(fP, 1100), 210); const fNote = el('div', 'note'); fP.append(fNote);
  const logP = panel(main, 'Decode log (rows under the playhead are frames already heard)'); const logDiv = el('div', 'scroll'); logP.append(logDiv);

  const zoomSel = select(ctl, { label: 'frequency range', options: [['signal', 'around the signal'], ['channels', '1150 to 1850 Hz (all three channels)'], ['wide', '200 to 2800 Hz']], value: p.zoom, onchange: v => { p.zoom = v; drawBg(); } });
  slider(ctl, { label: 'colour range', min: 8, max: 50, value: p.range, fmt: v => v + ' dB', oninput: debounce(v => { p.range = v; drawBg(); drawFrameBg(true); }, 120) });
  checkbox(ctl, { label: 'outline decoded frames', value: p.boxes, onchange: v => { p.boxes = v; drawBg(); } });
  slider(ctl, { label: 'volume', min: 0, max: 1, step: 0.05, value: p.volume, fmt: v => Math.round(v * 100) + '%', oninput: v => { p.volume = v; if (st.gain) st.gain.gain.value = v; } });

  const range = () => { if (p.zoom === 'wide') return [200, 2800]; if (p.zoom === 'channels') return [1150, 1850]; const f = signalFreq(); return [Math.round(f - 80), Math.round(f + 180)]; };
  const dur = () => st.audio ? st.audio.length / FS : 30;
  function drawBg() {
    const cv = wf[0], g = cv.g; clear(cv); if (!st.audio) return;
    if (!st.spec) st.spec = spectrogramT(st.audio);
    const bx = box(cv), [f0, f1] = range(), D = dur();
    drawWaterfall(g, st.spec, bx, 0, D, f0, f1, p.range);
    const X = t => bx.x + t / D * bx.w, Y = f => bx.y + bx.h - (f - f0) / (f1 - f0) * bx.h;
    if (p.boxes) for (const e of frames()) {
      const x0 = X(e.tsync), x1 = X(e.tsync + FRAME), y0 = Y(e.f1 + 3 * BAUD + 16), y1 = Y(e.f1 - 16), c = msgColor(e.messageId);
      g.save(); g.strokeStyle = c; g.lineWidth = 1.2; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.fillStyle = c; g.globalAlpha = 0.18; g.fillRect(x0, y0, X(e.tsync + 13 * SYM) - x0, y1 - y0); g.restore();
      g.save(); g.font = '11px ui-monospace, monospace'; const tw = g.measureText(e.frame).width; g.restore();
      if (tw + 4 < x1 - x0) text(g, e.frame.replace(/ /g, '·'), (x0 + x1) / 2, Math.max(bx.y + 1, y0 - 14), { align: 'center', color: c, font: '11px ui-monospace, monospace', bg: 'rgba(0,0,0,0.55)' });
    }
    freqAxis(g, bx, f0, f1); timeAxis(g, bx, 0, D);
    legend.textContent = frames().length ? 'Boxes: one per decoded frame, coloured by message; the tinted left part is the 13-symbol sync. Text above a box is that frame\'s content (· is a space).' : (st.run && !st.run.done ? 'decoding…' : 'no frames decoded');
    lastT = -1; drawOv();
  }
  let lastT = -1;
  function drawOv() {
    const t = app.clock.t, q = Math.round(t * 60) / 60; if (q === lastT) return; lastT = q;
    const cv = wf[1], g = cv.g; clear(cv); if (!st.audio) return;
    const bx = box(cv), D = dur(), X = tt => bx.x + tt / D * bx.w;
    const k = Math.floor((t - CHUNK) / STEP);
    if (k >= 0) { const a = X(k * STEP), b = X(k * STEP + CHUNK); g.save(); g.strokeStyle = 'rgba(255,255,255,0.55)'; g.setLineDash([4, 3]); g.strokeRect(a, bx.y + 1, b - a, bx.h - 2); g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(a, bx.y, X(k * STEP + STEP + 0.024) - a, bx.h); g.restore(); }
    vline(g, X(t), bx.y, bx.h, '#ff5c5c');
  }
  // receive window and log: they change only when a frame becomes heard, so key on that count
  let heardN = -1;
  function drawText(force = false) {
    const t = app.clock.t, ev = st.run ? st.run.events : [], heard = ev.filter(e => e.tAvail <= t + 1e-9);
    if (!force && heard.length === heardN) return; heardN = heard.length;
    const latest = new Map(); for (const e of heard) if (e.messageId) latest.set(e.messageId, e);
    const lines = [...latest.values()].sort((a, b) => a.messageId - b.messageId).map(e => {
      const m = st.run.messages.find(x => x.id === e.messageId), done = e.eom;
      return `<span style="color:${msgColor(e.messageId)}">${Math.round(e.f1).toString().padStart(4)} Hz</span>  ${escapeHtml(e.message)}${done ? '  <span style="color:#3ddc97">[end of message]</span>' : '<span style="color:#ff5c5c">▌</span>'}`;
    });
    rxDiv.innerHTML = lines.join('\n') || `<span style="color:#8b93a3">${st.run && st.run.done && !ev.length ? 'nothing decoded in this recording' : t < 2.4 ? 'nothing yet: the first frame can print about 2.4 s after it starts' : 'nothing yet'}</span>`;
    const rows = logDiv.querySelectorAll('tr[data-i]'); rows.forEach(r => { r.style.opacity = +r.dataset.t <= t + 1e-9 ? '1' : '0.35'; });
  }
  function buildLog() {
    const ev = st.run ? st.run.events : [];
    if (!ev.length) { logDiv.innerHTML = `<span class="note">${st.run && !st.run.done ? 'decoding…' : 'no frames'}</span>`; return; }
    logDiv.innerHTML = `<table class="list"><tr><th>heard at</th><th>ch</th><th>Hz</th><th>starts</th><th>SNR</th><th>sync</th><th>errs</th><th>L</th><th class="msg">frame</th><th class="msg">message so far</th></tr>${ev.map((e, i) =>
      `<tr data-i="${i}" data-t="${e.tAvail}"><td>${e.tAvail.toFixed(2)}</td><td>${e.ichan}${e.retro ? 'r' : ''}</td><td>${e.f1.toFixed(1)}</td><td>${e.tsync.toFixed(3)}</td><td>${e.snr}</td><td>${e.nsync < 0 ? 'retry' : e.nsync + '/13'}</td><td>${e.nsymerrs}</td><td>${e.L}</td><td class="msg">${escapeHtml(e.frame)}${e.pure ? ' (again)' : ''}</td><td class="msg" style="color:${msgColor(e.messageId)}">${escapeHtml(e.message)}</td></tr>`).join('')}</table>`;
    logDiv.querySelectorAll('tr[data-i]').forEach(r => r.onclick = () => { app.clock.pause(); app.clock.seek(+r.dataset.t); });
    drawText(true);
  }
  // the frame view: the decoded frame that contains the playhead, else the last one before it
  let curFrame = null;
  function frameAt(t) { const f = frames(); let best = null; for (const e of f) { if (e.tsync <= t) best = e; } return best; }
  function drawFrameBg(force = false) {
    const e = frameAt(app.clock.t); if (!force && e === curFrame) return; curFrame = e;
    const cv = fr[0], g = cv.g; clear(cv); clear(fr[1]);
    if (!e || !st.spec) { text(g, st.run && !st.run.done ? 'decoding…' : 'move the playhead to a decoded frame', 12, 12, { color: '#8b93a3' }); fNote.textContent = ''; return; }
    const bx = box(cv), t0 = e.tsync - 0.06, t1 = e.tsync + FRAME + 0.06, f0 = e.f1 - 45, f1 = e.f1 + 3 * BAUD + 45;
    drawWaterfall(g, st.spec, bx, t0, t1, f0, f1, p.range);
    const X = t => bx.x + (t - t0) / (t1 - t0) * bx.w, Y = f => bx.y + bx.h - (f - f0) / (f1 - f0) * bx.h, cw = X(SYM) - X(0);
    for (let s = 0; s < 59; s++) {
      const tone = e.tones[s], x = X(e.tsync + s * SYM), y = Y(e.f1 + tone * BAUD + BAUD / 2);
      g.strokeStyle = s < 13 ? '#ff8c42' : 'rgba(78,161,255,0.9)'; g.lineWidth = 1; g.strokeRect(x + 0.5, y, Math.max(1, cw - 1), Y(e.f1 + tone * BAUD - BAUD / 2) - y);
    }
    vline(g, X(e.tsync + 13 * SYM), bx.y, bx.h, 'rgba(255,140,66,0.7)', [3, 3]);
    text(g, 'sync', X(e.tsync + 6.5 * SYM), bx.y + 2, { align: 'center', color: '#ff8c42', bg: 'rgba(0,0,0,0.5)' });
    text(g, `46 data symbols = 92 coded bits`, X(e.tsync + 36 * SYM), bx.y + 2, { align: 'center', color: '#4ea1ff', bg: 'rgba(0,0,0,0.5)', max: bx.w / 2 });
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: f0, max: f1, ticks: [0, 1, 2, 3].map(k => e.f1 + k * BAUD), fmt: v => 'tone ' + Math.round((v - e.f1) / BAUD) });
    timeAxis(g, bx, t0, t1, v => v.toFixed(1) + ' s');
    fNote.innerHTML = `Frame at <b>${e.tsync.toFixed(3)} s</b>, tone 0 at <b>${e.f1.toFixed(1)} Hz</b>, decoded as <b>${escapeHtml(e.frame)}</b>${e.eom ? ' (end of message)' : ''} on the L=${e.L} rung; ${e.nsymerrs} of its 59 hard tone decisions disagree with the re-encoded frame (the limit is 30). Boxes are the tones the transmitter sent, re-encoded from the decoded bits.`;
    drawFrameOv(true);
  }
  let lastFx = -1;
  function drawFrameOv(force = false) {
    const cv = fr[1], g = cv.g, e = curFrame; if (!e) return;
    const t = app.clock.t, bx = box(cv), t0 = e.tsync - 0.06, t1 = e.tsync + FRAME + 0.06, x = bx.x + (t - t0) / (t1 - t0) * bx.w;
    const q = Math.round(x); if (!force && q === lastFx) return; lastFx = q; clear(cv);
    if (t >= t0 && t <= t1) vline(g, x, bx.y, bx.h, '#ff5c5c');
  }
  function layout() { resizePlot(wf, fitW(wfP, 1100), isNarrow() ? 200 : 240); resizePlot(fr, fitW(fP, 1100), isNarrow() ? 190 : 210); }
  layout();
  app.clock.setDuration(dur()); app.clockFormat = t => `${t.toFixed(2)} s · window ${Math.max(0, Math.floor((t - CHUNK) / STEP))}`;
  return {
    onAudio() { app.clock.setDuration(dur()); st.spec = null; drawBg(); buildLog(); drawFrameBg(true); },
    onRun() { drawBg(); buildLog(); drawFrameBg(true); },
    tick(c, kind) { drawOv(); drawText(); drawFrameBg(); drawFrameOv(); if (['play', 'pause', 'seek', 'speed'].includes(kind)) syncAudio(app, st.audio, p.volume); },
    resize() { layout(); drawBg(); drawFrameBg(true); },
  };
}

// ======================================================================================
// view: encode
// ======================================================================================
function encodeView(S) {
  const { app, ctl, main, cap } = S, p = st.enc;
  cap.set('plays the synthesized transmission and steps through its symbols; the encoder diagram shows the shift register at the current data symbol.',
    'how few frames the packer needs, and the register: every data symbol is two parity bits of the last ten input bits, and the register starts full of the frame\'s own last nine bits so it ends where it began.');
  const setEnc = o => { Object.assign(p, o); msgIn.value = p.msg; profSel.value = String(p.profile); f0S.value = p.f0; snrS.value = p.snr > 50 ? 12 : p.snr; p.frame = 0; encode(); };
  tryThis(main, [
    { label: 'a CQ is one frame', see: '<b>CQ KA1ABC CQ</b> is 12 characters but one frame: a 28-bit callsign plus a 2-bit action (CQ, TU, AGN? ...). As five-character text it would take three.', run: () => setEnc({ msg: 'CQ KA1ABC CQ', profile: 0 }) },
    { label: 'call + exchange', see: '<b>WB9XYZ 599 101</b> is two frames: a callsign atom, then a GENERIC_NUMERIC exchange whose "599" costs one role bit. Structured atoms supply the space after themselves.', run: () => setEnc({ msg: 'WB9XYZ 599 101', profile: 0 }) },
    { label: 'plain text', see: 'Free text is TEXT5: five characters from a 64-symbol alphabet (6 bits each) per frame. 19 characters, 4 frames, 7.6 s: 2.6 characters a second against 6 for 45-baud RTTY, bought back as sensitivity (a frame decodes half the time at −17 dB; RTTY wants about −5 dB).', run: () => setEnc({ msg: 'THE QUICK BROWN FOX', profile: 0 }) },
    { label: 'RTTY Roundup', see: 'With the RTTY Roundup profile, <b>599 05</b> is rewritten as the serial <b>599 005</b> and fits one SERIAL frame. With no profile the leading zero has to survive, so it is sent as text: two frames.', run: () => setEnc({ msg: '599 05', profile: 2 }) },
    { label: 'weak: −15 dB', see: 'The same CQ at −15 dB in 2500 Hz: hard to see in the waterfall below. Press <b>receive this</b> and the signal view decodes it. One frame decodes half the time at about −17 dB.', run: () => setEnc({ msg: 'CQ KA1ABC CQ', profile: 0, snr: -15 }) },
  ]);
  const packP = panel(main, 'Packing: the fewest frames that reproduce the text'); const packStats = el('div', 'stats'); packP.append(packStats); const packTbl = el('div'); packTbl.style.overflowX = 'auto'; packP.append(packTbl);
  const encP = panel(main, 'One frame through the encoder'); const bitsDiv = el('div', 'bits'); encP.append(bitsDiv);
  const reg = layers(encP, fitW(encP, 760, 300), 180);
  const toneRow = layers(encP, fitW(encP, 1000, 300), 150); toneRow.box.style.marginTop = '8px';
  const encNote = el('div', 'note'); encP.append(encNote);
  const wP = panel(main, 'The transmission'); const strip = layers(wP, fitW(wP, 1000, 300), 110); const specL = layers(wP, fitW(wP, 1000, 300), 190); specL.box.style.marginTop = '8px';
  const spP = panel(main, 'Spectrum of the transmission'); const spC = layers(spP, fitW(spP, 1000, 300), 150); const spNote = el('div', 'note'); spP.append(spNote);

  const msgIn = textInput(ctl, { label: 'message', value: p.msg, oninput: v => { p.msg = v; p.frame = 0; encodeSoon(); } });
  const ex = el('div', 'trythis'); ex.append(el('span', 'lab', 'a contest run')); const exStrip = el('div', 'strip'); exStrip.style.flexWrap = 'wrap';
  for (const m of EXAMPLES) { const b = el('button', null, m); b.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace'; b.onclick = () => setEnc({ msg: m }); exStrip.append(b); }
  ex.append(exStrip); ctl.append(ex);
  const profSel = select(ctl, { label: 'exchange profile', options: [['0', 'unknown (no contest)'], ['1', 'ARRL Field Day'], ['2', 'ARRL RTTY Roundup']], value: String(p.profile), onchange: v => { p.profile = +v; p.frame = 0; encode(); } });
  const f0S = slider(ctl, { label: 'audio frequency (tone 0)', min: 300, max: 2600, step: 10, value: p.f0, fmt: v => v + ' Hz', oninput: v => { p.f0 = v; synthSoon(); } });
  const snrS = slider(ctl, { label: 'SNR', min: -24, max: 12, step: 1, value: p.snr > 50 ? 12 : p.snr, fmt: v => v >= 12 ? 'no noise' : v + ' dB (2500 Hz)', oninput: v => { p.snr = v >= 12 ? 99 : v; synthSoon(); } });
  slider(ctl, { label: 'volume', min: 0, max: 1, step: 0.05, value: st.sig.volume, fmt: v => Math.round(v * 100) + '%', oninput: v => { st.sig.volume = v; if (st.gain) st.gain.gain.value = v; } });
  const useB = button(ctl, 'receive this →', () => { if (!enc) return; synth(); if (!syn) return; S.noiseS.value = 0; st.rx.noiseDb = 0; S.useAudio(syn.audio, 'synthesized: ' + enc.text); S.setView('signal'); });
  useB.style.marginTop = '6px';
  ctl.append(el('div', 'note', 'That hands this transmission, with its noise, to the receiver and opens the signal view on it. "WSJT-X sample" there puts the recording back.'));

  let enc = null, syn = null;
  const encodeSoon = coalesce(() => encode()), synthSoon = debounce(() => synth(), 200);
  function encode() {
    const r = packMessage(p.msg, p.profile);
    if (r.error || !r.frames.length) { enc = null; packStats.innerHTML = `<b>${r.error ? 'cannot send: ' + r.error : 'type a message'}</b>`; packTbl.innerHTML = ''; bitsDiv.innerHTML = ''; for (const l of [reg, toneRow, strip, specL, spC]) { clear(l[0]); clear(l[1]); } return; }
    const tones = messageTones(r.frames), text5 = Math.ceil(r.text.length / 5);
    enc = { ...r, tones, codes: r.frames.map(f => tbccEncode(f)) };
    p.frame = Math.min(p.frame, r.frames.length - 1);
    packStats.innerHTML = `<b>${escapeHtml(r.text)}</b>${r.text !== p.msg.trim() ? ' (normalized)' : ''} · <b>${r.frames.length}</b> frame${r.frames.length > 1 ? 's' : ''} · ${(r.frames.length * FRAME).toFixed(2)} s on the air · ${(r.text.length / (r.frames.length * FRAME)).toFixed(1)} characters/s` + (text5 !== r.frames.length ? ` · as plain five-character text it would be ${text5} frames` : '');
    packTbl.innerHTML = `<table class="list"><tr><th>#</th><th class="msg">atom</th><th class="msg">covers</th><th class="msg">34 bits (hover a colour)</th><th>EOM</th></tr>${r.atoms.map((a, i) => {
      const bits = r.frames[i], F = payloadFields(bits); let h = '';
      for (const f of F) { h += `<span title="${f.name}${f.text ? ': ' + escapeHtml(f.text) : ''} = ${f.value}" style="color:${fieldColor(f.name)}">${Array.from(bits.slice(f.start, f.start + f.len)).join('')}</span> `; }
      return `<tr data-i="${i}"${i === p.frame ? ' class="sel"' : ''}><td>${i + 1}</td><td class="msg">${describeAtom(a)}</td><td class="msg">${escapeHtml(JSON.stringify(r.text.slice(r.spans[i][0], r.spans[i][1])))}</td><td class="msg bits" style="font-size:11px">${h}</td><td>${bits[33]}</td></tr>`;
    }).join('')}</table>`;
    packTbl.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => { p.frame = +tr.dataset.i; app.clock.pause(); app.clock.seek(0.5 + p.frame * FRAME + 13 * SYM); encodeFrame(); });
    encodeFrame(); synthSoon();
  }
  function encodeFrame() {
    if (!enc) return;
    packTbl.querySelectorAll('tr[data-i]').forEach(tr => tr.classList.toggle('sel', +tr.dataset.i === p.frame));
    const c = enc.codes[p.frame], F = payloadFields(enc.frames[p.frame]);
    let h = ''; for (const f of F) for (let i = f.start; i < f.start + f.len; i++) h += `<span data-b="${i}" style="color:${fieldColor(f.name)}" title="${f.name}">${c.info[i]}</span>`;
    h += ' '; for (let i = 34; i < 46; i++) h += `<span data-b="${i}" style="color:#c792ea" title="CRC-12">${c.info[i]}</span>`;
    bitsDiv.innerHTML = `<span class="note">frame ${p.frame + 1}: 34 payload bits + CRC-12 (purple) = 46 information bits, each shifted into the encoder in turn:</span><br>` + h;
    const F2 = F.filter(f => !['reserved', 'EOM', 'i2'].includes(f.name)).map(f => `${f.name} = ${f.text || f.value}`).join(', ');
    encNote.innerHTML = `Fields: ${escapeHtml(F2)}. Generators 1167 and 1545 (octal): each output bit is the parity of the taps on the 10-bit register. The two bits pick a tone through a Gray code (00 01 11 10 → 0 1 2 3), so neighbouring tones differ by one bit. 46 bits in, 92 bits out, 46 tones.`;
    drawToneBg(); drawStripBg(); lastSym = -2; drawOv();
  }
  function synth() {
    if (!enc) return;
    const audio = simulate(enc.tones, { f0: p.f0, dt: 0.5, snrDb: p.snr, total: Math.round((0.5 + enc.tones.length * SYM + 1) * FS) });
    const dphi = phaseIncrements(enc.tones, 384, FS, p.f0);
    syn = { audio, dphi, f0: p.f0, n: enc.tones.length, spec: spectrogramT(audio) };
    app.clock.setDuration(audio.length / FS);
    drawStripBg(); drawSpecBg(); drawSpectrum(); lastSym = -2; drawOv();
  }
  const curSym = () => Math.floor((app.clock.t - 0.5) / SYM);
  // the encoder register at data symbol k of the current frame
  function drawReg(k) {
    const cv = reg[1], g = cv.g; clear(cv); clear(reg[0]); if (!enc) return;
    const c = enc.codes[p.frame], W = cv.w, cellW = Math.min(44, (W - 40) / 12), x0 = 20, y0 = 34;
    const state = c.states[k], bit = c.info[k], t = transition(state, bit), regBits = [];
    for (let i = 0; i < 10; i++) regBits.push((t.reg >> i) & 1);   // leftmost = register bit 0, the input bit just shifted in
    text(g, k === 0 ? `data symbol 1: the register starts as the frame's last 9 bits (tail-biting), state ${state}` : `data symbol ${k + 1} of 46: input bit ${k + 1} = ${bit}, state ${state} → ${t.next}`, x0, 4, { color: '#e6e9ef', max: W - 2 * x0 });
    for (let i = 0; i < 10; i++) {
      const x = x0 + i * cellW; g.fillStyle = i === 0 ? '#33405a' : '#1c2330'; g.fillRect(x, y0, cellW - 2, 30);
      text(g, String(regBits[i]), x + cellW / 2 - 1, y0 + 8, { align: 'center', color: i === 0 ? '#ffd166' : '#e6e9ef', font: '14px ui-monospace, monospace' });
    }
    text(g, 'in', x0 + cellW / 2, y0 - 13, { align: 'center', color: '#ffd166' }); text(g, 'oldest →', x0 + 10 * cellW - 4, y0 - 13, { align: 'right', color: '#8b93a3' });
    const rows = [[G0, '#4ea1ff', 'g0 = 1167', t.b0, y0 + 62], [G1, '#ff8c42', 'g1 = 1545', t.b1, y0 + 100]];
    for (const [gen, col, name, out, y] of rows) {
      g.strokeStyle = col; g.lineWidth = 1;
      for (let i = 0; i < 10; i++) if ((gen >> i) & 1) { const x = x0 + i * cellW + cellW / 2 - 1; g.beginPath(); g.moveTo(x, y0 + 30); g.lineTo(x, y - 6); g.stroke(); g.fillStyle = col; g.fillRect(x - 2, y - 8, 4, 4); }
      hline(g, x0 + cellW / 2 - 1, 9 * cellW, y - 6, col);
      const xo = x0 + 10 * cellW + 10;
      text(g, `⊕ ${name} → ${out}`, xo, y - 13, { color: col, max: W - xo - 4 });
    }
    const xt = x0 + 10 * cellW + 10, tone = t.tone;
    text(g, `bits ${t.b0}${t.b1} → tone ${tone}`, xt, y0 + 128, { color: '#e6e9ef', font: '13px system-ui', max: W - xt - 4 });
    text(g, `${(p.f0 + tone * BAUD).toFixed(2)} Hz`, xt, y0 + 146, { color: '#8b93a3', max: W - xt - 4 });
    bitsDiv.querySelectorAll('span[data-b]').forEach(s => { const b = +s.dataset.b; s.style.background = b === k ? '#553' : (b > k - 10 && b < k ? '#223' : ''); });
  }
  function drawToneBg() {
    const cv = toneRow[0], g = cv.g; clear(cv); if (!enc) return;
    const f = p.frame, bx = { x: 46, y: 18, w: cv.w - 54, h: cv.h - 44 }, cw = bx.w / 59, ch = bx.h / 4;
    const tn = enc.tones.subarray(f * 59, f * 59 + 59), c = enc.codes[f];
    for (let s = 0; s < 59; s++) { g.fillStyle = s < 13 ? '#ff8c42' : '#4ea1ff'; g.fillRect(bx.x + s * cw + 0.5, bx.y + (3 - tn[s]) * ch + 1, Math.max(1, cw - 1), ch - 2); }
    if (cw >= 13) for (let k = 0; k < 46; k++) text(g, `${c.coded[2 * k]}${c.coded[2 * k + 1]}`, bx.x + (13 + k + 0.5) * cw, bx.y + bx.h + 3, { align: 'center', font: '8px monospace', color: '#8b93a3' });
    text(g, `frame ${f + 1} of ${enc.frames.length}: 13 sync symbols, then 46 data symbols${cw < 13 ? '' : ' (their coded bit pairs underneath)'}`, bx.x, 2, { color: '#8b93a3', max: bx.w });
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -0.5, max: 3.5, ticks: [0, 1, 2, 3], fmt: v => 'tone ' + v });
  }
  function drawStripBg() {
    const cv = strip[0], g = cv.g; clear(cv); if (!enc) return;
    const n = enc.tones.length, bx = { x: 46, y: 16, w: cv.w - 54, h: cv.h - 38 }, cw = bx.w / n, ch = bx.h / 4;
    for (let s = 0; s < n; s++) { const fi = Math.floor(s / 59); g.fillStyle = s % 59 < 13 ? '#ff8c42' : (fi === p.frame ? '#4ea1ff' : '#2e5f99'); g.fillRect(bx.x + s * cw, bx.y + (3 - enc.tones[s]) * ch + 1, Math.max(0.6, cw), ch - 2); }
    for (let f = 1; f < enc.frames.length; f++) vline(g, bx.x + f * 59 * cw, bx.y, bx.h, 'rgba(255,255,255,0.35)');
    text(g, `all ${enc.frames.length} frame${enc.frames.length > 1 ? 's' : ''}, ${n} symbols, back to back`, bx.x, 1, { color: '#8b93a3', max: bx.w });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: n * SYM, ticks: ticks(0, n * SYM, Math.min(8, tickCount(bx.w))), fmt: v => v + ' s' });
  }
  function drawSpecBg() {
    const cv = specL[0], g = cv.g; clear(cv); if (!syn) return;
    const bx = box(cv), D = syn.audio.length / FS, f0 = p.f0 - 100, f1 = p.f0 + 3 * BAUD + 100;
    drawWaterfall(g, syn.spec, bx, 0, D, f0, f1, p.snr > 50 ? 50 : 22);
    freqAxis(g, bx, f0, f1); timeAxis(g, bx, 0, D);
  }
  function drawSpectrum() {
    const cv = spC[0], g = cv.g; clear(cv); if (!syn) return;
    // power spectrum of the clean waveform (no noise), for the occupied bandwidth
    const clean = simulate(enc.tones, { f0: p.f0, dt: 0, snrDb: 99, total: enc.tones.length * 384 });
    const n = 1 << Math.ceil(Math.log2(clean.length * 2)), ps = powerSpectrum(clean, n), df = FS / n;
    const lo = p.f0 - 150, hi = p.f0 + 3 * BAUD + 150, xs = [], ys = []; let tot = 0; for (const v of ps) tot += v;
    let mx = -1e9; for (let k = Math.floor(lo / df); k < hi / df; k++) { const v = 10 * Math.log10(ps[k] + 1e-9); xs.push(k * df); ys.push(v); mx = Math.max(mx, v); }
    for (let i = 0; i < ys.length; i++) ys[i] = Math.max(ys[i], mx - 70);
    // 99% power bandwidth, centred like WSJT-X quotes it (0.5% in each tail)
    let acc = 0, a = 0, b = 0; for (let k = 0; k < ps.length; k++) { acc += ps[k]; if (!a && acc >= 0.005 * tot) a = k * df; if (acc <= 0.995 * tot) b = k * df; }
    const bx = box(cv);
    linePlot(g, { xs, ys, x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: lo, xmax: hi, ymin: mx - 70, ymax: mx + 2, color: '#4ea1ff' });
    const X = f => bx.x + (f - lo) / (hi - lo) * bx.w;
    for (let t = 0; t < 4; t++) vline(g, X(p.f0 + t * BAUD), bx.y, bx.h, 'rgba(255,140,66,0.5)', [2, 3]);
    g.save(); g.fillStyle = 'rgba(61,220,151,0.12)'; g.fillRect(X(a), bx.y, X(b) - X(a), bx.h); g.restore();
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: lo, max: hi, ticks: ticks(lo, hi, Math.min(8, tickCount(bx.w))), fmt: v => v + ' Hz' });
    spNote.innerHTML = `Dashed: the four tones, 31.25 Hz apart. Shaded: 99% of the power, <b>${(b - a).toFixed(0)} Hz</b> (WSJT-X quotes 127 Hz). The Gaussian frequency smoothing (BT = 2) is what keeps the skirts down between tone changes.`;
  }
  let lastSym = -2;
  function drawOv() {
    const s = curSym(); if (s === lastSym) return; lastSym = s;
    const inTx = enc && s >= 0 && s < enc.tones.length;
    if (inTx) { const f = Math.floor(s / 59); if (f !== p.frame) { p.frame = f; encodeFrame(); return; } }
    const k = inTx ? s % 59 : -1;
    drawReg(k >= 13 ? k - 13 : 0);
    // tone row cursor
    { const cv = toneRow[1], g = cv.g; clear(cv); if (enc && k >= 0) { const bx = { x: 46, y: 18, w: cv.w - 54, h: cv.h - 44 }, cw = bx.w / 59; g.strokeStyle = '#ff5c5c'; g.lineWidth = 1.5; g.strokeRect(bx.x + k * cw, bx.y, cw, bx.h); } }
    { const cv = strip[1], g = cv.g; clear(cv); if (enc && inTx) { const bx = { x: 46, y: 16, w: cv.w - 54, h: cv.h - 38 }; vline(g, bx.x + (s + 0.5) / enc.tones.length * bx.w, bx.y, bx.h, '#ff5c5c'); } }
    { const cv = specL[1], g = cv.g; clear(cv); if (syn) { const bx = box(cv); vline(g, bx.x + app.clock.t / (syn.audio.length / FS) * bx.w, bx.y, bx.h, '#ff5c5c'); } }
  }
  function layout() {
    resizePlot(reg, fitW(encP, 760, 300), 180); resizePlot(toneRow, fitW(encP, 1000, 300), isNarrow() ? 130 : 150);
    resizePlot(strip, fitW(wP, 1000, 300), 110); resizePlot(specL, fitW(wP, 1000, 300), isNarrow() ? 170 : 190); resizePlot(spC, fitW(spP, 1000, 300), 150);
  }
  layout();
  app.clockFormat = t => { const s = curSym(); return enc && s >= 0 && s < enc.tones.length ? `${t.toFixed(2)} s · frame ${Math.floor(s / 59) + 1} symbol ${s % 59 + 1}` : `${t.toFixed(2)} s`; };
  encode(); synth();
  return {
    tick(c, kind) { if (kind === 'tick' || kind === 'seek') { drawOv(); if (syn) { const cv = specL[1], g = cv.g; clear(cv); const bx = box(cv); vline(g, bx.x + c.t / (syn.audio.length / FS) * bx.w, bx.y, bx.h, '#ff5c5c'); } } if (['play', 'pause', 'seek', 'speed'].includes(kind)) syncAudio(app, syn && syn.audio, st.sig.volume); },
    resize() { layout(); encodeFrame(); drawSpecBg(); drawSpectrum(); },
  };
}

// ======================================================================================
// view: finding frames (the sync surface)
// ======================================================================================
function syncView(S) {
  const { app, ctl, main, cap } = S, p = st.syn;
  cap.set('scrubs through the recording one decode window (0.472 s) at a time; the surface is the sync search of the window starting at the playhead.',
    'the bright spot where the 13 sync tones line up. Picks (numbered in the order tried) must beat the local noise level by 11 times (13 in channels 1/2), then pass the gate: 7 of 13 sync tones right and a sync SNR of 2.6 dB (3.3 dB).');
  const firstK = () => { const e = frames()[0]; return e ? Math.max(0, Math.round((e.tsync - 0.1) / STEP)) : 5; };
  tryThis(main, [
    { label: 'a frame\'s window', see: 'The window whose first 0.5 s contains the start of the first frame. The peak is a few Hz wide and about 10 ms tall: the 13-symbol template only lines up in one place. It clears the floor by far, passes the gate with 13 of 13, and decodes.', run: () => { p.span = 'qso'; spanSel.value = 'qso'; bgKey = ''; app.clock.pause(); app.clock.seek(firstK() * STEP + 0.001); } },
    { label: 'an empty window', see: 'Before the signal starts: nothing clears the floor, so no pick is tried and no decoder time is spent. The floor is what keeps JTTY from printing noise: about 0.1 false frames an hour on pure noise.', run: () => { app.clock.pause(); app.clock.seek(0.001); } },
    { label: 'inside a frame', see: 'A window that starts in the middle of a frame: the frame\'s data symbols make weak, smeared sync-like peaks. The one that started before the window was already decoded and is subtracted first, so they are mostly gone.', run: () => { app.clock.pause(); app.clock.seek((firstK() + 2) * STEP + 0.001); } },
    { label: 'move my frequency away', see: 'Puts the QSO window at 2000 Hz, so the station at 1507 Hz is only in channel 2 (1500 to 1800 Hz). It still decodes there, under the stricter floor and gate: you see stations that call off your frequency.', run: () => { p.span = 'all'; spanSel.value = 'all'; S.f0S.value = 2000; S.f0S.input.dispatchEvent(new Event('input')); } },
  ]);
  const wP = panel(main, 'Where this window sits'); const wl = layers(wP, fitW(wP, 1100), 120);
  const sP = panel(main, 'Sync surface of this window: 13-symbol correlation power ÷ local noise level'); const sl = layers(sP, fitW(sP, 1100), 320); const sNote = el('div', 'note'); sP.append(sNote);
  const pP = panel(main, 'Picks tried in this window'); const pDiv = el('div', 'scroll'); pP.append(pDiv);
  const gP = panel(main, 'The gate for the selected pick: power in each of the 4 tones, for the 13 sync symbols'); const gl = layers(gP, fitW(gP, 700, 300), 170); const gNote = el('div', 'note'); gP.append(gNote);
  const spanSel = select(ctl, { label: 'surface span', options: [['qso', 'the QSO window (channel 0)'], ['all', 'all three channels, 1200 to 1800 Hz']], value: p.span, onchange: v => { p.span = v; bgKey = ''; drawBg(); } });
  checkbox(ctl, { label: 'shade cells above the candidate floor', value: p.contours, onchange: v => { p.contours = v; bgKey = ''; drawBg(); } });
  checkbox(ctl, { label: 'show held peaks (past the window edge)', value: p.held, onchange: v => { p.held = v; bgKey = ''; drawBg(); } });
  const nav = el('div'); nav.style.cssText = 'display:flex;gap:6px';
  button(nav, '◀ window', () => { app.clock.pause(); app.clock.seek(Math.max(0, (curK() - 1) * STEP + 0.001)); });
  button(nav, 'window ▶', () => { app.clock.pause(); app.clock.seek((curK() + 1) * STEP + 0.001); });
  ctl.append(nav);
  ctl.append(el('div', 'note', 'Each window is 2.36 s: a frame and a quarter. The search covers sync starts in its first 0.472 s (one step) plus 24 ms; the rest of the window is there so a frame starting then is complete. Peaks in that 24 ms margin, or just outside a channel, are "held": not tried here, since the next window or channel owns them, but they block picks on their own sidelobes.'));
  /** Plot geometry for a window's surface: which bins are on screen and where. */
  function geom(c, cv) {
    const [j0, j1] = c.bins, bx = { x: L, y: T + 14, w: cv.w - L - R, h: cv.h - T - B - 14 };
    let jlo = j0, jhi = j1;
    if (p.span === 'qso') { jlo = Math.max(j0, Math.floor((st.rx.f0 - st.rx.ftol - 30) / DF2)); jhi = Math.min(j1, Math.ceil((st.rx.f0 + st.rx.ftol + 30) / DF2)); if (jhi <= jlo) { jlo = j0; jhi = j1; } }
    const fA = (jlo - 0.5) * DF2, fB = (jhi + 0.5) * DF2, lagMax = c.ncols * 12 / 6000;
    return { bx, j0, j1, jlo, jhi, fA, fB, lagMax, X: f => bx.x + (f - fA) / (fB - fA) * bx.w, Y: lag => bx.y + lag / lagMax * bx.h };
  }
  const curK = () => { const n = st.run ? st.run.steps.length : 0; return Math.max(0, Math.min(Math.max(0, n - 1), Math.floor(app.clock.t / STEP))); };
  const call = () => st.run && st.run.steps[curK()];
  let bgKey = '';
  function drawBg() {
    const k = curK(), c = call(), key = `${k}|${!!c}|${st.run && st.run.key}|${sl.w}|${p.pick}|${p.span}`;
    drawStrip();
    if (key === bgKey) return; bgKey = key;
    const cv = sl[0], g = cv.g; clear(cv); clear(sl[1]);
    if (!c) { text(g, st.run && !st.run.done ? `decoding… (window ${k} not reached yet)` : 'no window here', 12, 12, { color: '#8b93a3' }); pDiv.innerHTML = ''; drawGate(null); return; }
    const G = geom(c, cv), { j0, j1, jlo, jhi, bx, fA, fB, lagMax, X, Y } = G, nb = j1 - j0 + 1, nc = c.ncols;
    if (c.q) heatmap(g, { data: c.q, rows: nc, cols: nb, x: bx.x, y: bx.y, w: bx.w, h: bx.h, vmin: 40, vmax: 40 + 4 * 22, cmap: 'hot', colRange: [jlo - j0, jhi - j0 + 1], nearest: p.span === 'qso' });
    if (p.contours && c.q) {
      // cells above the floor: 11x = 10.4 dB inside channel 0, 13x = 11.1 dB elsewhere
      const off = document.createElement('canvas'); off.width = nb; off.height = nc; const og = off.getContext('2d'), img = og.createImageData(nb, nc);
      const ja = Math.trunc((st.rx.f0 - st.rx.ftol) / DF2), jb = Math.trunc((st.rx.f0 + st.rx.ftol) / DF2);
      for (let i = 0; i < nc; i++) for (let j = 0; j < nb; j++) { const q = c.q[i * nb + j], jj = j + j0, fl = jj >= ja && jj <= jb ? 10 * Math.log10(11) : 10 * Math.log10(13); if (q / 4 - 10 > fl) { const o = (i * nb + j) * 4; img.data[o] = 92; img.data[o + 1] = 225; img.data[o + 2] = 230; img.data[o + 3] = 150; } }
      og.putImageData(img, 0, 0); g.save(); g.imageSmoothingEnabled = false; g.drawImage(off, jlo - j0, 0, jhi - jlo + 1, nc, bx.x, bx.y, bx.w, bx.h); g.restore();
    }
    // the searched range ends 24 ms before the bottom: below that, peaks are held for the next window
    const ys = Y((c.nstepSearch + 1) * 12 / 6000);
    g.save(); g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(bx.x, ys, bx.w, bx.y + bx.h - ys); g.restore(); hline(g, bx.x, bx.w, ys, 'rgba(255,255,255,0.5)', [4, 3]);
    // channels
    const ch = [[st.rx.f0 - st.rx.ftol, st.rx.f0 + st.rx.ftol, '#5ce1e6', 'ch 0 (QSO)'], [1200, 1500, '#c792ea', 'ch 1'], [1500, 1800, '#ffd166', 'ch 2']];
    ch.forEach(([a, b, col, name], i) => { const xa = X(Math.max(a, fA)), xb = X(Math.min(b, fB)); if (xb <= xa) return; g.save(); g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); const yy = T + 2 + i * 4; g.moveTo(xa, yy); g.lineTo(xb, yy); g.stroke(); g.restore(); vline(g, xa, bx.y, bx.h, col + '88', [2, 4]); vline(g, xb, bx.y, bx.h, col + '88', [2, 4]); if (i === 0) text(g, name, (xa + xb) / 2, bx.y + 2, { align: 'center', color: col, bg: 'rgba(0,0,0,0.6)', font: '10px system-ui' }); });
    // picks
    const picks = c.picks.filter(q => p.held || !q.held); let n = 0;
    for (const q of c.picks) {
      if (q.held && !p.held) continue; if (q.sticky) continue;
      const x = X(q.f), y = Y(q.xdt); n++;
      if (q.f < fA || q.f > fB) continue;
      g.save(); g.lineWidth = q === c.picks[p.pick] ? 2.5 : 1.5;
      if (q.held) { g.setLineDash([2, 2]); g.strokeStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.stroke(); }
      else { g.strokeStyle = RESULT_COLORS[q.result] || '#fff'; g.beginPath(); g.arc(x, y, 7, 0, 7); g.stroke(); if (q.fRef != null) { g.beginPath(); g.moveTo(x, y); g.lineTo(X(q.fRef), Y(q.xdtRef)); g.stroke(); } }
      g.restore();
      if (!q.held) text(g, String(c.picks.filter(z => !z.held && !z.sticky).indexOf(q) + 1), x + 8, y - 6, { color: RESULT_COLORS[q.result] || '#fff', font: '11px system-ui', bg: 'rgba(0,0,0,0.6)' });
    }
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: fA, max: fB, ticks: ticks(fA, fB, Math.min(8, tickCount(bx.w))), fmt: v => v + ' Hz' });
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: 0, max: lagMax, ticks: [0, 0.1, 0.2, 0.3, 0.4], fmt: v => (v * 1000).toFixed(0) + ' ms', flip: true });
    const decoded = c.picks.filter(q => q.result === 'decoded').length;
    sNote.innerHTML = `Window ${k}: <b>${c.t0.toFixed(3)} to ${c.tEnd.toFixed(3)} s</b>. ${c.picks.filter(q => !q.held && !q.sticky).length} picks tried, ${c.picks.filter(q => q.held).length} held, ${decoded} decoded` + (c.presub.length ? `; ${c.presub.length} frame${c.presub.length > 1 ? 's' : ''} decoded in earlier windows subtracted before the search` : '') + (c.retro.length ? `; retro re-sweeps of the previous 3 windows found ${c.retro.reduce((a, r) => a + r.picks.length, 0)} more` : '') + '. Colour: 0 to 22 dB over the local noise level (the median of each bin over the window, then a ±150 Hz median). Lines from a circle show where the coherent peakup moved it.';
    buildPicks(c);
  }
  function buildPicks(c) {
    const rows = c.picks.map((q, i) => ({ q, i })).filter(({ q }) => !q.held || p.held);
    if (!rows.length) { pDiv.innerHTML = '<span class="note">nothing above the floor in this window, so nothing was tried</span>'; drawGate(null); return; }
    let n = 0;
    pDiv.innerHTML = `<table class="list"><tr><th>#</th><th>ch</th><th>pass</th><th>Hz</th><th>start ms</th><th>÷ level</th><th>sync</th><th>SNR dB</th><th class="msg">result</th><th class="msg">frame</th></tr>${rows.map(({ q, i }) => {
      const label = q.held ? 'held' : q.sticky ? 'retry' : String(++n);
      return `<tr data-i="${i}"${i === p.pick ? ' class="sel"' : ''}><td>${label}</td><td>${q.ich}</td><td>${q.ipass}</td><td>${(q.fRef ?? q.f).toFixed(1)}</td><td>${((q.xdtRef ?? q.xdt) * 1000).toFixed(1)}</td><td>${q.ratio != null ? (10 * Math.log10(q.ratio)).toFixed(1) + ' dB' : ''}</td><td>${q.nsync != null ? q.nsync + '/13' : ''}</td><td>${q.snrdb != null ? q.snrdb.toFixed(1) : ''}</td><td class="msg" style="color:${RESULT_COLORS[q.result] || '#8b93a3'}">${q.held ? 'held: the next window\'s' : q.result === 'gate' ? 'failed the gate' : q.result || ''}</td><td class="msg">${escapeHtml((q.frame || '').replace(/~/g, ' '))}</td></tr>`;
    }).join('')}</table>`;
    pDiv.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => { p.pick = +tr.dataset.i; bgKey = ''; drawBg(); });
    if (p.pick < 0 || !c.picks[p.pick] || c.picks[p.pick].held) p.pick = c.picks.findIndex(q => !q.held && q.sync);
    drawGate(c.picks[p.pick]);
  }
  function drawGate(q) {
    const cv = gl[0], g = cv.g; clear(cv); clear(gl[1]);
    if (!q || !q.sync) { text(g, 'select a pick that was tried', 12, 12, { color: '#8b93a3' }); gNote.textContent = ''; return; }
    const bx = { x: 50, y: 10, w: cv.w - 58, h: cv.h - 34 }, cw = bx.w / 13, ch = bx.h / 4;
    let mx = 0; for (const s of q.sync) for (const v of s) mx = Math.max(mx, v);
    q.sync.forEach((pw, j) => { for (let t = 0; t < 4; t++) { const v = Math.sqrt(pw[t] / (mx || 1)); g.fillStyle = `rgba(78,161,255,${0.08 + 0.92 * v})`; g.fillRect(bx.x + j * cw + 1, bx.y + (3 - t) * ch + 1, cw - 2, ch - 2); }
      const want = SYNC13[j], got = pw.indexOf(Math.max(...pw)); g.strokeStyle = got === want ? '#3ddc97' : '#ff5c5c'; g.lineWidth = 2; g.strokeRect(bx.x + j * cw + 1.5, bx.y + (3 - want) * ch + 1.5, cw - 3, ch - 3); });
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -0.5, max: 3.5, ticks: [0, 1, 2, 3], fmt: v => 'tone ' + v });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0.5, max: 13.5, ticks: [1, 3, 5, 7, 9, 11, 13], fmt: v => 'sym ' + v });
    const chan = q.ich === 0 ? '7 of 13 and 2.6 dB' : '7 of 13 and 3.3 dB';
    gNote.innerHTML = `Outlined: the tone the sync sequence expects (0 2 2 3 0 0 3 2 1 3 1 2 0), green where it is also the strongest. <b>${q.nsync}/13</b> right, sync SNR <b>${q.snrdb.toFixed(1)} dB</b> (expected-tone power over the other three's average). Channel ${q.ich} needs ${chan}: <b style="color:${q.gate ? '#3ddc97' : '#ff5c5c'}">${q.gate ? 'passed' : 'failed'}</b>${q.gate ? `, then ${q.frame ? `decoded on the L=${q.L} rung as <b>${escapeHtml(q.frame.replace(/~/g, ' '))}</b>` : escapeHtml(q.result || '')}` : ''}.`;
  }
  function drawStrip() {
    const cv = wl[0], g = cv.g; if (!st.audio) return;
    if (!st.spec) st.spec = spectrogramT(st.audio);
    const bx = { x: L, y: 4, w: cv.w - L - R, h: cv.h - 24 }, D = st.audio.length / FS;
    if (drawStrip.key !== st.spec + '|' + cv.w + '|' + frames().length) {
      drawStrip.key = st.spec + '|' + cv.w + '|' + frames().length; clear(cv);
      drawWaterfall(g, st.spec, bx, 0, D, 1150, 1850, 22);
      const X = t => bx.x + t / D * bx.w, Y = f => bx.y + bx.h - (f - 1150) / 700 * bx.h;
      for (const e of frames()) { g.strokeStyle = msgColor(e.messageId); g.strokeRect(X(e.tsync), Y(e.f1 + 110), X(FRAME) - X(0), Y(e.f1 - 16) - Y(e.f1 + 110)); }
      axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: 1150, max: 1850, ticks: [1200, 1500, 1800], fmt: v => v });
      timeAxis(g, bx, 0, D);
    }
    const o = wl[1], go = o.g; clear(o);
    const k = curK(), X = t => bx.x + t / D * bx.w;
    go.save(); go.strokeStyle = '#fff'; go.setLineDash([4, 3]); go.strokeRect(X(k * STEP), bx.y + 1, X(CHUNK) - X(0), bx.h - 2); go.fillStyle = 'rgba(255,255,255,0.18)'; go.fillRect(X(k * STEP), bx.y, X(STEP + 0.024) - X(0), bx.h); go.restore();
  }
  let hover = null;
  st.viewUnsubs.push(onPlot(sl[1], {
    onmove: (x, y) => { const c = call(); if (!c || !c.q) return; const cv = sl[1], G = geom(c, cv), nb = G.j1 - G.j0 + 1, bx = G.bx;
      const jj = G.jlo + Math.floor((x - bx.x) / bx.w * (G.jhi - G.jlo + 1)), j = jj - G.j0, i = Math.floor((y - bx.y) / bx.h * c.ncols); const g = cv.g; clear(cv);
      if (jj < G.jlo || jj > G.jhi || i < 0 || i >= c.ncols) return; hover = { j, i };
      text(g, `${(jj * DF2).toFixed(1)} Hz · start ${(i * 2).toFixed(0)} ms · ${(c.q[i * nb + j] / 4 - 10).toFixed(1)} dB over the level`, cv.w - R - 4, bx.y + 2, { align: 'right', bg: 'rgba(0,0,0,0.7)', max: bx.w - 8 }); },
    onpick: (x, y) => { const c = call(); if (!c) return; const G = geom(c, sl[1]);
      let best = -1, bd = 400; c.picks.forEach((q, i) => { if (q.held || q.sticky) return; const d = (G.X(q.f) - x) ** 2 + (G.Y(q.xdt) - y) ** 2; if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { p.pick = best; bgKey = ''; drawBg(); } },
  }));
  function layout() { resizePlot(wl, fitW(wP, 1100), 120); resizePlot(sl, fitW(sP, 1100), isNarrow() ? 280 : 320); resizePlot(gl, fitW(gP, 700, 300), 170); drawStrip.key = ''; bgKey = ''; }
  layout();
  if (st.audio) app.clock.setDuration(st.audio.length / FS);
  app.clockFormat = t => `${t.toFixed(2)} s · window ${curK()}`;
  let lastK = -1;
  return {
    onAudio() { app.clock.setDuration(st.audio.length / FS); drawStrip.key = ''; bgKey = ''; drawBg(); },
    onRun() { drawStrip.key = ''; bgKey = ''; drawBg(); },
    tick(c, kind) { const k = curK(); if (k !== lastK) { lastK = k; p.pick = -1; drawBg(); } if (['play', 'pause', 'seek', 'speed'].includes(kind)) syncAudio(app, st.audio, st.sig.volume); },
    resize() { layout(); drawBg(); },
  };
}

// ======================================================================================
// view: the trellis
// ======================================================================================
function trellisView(S) {
  const { app, ctl, main, cap } = S, p = st.tre;
  cap.set('steps through the trellis of the shown rung, block by block, first wrap then second: the columns fill in as the decoder advances.',
    'the bright ridge: at every step the true state is the one whose best path scores highest. The white line is the decoded codeword\'s own path. In the first wrap every start state is equally likely, so the left edge is uncertain; the second wrap starts from the first wrap\'s scores, which is the WAVA trick for tail-biting codes.');
  tryThis(main, [
    { label: 'clean', see: 'No added noise: the first word on the <b>L=1</b> list passes the CRC. L=1 scores each symbol by its best tone\'s energy alone. The white line (the decoded word\'s path) runs along the bright ridge the whole way.', run: () => set({ noise: 0, df: 0, L: 'ladder', width: 4, seed: 1 }) },
    { label: 'noise σ 0.7', see: 'Noise at 0.7 of the signal on every correlation. All of L=1\'s words fail the CRC, so the ladder tries <b>L=2</b>, which adds pairs of symbols\' correlations before squaring: when the phase holds still, that is up to 3 dB more signal against the same noise, and it decodes.', run: () => set({ noise: 0.7, df: 0, L: 'ladder', width: 4, seed: 6 }) },
    { label: 'noise σ 0.8', see: 'A little more noise: L=1 and L=2 both fail and <b>L=4</b>, four symbols coherently, decodes. This ladder is why the receiver bothers to measure frequency to 0.05 Hz before decoding.', run: () => set({ noise: 0.8, df: 0, L: 'ladder', width: 4, seed: 2 }) },
    { label: 'noise σ 1', see: 'Too much: no rung finds a word that passes CRC-12 with the reserved bit clear, so nothing is printed. A wrong word gets through only if 13 check bits agree by chance, about 1 in 8000 per hypothesis tried.', run: () => set({ noise: 1, df: 0, L: 'ladder', width: 4, seed: 1 }) },
    { label: 'third on the list', see: 'Here the best two words on the L=1 list fail the CRC and the <b>third</b> passes. A plain Viterbi decoder keeps only the best path and would have stopped at the first.', run: () => set({ noise: 0.7, df: 0, L: 'ladder', width: 4, seed: 3 }) },
    { label: 'plain Viterbi', see: 'One survivor per state instead of four. With this noise the four-wide list decodes (second word, L=2); with one survivor the right word is pruned before the end and nothing decodes. Set the width back to 4 to compare.', run: () => set({ noise: 0.7, df: 0, L: 'ladder', width: 1, seed: 12 }) },
    { label: 'off by 3 Hz', see: 'L=4 alone, correlated 3 Hz off: the needles turn 35° per symbol, so four symbols no longer add up and the rung fails. Set the frequency error back to 0 and the same noise decodes. L=1 ignores phase and does not care.', run: () => set({ noise: 0.7, df: 3, L: '4', width: 4, seed: 8 }) },
  ]);
  const set = o => { Object.assign(p, o); p.rung = -1; noiseS.value = p.noise; dfS.value = p.df; lSel.value = p.L; wSel.value = String(p.width); wrapSel.value = String(p.wraps); recompute(); };
  const inP = panel(main, 'Soft input: the 46 data symbols correlated with each of the 4 tones'); const inL = layers(inP, fitW(inP, 1000, 300), 190); const inNote = el('div', 'note'); inP.append(inNote);
  const trP = panel(main, 'The trellis: 512 states × steps, colour = how far each state\'s best path is behind the leader'); const trL = layers(trP, fitW(trP, 1000, 300), 300); const trNote = el('div', 'note'); trP.append(trNote);
  const liP = panel(main, 'The list: up to 4 distinct tail-biting codewords per rung, best first'); const liDiv = el('div'); liDiv.style.overflowX = 'auto'; liP.append(liDiv);

  const frSel = select(ctl, { label: 'frame', options: [['', 'decoding…']], value: '', onchange: v => { p.key = v; recompute(); } });
  const noiseS = slider(ctl, { label: 'add noise σ (× signal)', min: 0, max: 1.5, step: 0.05, value: p.noise, fmt: v => v ? v.toFixed(2) : 'none', oninput: v => { p.noise = v; recomputeSoon(); } });
  const dfS = slider(ctl, { label: 'frequency error', min: -4, max: 4, step: 0.25, value: p.df, fmt: v => (v > 0 ? '+' : '') + v + ' Hz', oninput: v => { p.df = v; recomputeSoon(); } });
  const lSel = select(ctl, { label: 'coherent length', options: [['ladder', 'the ladder: L=1, then 2, then 4'], ['1', 'L=1 only'], ['2', 'L=2 only'], ['4', 'L=4 only']], value: p.L, onchange: v => { p.L = v; recompute(); } });
  const wSel = select(ctl, { label: 'survivors per state (list width)', options: [['1', '1 (plain Viterbi)'], ['2', '2'], ['3', '3'], ['4', '4 (WSJT-X)']], value: String(p.width), onchange: v => { p.width = +v; recompute(); } });
  const wrapSel = select(ctl, { label: 'wraps', options: [['1', '1'], ['2', '2 (WSJT-X)']], value: String(p.wraps), onchange: v => { p.wraps = +v; recompute(); } });
  button(ctl, 'new noise', () => { p.seed++; recompute(); });
  ctl.append(el('div', 'note', 'The encoder is a 9-bit shift register, so the decoder tracks 512 states. Tail-biting means the start state is unknown but equals the end state; the decoder goes round twice and keeps only paths that close. Each rung hands its best 4 words to the CRC in order; a word must pass CRC-12 and have the reserved bit clear, and an all-zero payload stops the walk.'));

  const recomputeSoon = debounce(() => recompute(), 120);
  let cur = null, res = null;
  function options() {
    const opts = [];
    for (const e of frames()) opts.push([`e${st.run.events.indexOf(e)}`, `${e.tsync.toFixed(2)} s · ${e.f1.toFixed(0)} Hz · ${e.frame}`]);
    if (st.run) st.run.steps.forEach((c, k) => { if (!c) return; c.picks.forEach((q, i) => { if (q.z && q.result && q.result !== 'decoded' && q.result !== 'seen before' && q.result !== 'duplicate') opts.push([`p${k}.${i}`, `window ${k} · ${q.f.toFixed(0)} Hz · failed: ${q.result}`]); }); });
    return opts;
  }
  function fillSelect() {
    const opts = options(); const s = frSel.select; const had = s.value;
    s.innerHTML = ''; for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.append(o); }
    if (!opts.length) { const o = document.createElement('option'); o.value = ''; o.textContent = st.run && !st.run.done ? 'decoding…' : 'no frames'; s.append(o); }
    if (!opts.some(o => o[0] === p.key)) p.key = opts.length ? opts[0][0] : '';
    s.value = p.key; if (s.value !== had || !res) recompute();
  }
  function source() {
    if (!p.key || !st.run) return null;
    if (p.key[0] === 'e') { const e = st.run.events[+p.key.slice(1)]; return e ? { z: e.z, f1: e.f1, xdt: e.xdt, istart: e.istart, label: e.frame, tones: e.tones } : null; }
    const [k, i] = p.key.slice(1).split('.').map(Number), c = st.run.steps[k], q = c && c.picks[i];
    return q ? { z: q.z, f1: q.fRef ?? q.f, xdt: q.xdtRef ?? q.xdt, istart: c.istart, label: 'failed pick' } : null;
  }
  function recompute() {
    const s = source(); cur = s; res = null;
    if (!s) { drawAll(); return; }
    let zr = Float64Array.from(s.z.re), zi = Float64Array.from(s.z.im);
    if (p.df && st.audio) { const z = frameCorrelations(st.audio, s.istart, s.xdt, s.f1 + p.df); zr = z.re; zi = z.im; }
    // signal amplitude: the mean of each symbol's largest correlation magnitude
    let amp = 0; for (let k = 0; k < 46; k++) { let m = 0; for (let t = 0; t < 4; t++) m = Math.max(m, Math.hypot(zr[k * 4 + t], zi[k * 4 + t])); amp += m / 46; }
    if (p.noise) { const g = gaussian(1000 + p.seed), sg = p.noise * amp / Math.SQRT2; for (let i = 0; i < 184; i++) { zr[i] += sg * g(); zi[i] += sg * g(); } }
    const lengths = p.L === 'ladder' ? [1, 2, 4] : [+p.L];
    const d = tbccDecode({ re: zr, im: zi }, { lengths, width: p.width, wraps: p.wraps, trace: true });
    res = { d, zr, zi, amp };
    p.rung = d.rungs.length - 1;   // the accepted rung, or the last one tried
    drawAll();
  }
  function drawAll() { drawInput(); drawTrellisBg(); buildList(); lastStep = -1; drawTrellisOv(); }
  function drawInput() {
    const cv = inL[0], g = cv.g; clear(cv); clear(inL[1]);
    if (!res) { text(g, st.run && !st.run.done ? 'decoding…' : 'no frame to show', 12, 12, { color: '#8b93a3' }); inNote.textContent = ''; return; }
    const { zr, zi, d } = res, bx = { x: 50, y: 8, w: cv.w - 58, h: cv.h - 58 }, cw = bx.w / 46, ch = bx.h / 4;
    let mx = 0; for (let i = 0; i < 184; i++) mx = Math.max(mx, zr[i] ** 2 + zi[i] ** 2);
    const sent = d.ok ? encodeInfo(d.info).tones : null; let errs = 0;
    for (let k = 0; k < 46; k++) {
      let best = 0; for (let t = 0; t < 4; t++) { const v = (zr[k * 4 + t] ** 2 + zi[k * 4 + t] ** 2) / (mx || 1); if (v > (zr[k * 4 + best] ** 2 + zi[k * 4 + best] ** 2) / (mx || 1)) best = t; g.fillStyle = `rgba(255,209,102,${0.05 + 0.95 * Math.sqrt(v)})`; g.fillRect(bx.x + k * cw + 0.5, bx.y + (3 - t) * ch + 0.5, cw - 1, ch - 1); }
      if (sent) { const ok = best === sent[k]; if (!ok) errs++; g.strokeStyle = ok ? '#3ddc97' : '#ff5c5c'; g.lineWidth = 1.5; g.strokeRect(bx.x + k * cw + 1, bx.y + (3 - sent[k]) * ch + 1, cw - 2, ch - 2); }
      // phase of the (decoded or strongest) tone's correlation: a needle per symbol
      const t = sent ? sent[k] : best, ph = Math.atan2(zi[k * 4 + t], zr[k * 4 + t]), cx = bx.x + (k + 0.5) * cw, cy = bx.y + bx.h + 26, r = Math.min(cw / 2 - 1, 10);
      g.strokeStyle = '#4ea1ff'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + r * Math.cos(ph), cy - r * Math.sin(ph)); g.stroke();
    }
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -0.5, max: 3.5, ticks: [0, 1, 2, 3], fmt: v => 'tone ' + v });
    text(g, 'phase', bx.x - 6, bx.y + bx.h + 20, { align: 'right', color: '#8b93a3' });
    inNote.innerHTML = `Brightness: power in each tone. ${sent ? `Outlined: the tones of the decoded word, red where the strongest tone disagrees (<b>${errs}</b> of 46; the code corrects far more than that).` : 'No codeword was accepted, so nothing is outlined.'} Needles: the phase of that tone's correlation. When they turn together, adding neighbours before squaring (L=2, L=4) gains energy; when they spin, it loses it.`;
  }
  const rung = () => res && res.d.rungs[Math.max(0, Math.min(res.d.rungs.length - 1, p.rung))];
  function drawTrellisBg() {
    const cv = trL[0], g = cv.g; clear(cv);
    const r = rung(); if (!r || !r.trace) { trNote.textContent = ''; return; }
    const tr = r.trace, ncol = tr.best.length, bx = { x: 50, y: 8, w: cv.w - 58, h: cv.h - 34 };
    // colour: gap to the column leader, in units of the mean per-symbol signal energy
    const E = res.amp * res.amp, data = new Float32Array(NSTATES * ncol);
    for (let c = 0; c < ncol; c++) { const col = tr.best[c]; let m = -Infinity; for (let s = 0; s < NSTATES; s++) m = Math.max(m, col[s]); for (let s = 0; s < NSTATES; s++) data[s * ncol + c] = Number.isFinite(col[s]) ? Math.max(-6, (col[s] - m) / E) : -6; }
    trL.data = data;
    heatmap(g, { data, rows: NSTATES, cols: ncol, x: bx.x, y: bx.y, w: bx.w, h: bx.h, vmin: -6, vmax: 0, cmap: 'hot', nearest: true });
    vline(g, bx.x + bx.w / tr.wraps, bx.y, bx.h, 'rgba(255,255,255,0.6)', [4, 3]);
    const acc = r.accepted >= 0 ? r.candidates[r.accepted] : r.candidates[0];
    if (acc) {
      const states = encodeInfo(acc.bits).states, L = tr.L;
      g.save(); g.strokeStyle = r.accepted >= 0 ? 'rgba(255,255,255,0.85)' : 'rgba(255,92,92,0.8)'; g.lineWidth = 1; g.beginPath();
      for (let c = 0; c < ncol; c++) { const b = c % tr.nblk, sIdx = Math.min(46, (b + 1) * L), x = bx.x + (c + 0.5) / ncol * bx.w, y = bx.y + (states[sIdx] + 0.5) / NSTATES * bx.h; c ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke(); g.restore();
    }
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: 0, max: 511, ticks: [0, 128, 256, 384, 511], fmt: v => v, flip: true });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: ncol, ticks: ticks(0, ncol, Math.min(8, tickCount(bx.w))), fmt: v => v });
    trNote.innerHTML = `Rung <b>L=${tr.L}</b>: ${tr.nblk} blocks of ${tr.L} bit${tr.L > 1 ? 's' : ''} per wrap × ${tr.wraps} wrap${tr.wraps > 1 ? 's' : ''} (dashed line). Each block a state keeps its ${p.width} best paths, over ${1 << tr.L} branches from each of ${1 << tr.L} predecessors. Bright = level with the leader, dark = 6 symbols' worth of energy behind. ${res.d.rungs.length > 1 ? 'Tap the rung rows in the list below to show the other rungs.' : ''}`;
  }
  let lastStep = -1;
  function drawTrellisOv() {
    const r = rung(), cv = trL[1], g = cv.g; if (!r || !r.trace) { clear(cv); return; }
    const ncol = r.trace.best.length, step = Math.min(ncol - 1, Math.floor(app.clock.t / app.clock.duration * ncol));
    if (step === lastStep) return; lastStep = step; clear(cv);
    const bx = { x: 50, y: 8, w: cv.w - 58, h: cv.h - 34 }, x1 = bx.x + (step + 1) / ncol * bx.w;
    g.fillStyle = 'rgba(11,14,19,0.82)'; g.fillRect(x1, bx.y, bx.x + bx.w - x1, bx.h);
    vline(g, x1, bx.y, bx.h, '#ff5c5c');
    text(g, `wrap ${Math.floor(step / r.trace.nblk) + 1}, block ${step % r.trace.nblk + 1}`, bx.x + bx.w - 2, bx.y + 2, { align: 'right', bg: 'rgba(0,0,0,0.7)' });
  }
  function buildList() {
    if (!res) { liDiv.innerHTML = ''; return; }
    const d = res.d;
    liDiv.innerHTML = `<div class="stats" style="margin-bottom:6px">${d.ok ? `<b style="color:#3ddc97">decoded</b> on the L=${d.L} rung, hypothesis ${d.rank}: <b>${escapeHtml(unpackFrame(d.payload).valid ? unpackFrame(d.payload).text.replace(/~/g, ' ') : '(not valid source)')}</b>` : '<b style="color:#ff5c5c">no rung produced an acceptable codeword</b>: nothing would be printed'}</div>
    <table class="list"><tr><th>rung</th><th>closed paths</th><th>#</th><th>metric</th><th>CRC</th><th>reserved</th><th class="msg">verdict</th><th class="msg">would read</th></tr>${d.rungs.map((r, ri) => r.candidates.map((c, k) => {
      const fr = c.crc ? unpackFrame(c.bits.slice(0, 34)) : null;
      return `<tr data-r="${ri}"${ri === p.rung ? ' class="sel"' : ''}><td>${k ? '' : 'L=' + r.L}</td><td>${k ? '' : r.pool}</td><td>${k + 1}</td><td>${(c.clean / (res.amp * res.amp)).toFixed(1)}</td><td style="color:${c.crc ? '#3ddc97' : '#ff5c5c'}">${c.crc ? 'pass' : 'fail'}</td><td>${c.bits[32]}</td><td class="msg" style="color:${c.verdict === 'accepted' ? '#3ddc97' : '#8b93a3'}">${c.verdict || (r.accepted >= 0 && k > r.accepted ? 'not reached' : '')}</td><td class="msg">${fr && fr.valid ? escapeHtml(fr.text.replace(/~/g, ' ')) : ''}</td></tr>`; }).join('')).join('')}</table>
    <div class="note">Metric: the word's single-frame coherent score in units of one symbol's signal energy (46 is a perfect clean frame at L=1). "Closed paths": distinct tail-biting words among the 2048 survivors.</div>`;
    liDiv.querySelectorAll('tr[data-r]').forEach(tr => tr.onclick = () => { p.rung = +tr.dataset.r; drawTrellisBg(); buildList(); lastStep = -1; drawTrellisOv(); });
  }
  function layout() { resizePlot(inL, fitW(inP, 1000, 300), 190); resizePlot(trL, fitW(trP, 1000, 300), isNarrow() ? 260 : 300); }
  layout();
  app.clock.setDuration(8); app.clockFormat = t => `${t.toFixed(2)} s · trellis step`;
  return {
    onAudio() { res = null; drawAll(); },
    onRun() { fillSelect(); },
    tick() { drawTrellisOv(); },
    resize() { layout(); drawAll(); },
  };
}

const VIEW_IMPL = { signal: signalView, encode: encodeView, sync: syncView, trellis: trellisView };
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
