// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Stage 0: the raw signal. Waterfall with adjustable resolution, decode-box overlay, waveform + audio playback.
//
// The waterfall is a background layer (heatmap, axes, decode boxes) plus a transparent overlay
// that holds only the playhead, so playing does not re-colour 300k spectrogram cells per frame.
// The noise-baseline plot depends on nothing the clock moves, so it is drawn on control changes.
import { powerSpectrum } from '../dsp/fft.js';
import { FS } from '../dsp/constants.js';
import { slider, select, checkbox, el, panel, canvas, layers, coalesce, caption, tryThis, fitW, resizePlot, onPlot, debounce, isNarrow, coarse, constrained } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, hline, vline, clear, passColor, linePlot, AXIS_FONT } from '../ui/draw.js';

function dispSpectrogram(audio, nfft, hop) {
  const rows = Math.floor((audio.length - nfft) / hop) + 1, nb = nfft / 2;
  const data = new Float32Array(rows * nb); const frame = new Float64Array(nfft);
  for (let r = 0; r < rows; r++) { for (let i = 0; i < nfft; i++) frame[i] = audio[r * hop + i]; const ps = powerSpectrum(frame, nfft); for (let b = 0; b < nb; b++) data[r * nb + b] = 10 * Math.log10(ps[b] / nfft + 1e-3); }
  return { rows, nb, data, nfft, hop, df: FS / nfft, t0: nfft / 2 / FS, dt: hop / FS };
}

const st = { params: { nfft: 3840, hop: 960, fmin: 200, fmax: 3200, dbLo: 35, dbHi: 85, boxes: 'wsjtr', cmap: 'viridis', volume: 0.5 }, spec: null, specKey: null, audioCtx: null, src: null, gain: null, live: false, unsubs: [] };

