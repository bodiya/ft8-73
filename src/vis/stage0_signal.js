// Stage 0: the raw signal. Waterfall with adjustable resolution, decode-box overlay, waveform + audio playback.
//
// The waterfall is a background layer (heatmap, axes, decode boxes) plus a transparent overlay
// that holds only the playhead, so playing does not re-colour 300k spectrogram cells per frame.
// The noise-baseline plot depends on nothing the clock moves, so it is drawn on control changes.
import { powerSpectrum } from '../dsp/fft.js';
import { FS } from '../dsp/constants.js';
import { slider, select, checkbox, el, panel, canvas, layers, coalesce, caption, tryThis } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, text, hline, vline, clear, passColor, linePlot } from '../ui/draw.js';

function dispSpectrogram(audio, nfft, hop) {
  const rows = Math.floor((audio.length - nfft) / hop) + 1, nb = nfft / 2;
  const data = new Float32Array(rows * nb); const frame = new Float64Array(nfft);
  for (let r = 0; r < rows; r++) { for (let i = 0; i < nfft; i++) frame[i] = audio[r * hop + i]; const ps = powerSpectrum(frame, nfft); for (let b = 0; b < nb; b++) data[r * nb + b] = 10 * Math.log10(ps[b] / nfft + 1e-3); }
  return { rows, nb, data, nfft, hop, df: FS / nfft, t0: nfft / 2 / FS, dt: hop / FS };
}

const st = { params: { nfft: 3840, hop: 960, fmin: 200, fmax: 3200, dbLo: 35, dbHi: 85, boxes: 'wsjtr', cmap: 'viridis', volume: 0.5 }, spec: null, specKey: null, audioCtx: null, src: null, gain: null, unsubs: [] };

function stopAudio() { if (st.src) { try { st.src.stop(); } catch {} st.src = null; } }
function syncAudio(app) {
  const c = app.clock; stopAudio();
  if (!c.playing) return;
  if (!st.audioCtx) { st.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); st.gain = st.audioCtx.createGain(); st.gain.connect(st.audioCtx.destination); }
  if (!st.buf || st.bufAudio !== app.audio) { const buf = st.audioCtx.createBuffer(1, app.audio.length, FS); const ch = buf.getChannelData(0); for (let i = 0; i < app.audio.length; i++) ch[i] = app.audio[i] / 32768; st.buf = buf; st.bufAudio = app.audio; }
  if (st.audioCtx.state === 'suspended') st.audioCtx.resume();
  st.gain.gain.value = st.params.volume;
  const s = st.audioCtx.createBufferSource(); s.buffer = st.buf; s.loop = c.loop; s.playbackRate.value = c.speed; s.connect(st.gain); s.start(0, c.t); st.src = s;
}

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); root.textContent = ''; this.mount(root, app); } }); st.unsubs.push(off); return; }  // cancelled by unmount if you navigate away first
    const p = st.params; app.clock.setDuration(app.duration);
    root.append(el('h1', null, '0 · The signal'));
    root.append(el('p', 'blurb', `This is the whole decoder input: ${app.duration.toFixed(1)} s of audio sampled at 12 kHz. Each FT8 transmission is 79 tones, 160 ms each, spaced 6.25 Hz — about 50 Hz wide and 12.64 s long. Boxes show where the reference decoder eventually found signals (pass 1 = blue, 2 = green, 3 = yellow, cross-sequence A7 = purple). Press play to hear it; slow it down and the pitch drops with it, but the structure stays visible. Change the FFT size to trade frequency resolution for time resolution: the sync search uses 1920 samples zero-padded to 3840, for 3.125 Hz bins two per tone.`));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div'); row.append(main);
    const cap = caption(main); cap.set('plays the recording in real time, and the playhead is the frame the waveform and spectrum panels below are showing.', 'the vertical ladders. Each one is a single transmission: 79 tones, 160 ms each, 12.64 s from top to bottom.');
    // Every claim below follows from FS/nfft and nfft/FS, so these hold for any window, not just
    // the bundled one. The zoom lands on the strongest decode in this recording.
    // freq min/max keep a 100 Hz minimum span, so the zoom below is 100 Hz wide, not tighter.
    const setSpec = (nfft, fmin, fmax, dbLo = 35, dbHi = 85) => { p.nfft = nfft; p.hop = Math.max(120, nfft / 4); fftSel.value = nfft; hopS.value = p.hop; p.fmin = fmin; p.fmax = fmax; fminS.value = fmin; fmaxS.value = fmax; p.dbLo = dbLo; p.dbHi = dbHi; dbLoS.value = dbLo; dbHiS.value = dbHi; recompute(); };
    tryThis(main, [
      { label: 'one symbol per frame', see: 'A 1920-point frame is <b>6.25 Hz</b> per bin and <b>160 ms</b> long: exactly the tone spacing and exactly the symbol length. This is the analysis the mode is built around, and the tone ladders are as sharp as they get.',
        run: () => setSpec(1920, 200, 3200) },
      { label: 'trade time for frequency', see: 'At 7680 points the bins are <b>1.56 Hz</b>, four per tone, but every row now averages <b>640 ms</b>, which is four symbols. The ladders smear into vertical streaks. You cannot buy frequency resolution without spending time resolution.',
        run: () => setSpec(7680, 200, 3200) },
      { label: 'trade frequency for time', see: 'At 960 points each row is only <b>80 ms</b>, so symbol edges sharpen, but a <b>12.5 Hz</b> bin is wider than the 6.25 Hz tone spacing and the eight tones collapse into one band. Nothing downstream could read tones from this.',
        run: () => setSpec(960, 200, 3200) },
      { label: 'zoom to one signal', see: 'One transmission fills the view: the strongest decode in this window, at <b>737.5 Hz</b>, about <b>50 Hz</b> wide and <b>12.6 s</b> long, with the tone stepping from row to row. Raising the color floor is what makes it stand out of the band noise. The 7-tone sync pattern inside it is drawn cell by cell on <a href="#sync">stage 1</a>.',
        run: () => setSpec(1920, 700, 800, 55, 90) },
      { label: 'whole band again', see: 'Back to 3.125 Hz bins over 200 to 3200 Hz: about 50 transmissions in one 15 s slot.',
        run: () => setSpec(3840, 200, 3200) },
    ]);
    const wf = panel(main, 'Waterfall (time ↓, frequency →)'); const [cvB, cv] = layers(wf, 1060, 520);
    const hover = el('div', 'stats', ' '); wf.append(hover);
    const bottom = el('div', 'row'); main.append(bottom);
    const wvP = panel(bottom, 'Waveform at the playhead (320 ms)'); const wv = canvas(wvP, 620, 130);
    const spP = panel(bottom, 'Spectrum of the 160 ms frame at the playhead'); const sp = canvas(spP, 420, 130);
    const blP = panel(main, 'Noise baseline used for SNR: 83 Nuttall-windowed spectra averaged, 10th percentile in 10 segments, degree-5 polynomial fit'); const bl = canvas(blP, 1060, 150); blP.append(el('div', 'note', 'Reported SNR = signal power ÷ this baseline at the signal\'s frequency, referred to 2500 Hz. That is why a signal you can plainly see can still be "−15 dB": the reference bandwidth is 50× wider than the signal.'));
    const legend = el('div', 'legend'); legend.innerHTML = '<span><i style="background:#4ea1ff"></i>pass 1</span><span><i style="background:#3ddc97"></i>pass 2</span><span><i style="background:#ffd166"></i>pass 3</span><span><i style="background:#c792ea"></i>A7 / later</span>'; main.append(legend);

    // Dragging the hop slider fires an input event per pixel, and each one is a whole display
    // spectrogram (up to 5 s at 7680 points). Coalesce to one rebuild per frame, and skip it
    // entirely when the parameters have not actually changed (a remount, or a slider returning
    // to a value it already had).
    const specKey = () => `${app.name}|${p.nfft}|${p.hop}`;
    const rebuild = () => { const k = specKey(); if (!st.spec || st.specKey !== k) { st.spec = dispSpectrogram(app.audio, p.nfft, p.hop); st.specKey = k; } };
    const recompute = coalesce(() => { rebuild(); redraw(); });
    const redrawSoon = coalesce(() => redraw());
    const fftSel = select(ctl, { label: 'FFT size (frequency resolution)', options: [[960, '960 pts · 12.5 Hz · 80 ms'], [1920, '1920 pts · 6.25 Hz · 160 ms (one symbol)'], [3840, '3840 pts · 3.125 Hz · 320 ms'], [7680, '7680 pts · 1.56 Hz · 640 ms']], value: p.nfft, onchange: v => { p.nfft = +v; p.hop = Math.max(120, p.nfft / 4); hopS.value = p.hop; recompute(); } });
    const hopS = slider(ctl, { label: 'hop (time step)', min: 120, max: 1920, step: 120, value: p.hop, fmt: v => `${v} smp = ${(v / 12).toFixed(0)} ms`, oninput: v => { p.hop = v; recompute(); } });
    const fminS = slider(ctl, { label: 'freq min', min: 0, max: 3000, step: 50, value: p.fmin, fmt: v => v + ' Hz', oninput: v => { p.fmin = v; if (p.fmax <= v + 100) p.fmax = v + 100; redrawSoon(); } });
    const fmaxS = slider(ctl, { label: 'freq max', min: 300, max: 6000, step: 50, value: p.fmax, fmt: v => v + ' Hz', oninput: v => { p.fmax = v; if (p.fmin >= v - 100) p.fmin = v - 100; redrawSoon(); } });
    const dbLoS = slider(ctl, { label: 'color floor', min: 0, max: 100, value: p.dbLo, fmt: v => v + ' dB', oninput: v => { p.dbLo = v; redrawSoon(); } });
    const dbHiS = slider(ctl, { label: 'color ceiling', min: 20, max: 140, value: p.dbHi, fmt: v => v + ' dB', oninput: v => { p.dbHi = v; redrawSoon(); } });
    const boxSel = select(ctl, { label: 'decode boxes', options: [['wsjtr', `wsjtr (${app.truth.wsjtr.length}, by pass)`], ['wsjtx', `WSJT-X (${app.truth.wsjtx.length})`], ['js', 'this JS decoder (by pass)'], ['none', 'none']], value: app.truth.wsjtr.length ? p.boxes : 'js', onchange: v => { p.boxes = v; if (v === 'js') app.ensureJsDecoder(); redraw(); } }); if (!app.truth.wsjtr.length) p.boxes = 'js';
    select(ctl, { label: 'color map', options: ['viridis', 'hot', 'blue'], value: p.cmap, onchange: v => { p.cmap = v; redraw(); } });
    slider(ctl, { label: 'volume', min: 0, max: 1, step: 0.05, value: p.volume, fmt: v => Math.round(v * 100) + '%', oninput: v => { p.volume = v; if (st.gain) st.gain.gain.value = v; } });
    ctl.append(el('div', 'note', 'Click a box to make that signal the selected candidate for stages 2 and 3.'));

    const L = 50, T = 8, W = cv.w - L - 12, H = cv.h - T - 34;
    const fx = f => L + (f - p.fmin) / (p.fmax - p.fmin) * W, ty = t => T + t / app.duration * H;

    /** Background: the spectrogram, its axes and the decode boxes. Redrawn on control changes only. */
    function drawBg() {
      const g = cvB.g; clear(cvB); const s = st.spec;
      const c0 = Math.max(0, Math.floor(p.fmin / s.df)), c1 = Math.min(s.nb, Math.ceil(p.fmax / s.df));
      const y0 = ty(s.t0), y1 = ty(s.t0 + (s.rows - 1) * s.dt);
      heatmap(g, { data: s.data, rows: s.rows, cols: s.nb, x: fx(c0 * s.df), y: y0, w: fx(c1 * s.df) - fx(c0 * s.df), h: y1 - y0, vmin: p.dbLo, vmax: p.dbHi, cmap: p.cmap, colRange: [c0, c1] });
      axisX(g, { x: L, y: T + H, w: W, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, 8), fmt: v => v + ' Hz' });
      axisY(g, { x: L, y: T, h: H, min: 0, max: app.duration, ticks: ticks(0, app.duration, 7), fmt: v => v + ' s', flip: true });
      if (p.boxes !== 'none') for (const d of (app.truth[p.boxes] || [])) {
        const x = fx(d.freq), w = fx(d.freq + 43.75) - x, y = ty(d.dt + 0.5), h = ty(d.dt + 0.5 + 12.64) - y;
        if (d.freq + 44 < p.fmin || d.freq > p.fmax) continue;
        g.strokeStyle = p.boxes !== 'wsjtx' ? passColor(d.pass) : '#ffffff'; g.lineWidth = app.selected && app.selected.truth === d ? 2.5 : 1; g.strokeRect(x - 2, y, w + 4, h);
      }
    }
    /** Overlay: the playhead, and nothing else. */
    function drawOv() { const g = cv.g; clear(cv); hline(g, L, W, ty(app.clock.t), '#ff5c5c'); }
    function drawBaseline() {
      const b = st.baseline; if (!b) return;
      const g = bl.g; clear(bl); const Lx = 50, W = bl.w - Lx - 12, H = bl.h - T - 24; const xs = [], ys = [], yb = []; let lo = 1e9, hi = -1e9;
      for (let i = b.ia; i <= b.ib; i++) { const f = i * 3.125; if (f < p.fmin || f > p.fmax) continue; xs.push(f); ys.push(b.savgDb[i]); yb.push(b.sbaseDb[i]); lo = Math.min(lo, b.sbaseDb[i], b.savgDb[i]); hi = Math.max(hi, b.savgDb[i]); }
      if (!xs.length) return; lo -= 3; hi = Math.min(hi, lo + 40);
      linePlot(g, { xs, ys, x: Lx, y: T, w: W, h: H, xmin: p.fmin, xmax: p.fmax, ymin: lo, ymax: hi, color: '#4ea1ff', width: 0.8 });
      linePlot(g, { xs, ys: yb, x: Lx, y: T, w: W, h: H, xmin: p.fmin, xmax: p.fmax, ymin: lo, ymax: hi, color: '#ff8c42', width: 1.6 });
      if (b.points) for (const q of b.points) { const f = q.bin * 3.125, v = q.db; if (f < p.fmin || f > p.fmax) continue; g.fillStyle = '#ffd166'; g.beginPath(); g.arc(Lx + (f - p.fmin) / (p.fmax - p.fmin) * W, T + H - (v - lo) / (hi - lo) * H, 1.8, 0, 7); g.fill(); }
      axisX(g, { x: Lx, y: T + H, w: W, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, 8), fmt: v => v + ' Hz' }); axisY(g, { x: Lx, y: T, h: H, min: lo, max: hi, ticks: ticks(lo, hi, 4), fmt: v => v.toFixed(0) + ' dB' });
      text(g, 'blue: averaged spectrum · yellow: 10th-percentile points · orange: fitted baseline', Lx + W, T, { align: 'right', bg: 'rgba(0,0,0,0.6)' });
    }
    /** The two strips at the playhead: one 3840-point FFT and two line plots, ~0.5 ms. */
    function drawStrip() {
      const t = app.clock.t, g = wv.g; clear(wv); const c = Math.round(t * FS), half = 1920; const a = app.audio;
      const xs = [], ys = []; let m = 1; for (let i = -half; i < half; i += 2) { const v = a[c + i] || 0; xs.push(i / FS * 1000); ys.push(v); m = Math.max(m, Math.abs(v)); }
      linePlot(g, { xs, ys, x: 4, y: 4, w: wv.w - 8, h: wv.h - 24, xmin: -160, xmax: 160, ymin: -m, ymax: m, color: '#4ea1ff', width: 1 });
      vline(g, wv.w / 2, 4, wv.h - 24, '#ff5c5c'); axisX(g, { x: 4, y: wv.h - 20, w: wv.w - 8, min: -160, max: 160, ticks: [-160, -80, 0, 80, 160], fmt: v => v + ' ms' });
      const g2 = sp.g; clear(sp); const frame = new Float64Array(1920); for (let i = 0; i < 1920; i++) frame[i] = a[c - 960 + i] || 0;
      const ps = powerSpectrum(frame, 3840); const fxs = [], fys = []; const b0 = Math.floor(p.fmin / 3.125), b1 = Math.ceil(p.fmax / 3.125);
      for (let b = b0; b < b1; b++) { fxs.push(b * 3.125); fys.push(10 * Math.log10(ps[b] / 3840 + 1e-3)); }
      linePlot(g2, { xs: fxs, ys: fys, x: 4, y: 4, w: sp.w - 8, h: sp.h - 24, xmin: p.fmin, xmax: p.fmax, ymin: p.dbLo - 10, ymax: p.dbHi + 10, color: '#ffd166', width: 1 });
      axisX(g2, { x: 4, y: sp.h - 20, w: sp.w - 8, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, 5), fmt: v => v + ' Hz' });
    }
    /** Everything. Called when a control, the selection or the decode list changes. */
    function redraw() { drawBg(); drawOv(); drawBaseline(); drawStrip(); }

    cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); const f = p.fmin + (e.clientX - r.left - L) / W * (p.fmax - p.fmin), t = (e.clientY - r.top - T) / H * app.duration; hover.textContent = `${f.toFixed(0)} Hz, ${t.toFixed(2)} s into the file (DT ${(t - 0.5).toFixed(2)} s)`; });
    cv.addEventListener('click', e => {
      const r = cv.getBoundingClientRect(); const f = p.fmin + (e.clientX - r.left - L) / W * (p.fmax - p.fmin), t = (e.clientY - r.top - T) / H * app.duration;
      if (p.boxes === 'none') { app.clock.seek(t); return; }
      const d = (app.truth[p.boxes] || []).find(d => f >= d.freq - 3 && f <= d.freq + 47 && t >= d.dt + 0.5 && t <= d.dt + 13.14);
      if (d) { app.select({ freq: d.freq, dt: d.dt, score: null, truth: d, label: d.message }); drawBg(); } else app.clock.seek(t);
    });
    st.unsubs.push(app.clock.subscribe((c, kind) => { drawOv(); drawStrip(); if (['play', 'pause', 'seek', 'speed'].includes(kind)) syncAudio(app); }));
    st.unsubs.push(app.on(k => { if (k === 'select' || k === 'jsdecodes') drawBg(); }));
    rebuild(); redraw();
    app.getBaseline().then(b => { st.baseline = b; drawBaseline(); }).catch(e => console.warn('baseline', e));
  },
  unmount() { stopAudio(); if (st.audioCtx && st.audioCtx.state === 'running') st.audioCtx.suspend(); for (const u of st.unsubs) u(); st.unsubs = []; },
};