function stopAudio() { if (st.src) { try { st.src.stop(); } catch {} st.src = null; } }
function syncAudio(app) {
  // Everything here runs inside a clock subscriber, and a throw there skips every later
  // subscriber and wedges the transport. Audio is the one part of this page that can fail for
  // reasons outside it (no output device, an iOS context the user never unlocked), so it says so
  // and lets the plots keep moving.
  try {
    const c = app.clock; stopAudio();
    if (!st.live || !c.playing) return;
    if (!st.audioCtx) { st.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); st.gain = st.audioCtx.createGain(); st.gain.connect(st.audioCtx.destination); }
    if (!st.buf || st.bufAudio !== app.audio) { const buf = st.audioCtx.createBuffer(1, app.audio.length, FS); const ch = buf.getChannelData(0); for (let i = 0; i < app.audio.length; i++) ch[i] = app.audio[i] / 32768; st.buf = buf; st.bufAudio = app.audio; }
    // Not `=== 'suspended'`: WebKit parks the context in a fourth state, "interrupted", after a
    // screen lock, a phone call or an app switch, and it never leaves it on its own. Testing for
    // the state we want covers all of them. resume() rejects if the gesture has expired.
    if (st.audioCtx.state !== 'running') Promise.resolve(st.audioCtx.resume()).catch(() => {});
    st.gain.gain.value = st.params.volume;
    const s = st.audioCtx.createBufferSource(); s.buffer = st.buf; s.loop = c.loop; s.playbackRate.value = c.speed; s.connect(st.gain);
    s.start(0, Math.min(c.t, st.buf.duration - 0.01));   // an offset at or past the end throws on Safari
    st.src = s;
  } catch (e) { app.status('audio unavailable: ' + (e && e.message || e)); }
}

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); root.textContent = ''; this.mount(root, app); } }); st.unsubs.push(off); return; }  // cancelled by unmount if you navigate away first
    const p = st.params; app.clock.setDuration(app.duration); st.live = true;
    root.append(el('h1', null, '0 · The signal'));
    root.append(el('p', 'blurb', `This is the whole decoder input: ${app.duration.toFixed(1)} s of audio sampled at 12 kHz. Each FT8 transmission is 79 tones, 160 ms each, spaced 6.25 Hz — about 50 Hz wide and 12.64 s long. Colored marks show where the reference decoder eventually found signals (pass 1 = blue, 2 = green, 3 = yellow, cross-sequence A7 = purple); each is a box around the transmission, or a tick at its low edge when the view is too narrow to draw one. Press play to hear it; slow it down and the pitch drops with it, but the structure stays visible. Change the FFT size to trade frequency resolution for time resolution: the sync search uses 1920 samples zero-padded to 3840, for 3.125 Hz bins two per tone.`));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
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
    const wf = panel(main, 'Waterfall (time ↓, frequency →)'); const lay = layers(wf, fitW(wf, 1060), 520); const [cvB, cv] = lay;
    const hover = el('div', 'stats', ' '); wf.append(hover);
    const bottom = el('div', 'row'); main.append(bottom);
    const wvP = panel(bottom, 'Waveform at the playhead (320 ms)'); const wv = canvas(wvP, 620, 130);
    const spP = panel(bottom, 'Spectrum of the 160 ms frame at the playhead'); const sp = canvas(spP, 420, 130);
    const blP = panel(main, 'Noise baseline used for SNR: 83 Nuttall-windowed spectra averaged, 10th percentile in 10 segments, degree-5 polynomial fit'); const bl = canvas(blP, fitW(blP, 1060), 150);
    const ANN = 'blue: averaged spectrum · yellow: 10th-percentile points · orange: fitted baseline';
    const blNote = el('div', 'stats', ANN); blNote.hidden = true; blP.append(blNote);   // shown only when the canvas is too narrow to carry it
    blP.append(el('div', 'note', 'Reported SNR = signal power ÷ this baseline at the signal\'s frequency, referred to 2500 Hz. That is why a signal you can plainly see can still be "−15 dB": the reference bandwidth is 50× wider than the signal.'));
    const legend = el('div', 'legend'); legend.innerHTML = '<span><i style="background:#4ea1ff"></i>pass 1</span><span><i style="background:#3ddc97"></i>pass 2</span><span><i style="background:#ffd166"></i>pass 3</span><span><i style="background:#c792ea"></i>A7 / later</span>'; main.append(legend);

    /**
     * Canvas sizes for the current viewport, applied in place. Widths come from the block that
     * holds each plot (a .panel is a block, so its width does not depend on the canvas inside it);
     * heights come from the viewport, because in phone landscape it is height that runs out.
     */
    function layout() {
      const narrow = isNarrow(), vh = document.documentElement.clientHeight;
      // 440 is the floor that keeps a 12.64 s ladder tall enough to read as a ladder; below 520 px
      // of viewport (a phone on its side) even 440 is taller than the screen, so the waterfall
      // gives up height instead of pushing everything else off the page.
      const wfH = vh < 520 ? 330 : narrow ? 460 : 520;
      const bw = fitW(bottom, 4000);                       // the strip row's own width, children aside
      // 620 + 420 canvases, their two panels' padding and the gap. Below that the row wraps, and
      // each strip takes the column width instead of keeping a desktop shape it no longer has.
      // The width they fall back to is measured on the waterfall panel, which is a full-width
      // block with the same padding and border a strip panel has; the strip panels themselves are
      // flex items sized by their canvas, so measuring one of those would just report the old size.
      const twoUp = bw >= 620 + 420 + 14 + 52;
      const stripH = narrow ? 110 : 130;
      let ch = resizePlot(lay, fitW(wf, 1060), wfH);
      ch = resizePlot(wv, twoUp ? 620 : fitW(wf, 620), stripH) || ch;
      ch = resizePlot(sp, twoUp ? 420 : fitW(wf, 420), stripH) || ch;
      ch = resizePlot(bl, fitW(blP, 1060), 150) || ch;
      return ch;
    }

    // Dragging the hop slider fires an input event per pixel, and each one is a whole display
    // spectrogram (up to 5 s at 7680 points). Coalesce to one rebuild per frame, and skip it
    // entirely when the parameters have not actually changed (a remount, or a slider returning
    // to a value it already had).
    //
    // Nothing else bounds nfft x rows: 7680 points at hop 120 is 1365 rows x 3840 bins, an 18.9 MB
    // Float32Array that takes 1.4 s of arithmetic on a desktop and several seconds of frozen phone.
    // On the devices that cannot afford it, take fewer rows and say so in the hop readout.
    const MAX_CELLS = 2e6;
    const effHop = (hop, nfft) => {
      if (!constrained()) return hop;
      const nb = nfft / 2, span = app.audio.length - nfft;
      if ((Math.floor(span / hop) + 1) * nb <= MAX_CELLS) return hop;
      const maxRows = Math.max(1, Math.floor(MAX_CELLS / nb));
      return Math.max(hop, Math.ceil(span / maxRows / 120) * 120);   // stay on the slider's 120-sample grid
    };
    const specKey = () => `${app.name}|${p.nfft}|${effHop(p.hop, p.nfft)}`;
    const rebuild = () => { const k = specKey(); if (!st.spec || st.specKey !== k) { st.spec = dispSpectrogram(app.audio, p.nfft, effHop(p.hop, p.nfft)); st.specKey = k; } };
    // A coalesced frame can land after unmount(), which nulls st.spec; st.live is the module's own
    // liveness flag, so a stale frame becomes a no-op instead of a null dereference (and instead of
    // rebuilding the display spectrogram that unmount just released).
    const recompute = coalesce(() => { if (!st.live) return; rebuild(); redraw(); });
    const redrawSoon = coalesce(() => { if (!st.live) return; redraw(); });
    const fftSel = select(ctl, { label: 'FFT size (frequency resolution)', options: [[960, '960 pts · 12.5 Hz · 80 ms'], [1920, '1920 pts · 6.25 Hz · 160 ms (one symbol)'], [3840, '3840 pts · 3.125 Hz · 320 ms'], [7680, '7680 pts · 1.56 Hz · 640 ms']], value: p.nfft, onchange: v => { p.nfft = +v; p.hop = Math.max(120, p.nfft / 4); hopS.value = p.hop; recompute(); } });
    const hopS = slider(ctl, { label: 'hop (time step)', min: 120, max: 1920, step: 120, value: p.hop, fmt: v => { const e = effHop(v, p.nfft); return e > v ? `${v} → ${e} smp = ${(e / 12).toFixed(0)} ms` : `${v} smp = ${(v / 12).toFixed(0)} ms`; }, oninput: v => { p.hop = v; recompute(); } });
    const fminS = slider(ctl, { label: 'freq min', min: 0, max: 3000, step: 50, value: p.fmin, fmt: v => v + ' Hz', oninput: v => { p.fmin = v; if (p.fmax <= v + 100) p.fmax = v + 100; redrawSoon(); } });
    const fmaxS = slider(ctl, { label: 'freq max', min: 300, max: 6000, step: 50, value: p.fmax, fmt: v => v + ' Hz', oninput: v => { p.fmax = v; if (p.fmin >= v - 100) p.fmin = v - 100; redrawSoon(); } });
    const dbLoS = slider(ctl, { label: 'color floor', min: 0, max: 100, value: p.dbLo, fmt: v => v + ' dB', oninput: v => { p.dbLo = v; redrawSoon(); } });
    const dbHiS = slider(ctl, { label: 'color ceiling', min: 20, max: 140, value: p.dbHi, fmt: v => v + ' dB', oninput: v => { p.dbHi = v; redrawSoon(); } });
    const boxSel = select(ctl, { label: 'decode boxes', options: [['wsjtr', `wsjtr (${app.truth.wsjtr.length}, by pass)`], ['wsjtx', `WSJT-X (${app.truth.wsjtx.length})`], ['js', 'this JS decoder (by pass)'], ['none', 'none']], value: app.truth.wsjtr.length ? p.boxes : 'js', onchange: v => { p.boxes = v; if (v === 'js') app.ensureJsDecoder(); redraw(); } }); if (!app.truth.wsjtr.length) p.boxes = 'js';
    select(ctl, { label: 'color map', options: ['viridis', 'hot', 'blue'], value: p.cmap, onchange: v => { p.cmap = v; redraw(); } });
    slider(ctl, { label: 'volume', min: 0, max: 1, step: 0.05, value: p.volume, fmt: v => Math.round(v * 100) + '%', oninput: v => { p.volume = v; if (st.gain) st.gain.gain.value = v; } });
    ctl.append(el('div', 'note', `${coarse() ? 'Tap' : 'Click'} a decode mark to make that signal the selected candidate for stages 2 and 3.`));

    /** The plot box, recomputed per draw: every one of these moves when the canvas is resized. */
    const geom = () => {
      const L = 50, T = 8, W = cv.w - L - 12, H = cv.h - T - 34;
      return { L, T, W, H, fx: f => L + (f - p.fmin) / (p.fmax - p.fmin) * W, ty: t => T + t / app.duration * H };
    };

    /** Background: the spectrogram, its axes and the decode boxes. Redrawn on control changes only. */
    function drawBg() {
      const { L, T, W, H, fx, ty } = geom();
      const g = cvB.g; clear(cvB); const s = st.spec;
      const c0 = Math.max(0, Math.floor(p.fmin / s.df)), c1 = Math.min(s.nb, Math.ceil(p.fmax / s.df));
      const y0 = ty(s.t0), y1 = ty(s.t0 + (s.rows - 1) * s.dt);
      const x0 = fx(c0 * s.df), dw = fx(c1 * s.df) - x0;
      // heatmap() max-pools by itself once the bins are denser than the pixels, which on a phone
      // (960 bins over ~282 px) is what keeps a two-bin tone ladder from being sampled away.
      heatmap(g, { x: x0, y: y0, w: dw, h: y1 - y0, vmin: p.dbLo, vmax: p.dbHi, cmap: p.cmap, rows: s.rows, data: s.data, cols: s.nb, colRange: [c0, c1] });
      // Never more than the desktop count, so a wide screen is unchanged; tickCount is what
      // thins it on a narrow one, where "1000 Hz" is 41 px of a 282 px axis.
      axisX(g, { x: L, y: T + H, w: W, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, Math.min(8, tickCount(W))), fmt: v => v + ' Hz' });
      axisY(g, { x: L, y: T, h: H, min: 0, max: app.duration, ticks: ticks(0, app.duration, 7), fmt: v => v + ' s', flip: true });
      // A decode is 43.75 Hz wide, which over the whole band on a phone is under 4 px. Fifty-one
      // of those boxes merge into a picket fence over the very ladders the caption points at, so
      // once they are that thin only the selected one keeps its box and the rest become a tick at
      // the signal's low edge: it still says "a decode starts here" without covering it.
      const thin = fx(43.75) - fx(0) < 8;
      if (p.boxes !== 'none') for (const d of (app.truth[p.boxes] || [])) {
        if (d.freq + 44 < p.fmin || d.freq > p.fmax) continue;
        const x = fx(d.freq), w = fx(d.freq + 43.75) - x, y = ty(d.dt + 0.5), h = ty(d.dt + 0.5 + 12.64) - y;
        const sel = app.selected && app.selected.truth === d;
        g.strokeStyle = p.boxes !== 'wsjtx' ? passColor(d.pass) : '#ffffff'; g.lineWidth = sel ? 2.5 : 1;
        // Half-strength, and clipped to the plot box: a decode that starts before the window or
        // runs past its end would otherwise draw its tick straight through the axis labels.
        if (thin && !sel) { const ya = Math.max(T, y), yb = Math.min(T + H, y + h); g.globalAlpha = 0.5; vline(g, x - 2, ya, yb - ya, g.strokeStyle); g.globalAlpha = 1; }
        else g.strokeRect(x - 2, y, w + 4, h);
      }
    }
    /** Overlay: the playhead, and nothing else. */
    function drawOv() { const { L, W, ty } = geom(); const g = cv.g; clear(cv); hline(g, L, W, ty(app.clock.t), '#ff5c5c'); }
    function drawBaseline() {
      const b = st.baseline; if (!b) return;
      const g = bl.g; clear(bl); const Lx = 50, T = 8, W = bl.w - Lx - 12, H = bl.h - T - 24; const xs = [], ys = [], yb = []; let lo = 1e9, hi = -1e9;
      for (let i = b.ia; i <= b.ib; i++) { const f = i * 3.125; if (f < p.fmin || f > p.fmax) continue; xs.push(f); ys.push(b.savgDb[i]); yb.push(b.sbaseDb[i]); lo = Math.min(lo, b.sbaseDb[i], b.savgDb[i]); hi = Math.max(hi, b.savgDb[i]); }
      if (!xs.length) return; lo -= 3; hi = Math.min(hi, lo + 40);
      linePlot(g, { xs, ys, x: Lx, y: T, w: W, h: H, xmin: p.fmin, xmax: p.fmax, ymin: lo, ymax: hi, color: '#4ea1ff', width: 0.8 });
      linePlot(g, { xs, ys: yb, x: Lx, y: T, w: W, h: H, xmin: p.fmin, xmax: p.fmax, ymin: lo, ymax: hi, color: '#ff8c42', width: 1.6 });
      if (b.points) for (const q of b.points) { const f = q.bin * 3.125, v = q.db; if (f < p.fmin || f > p.fmax) continue; g.fillStyle = '#ffd166'; g.beginPath(); g.arc(Lx + (f - p.fmin) / (p.fmax - p.fmin) * W, T + H - (v - lo) / (hi - lo) * H, 1.8, 0, 7); g.fill(); }
      axisX(g, { x: Lx, y: T + H, w: W, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, Math.min(8, tickCount(W))), fmt: v => v + ' Hz' }); axisY(g, { x: Lx, y: T, h: H, min: lo, max: hi, ticks: ticks(lo, hi, 4), fmt: v => v.toFixed(0) + ' dB' });
      // 414 px of legend inside a 300 px plot paints its background bar straight across the data,
      // so on a narrow canvas the same sentence moves to a div under it, where it wraps for free.
      g.font = AXIS_FONT; const fits = g.measureText(ANN).width + 8 <= W;
      if (fits) text(g, ANN, Lx + W, T, { align: 'right', bg: 'rgba(0,0,0,0.6)' });
      blNote.hidden = fits;
    }
    /** The two strips at the playhead: one 3840-point FFT and two line plots, ~0.5 ms. */
    const SL = 20;   // left gutter: at x = 4 the first axis label is centred on the canvas edge
    function drawStrip() {
      const t = app.clock.t, g = wv.g; clear(wv); const c = Math.round(t * FS), half = 1920; const a = app.audio;
      const wvW = wv.w - SL - 8;
      const xs = [], ys = []; let m = 1; for (let i = -half; i < half; i += 2) { const v = a[c + i] || 0; xs.push(i / FS * 1000); ys.push(v); m = Math.max(m, Math.abs(v)); }
      linePlot(g, { xs, ys, x: SL, y: 4, w: wvW, h: wv.h - 24, xmin: -160, xmax: 160, ymin: -m, ymax: m, color: '#4ea1ff', width: 1 });
      vline(g, SL + wvW / 2, 4, wv.h - 24, '#ff5c5c'); axisX(g, { x: SL, y: wv.h - 20, w: wvW, min: -160, max: 160, ticks: wvW < 300 ? [-160, 0, 160] : [-160, -80, 0, 80, 160], fmt: v => v + ' ms' });
      const g2 = sp.g; clear(sp); const spW = sp.w - SL - 8; const frame = new Float64Array(1920); for (let i = 0; i < 1920; i++) frame[i] = a[c - 960 + i] || 0;
      const ps = powerSpectrum(frame, 3840); const fxs = [], fys = []; const b0 = Math.floor(p.fmin / 3.125), b1 = Math.ceil(p.fmax / 3.125);
      for (let b = b0; b < b1; b++) { fxs.push(b * 3.125); fys.push(10 * Math.log10(ps[b] / 3840 + 1e-3)); }
      linePlot(g2, { xs: fxs, ys: fys, x: SL, y: 4, w: spW, h: sp.h - 24, xmin: p.fmin, xmax: p.fmax, ymin: p.dbLo - 10, ymax: p.dbHi + 10, color: '#ffd166', width: 1 });
      axisX(g2, { x: SL, y: sp.h - 20, w: spW, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, Math.min(5, tickCount(spW))), fmt: v => v + ' Hz' });
    }
    /** Everything. Called when a control, the selection or the decode list changes. */
    function redraw() { drawBg(); drawOv(); drawBaseline(); drawStrip(); }

    // One pointer path for mouse, touch and pen: on a phone a tap fills the readout and picks,
    // which is what a mouse gets from moving and then clicking. mousemove alone left the readout
    // blank forever on touch.
    st.unsubs.push(onPlot(cv, {
      onmove: (x, y) => { const { L, T, W, H } = geom(); const f = p.fmin + (x - L) / W * (p.fmax - p.fmin), t = (y - T) / H * app.duration; hover.textContent = `${f.toFixed(0)} Hz, ${t.toFixed(2)} s into the file (DT ${(t - 0.5).toFixed(2)} s)`; },
      onpick: (x, y) => {
        const { T, H, fx } = geom(); const t = (y - T) / H * app.duration;
        // Nearest decode in PIXELS, not exact containment in Hz: the box the hit test used to
        // require is under 4 px wide on a phone, so a fingertip that misses it by a hair used to
        // jump the transport instead of selecting. 22 px is about half a fingertip; a mouse keeps
        // the old containment, which is also what leaves "click the water to seek" usable on a
        // desktop, where the decodes are only 47 Hz apart.
        const slop = coarse() ? 22 : 0;
        if (p.boxes !== 'none') {
          let best = null, bd = 1e9;
          for (const d of (app.truth[p.boxes] || [])) {
            if (t < d.dt + 0.5 || t > d.dt + 13.14) continue;
            const x0 = fx(d.freq) - 2, x1 = fx(d.freq + 43.75) + 2;
            const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
            if (dx < bd) { bd = dx; best = d; }
          }
          if (best && bd <= slop) { app.select({ freq: best.freq, dt: best.dt, score: null, truth: best, label: best.message }); drawBg(); return; }
        }
        app.clock.seek(t);
      },
    }));
    // A touch scrub emits a seek per pointer event, and every seek rebuilds the buffer source,
    // which on iOS clicks audibly. Restart once the finger has settled; play and pause stay instant.
    const restartSoon = debounce(() => syncAudio(app), 80);
    st.unsubs.push(app.clock.subscribe((c, kind) => {
      drawOv(); drawStrip();
      if (kind === 'play' || kind === 'pause') syncAudio(app);
      else if (kind === 'seek' || kind === 'speed') { stopAudio(); if (c.playing) restartSoon(); }
    }));
    st.unsubs.push(app.on(k => { if (k === 'select' || k === 'jsdecodes') drawBg(); }));
    layout(); rebuild(); redraw();
    app.getBaseline().then(b => { st.baseline = b; drawBaseline(); }).catch(e => console.warn('baseline', e));
    // A rotation can change what constrained() answers (and so the effective hop), so the readout
    // and the spectrogram are re-checked with the canvases; rebuild() is a no-op when neither moved.
    this.resize = () => { layout(); hopS.value = p.hop; rebuild(); redraw(); };
  },
  resize: null,
  // st.spec is 1.2 MB at the defaults and up to 18.9 MB at 7680 / 120; the specKey guard rebuilds
  // it on re-entry, so there is no reason to hold it while another page needs the memory.
  unmount() { st.live = false; stopAudio(); if (st.audioCtx && st.audioCtx.state === 'running') st.audioCtx.suspend(); for (const u of st.unsubs) u(); st.unsubs = []; st.spec = null; st.specKey = null; this.resize = null; },
};
