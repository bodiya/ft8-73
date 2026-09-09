// Stage 4: subtraction and multi-pass. Two views of the same idea: wsjtr's recorded per-pass
// input audio, and this decoder's own passes computed live in a worker.
//
// The three waterfalls and the sync-spectrum plot depend only on the pass data and the zoom
// controls, so they live on background layers; the transport clock moves one playhead line per
// waterfall and nothing else.
import { loadWav } from '../dsp/wav.js';
import { spectrogram, syncSurface, syncHits, dedupeCandidates, dropToneSums } from '../dsp/sync.js';
import { slider, select, checkbox, el, panel, canvas, layers, tabbar, caption, coalesce, debounce, button, tryThis, fitW, resizePlot, coarse, constrained } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, hline, vline, clear, passColor, linePlot } from '../ui/draw.js';

// mode defaults to the recorded view: it is 633 KB of download, where "live" is a three-pass
// worker decode (19 s on a desktop, closer to a minute on a phone) that nobody asked for by
// merely navigating here. "live" stays one tap away and starts the decoder when it is chosen.
const st = { p: { fmin: 1400, fmax: 1700, dbLo: 35, dbHi: 85 }, mode: 'recorded', recorded: null, live: null, sig: null, recordedError: null, unsubs: [] };
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
// Bumped on every mount and unmount, so work that outlives the page it was started for can tell.
let mountTok = 0;
async function loadRecorded(app, tok) {
  if (st.recorded) return st.recorded;
  app.status('loading residual WAVs…');
  try {
    const [p2, p3] = await Promise.all([loadWav(app.asset('data/260726_190930_pass2.wav')), loadWav(app.asset('data/260726_190930_pass3.wav'))]);
    // Navigated away while the 633 KB was in flight: neither analyse it (0.6 s) nor put the
    // 19 MB a constrained device's unmount() has just dropped straight back.
    if (tok !== mountTok) { app.status(''); return null; }
    st.recorded = [analyze(app, app.exampleAudio, 'input to outer pass 1 (raw)'), analyze(app, p2.samples, 'input to outer pass 2'), analyze(app, p3.samples, 'input to outer pass 3')];
    app.status('');
  } catch (e) { st.recordedError = 'could not load the residual WAVs: ' + e.message; app.status(st.recordedError); }
  return st.recorded;
}

// Progress of the live run, read back off the status line (see below), plus the wall clock since
// it started. Module scope so a remount during a run keeps the elapsed time honest.
const prog = { t0: 0, pass: 0, i: 0, n: 0, found: 0, note: '', frac: 0 };
// The two shapes runJsDecoder() gives app.status(): "pass 2: 13/57 candidates, 4 decodes" while it
// searches, "pass 2: subtracting 3/9" while it subtracts.
const PROG_RE = /^JS decoder pass (\d+): (?:(\d+)\/(\d+) candidates, (\d+) decodes|(.+))$/;

export default {
  mount(root, app) {
    if (!app.ready) { root.textContent = 'loading…'; const off = app.on(k => { if (k === 'ready') { off(); root.textContent = ''; this.mount(root, app); } }); st.unsubs.push(off); return; }  // cancelled by unmount if you navigate away first
    const p = st.p; const tok = ++mountTok; app.clock.setDuration(app.duration);
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
    const main = el('div', 'stagemain'); row.append(main);
    const tabs = tabbar(main, VIEWS, st.mode, id => app.setTab(id));
    if (!hasRecorded) { const b = tabs.el.querySelector('[data-tab=recorded]'); b.disabled = true; b.title = 'only for the bundled window'; }
    const cap = caption(main);
    // The 1500 to 1600 Hz window is the clearest subtraction story in this recording: one loud pass-1
    // decode sitting on top of three quiet ones that only clear the threshold once it is gone.
    const zoom = (fmin, fmax) => { p.fmin = fmin; p.fmax = fmax; fminS.value = fmin; fmaxS.value = fmax; drawBgSoon(); };
    tryThis(main, [
      { label: 'the KY9L footprint', see: '<b>KB0PVB KY9L EM48</b> at 1551 Hz decodes on pass 1 at −6 dB. Compare the pass-1 and pass-3 waterfalls: its trace is simply gone. Three decodes inside the same 60 Hz appear only on pass 3, at 1500, 1543 and 1555 Hz, between −13 and −17 dB. They were not too weak to decode; the loud one was in the way.',
        run: () => zoom(1500, 1600) },
      { label: 'the same band, sync scores', see: 'The lower plot is the coarse-sync score for each pass input. The <b>1551 Hz</b> spike, over 10x the noise floor on pass 1, collapses into the noise once the signal behind it has been subtracted, which is what makes room for the quiet decodes on top of it.',
        run: () => zoom(1480, 1620) },
      { label: '850 to 900 Hz cluster', see: 'Five messages stacked in 70 Hz, and the passes peel them off in order of strength: 909 Hz at −4 dB on pass 2, 897 Hz at −11 dB on pass 3, then three more between −12 and −13 dB after that. Loudest first, every time.',
        run: () => zoom(800, 1000) },
      { label: 'whole band', see: 'All three pass inputs over 200 to 3200 Hz. Every box that appears in a lower row is a message that was unreadable until something louder was taken out from over it.',
        run: () => zoom(200, 3200) },
    ], () => app.name === '260726_190930' ? '' : ' <i>Numbers here were measured on the bundled window, not the one you have loaded.</i>');
    const wfP = panel(main, 'Per-pass input audio (time ↓, frequency →), boxes = decodes made on that pass');
    const spP = panel(main, 'Coarse-sync spectrum on each pass input (÷ its own noise floor)');
    const listP = panel(main, 'Decodes by pass');

    // R is the plot's right margin. 6 px in the waterfalls, 8 in the sync spectrum, as they have
    // always been; the one exception is below, where the two have to agree.
    const L = 40, T = 6, R = 6, GAP = 6, SPH = 200;
    /**
     * How the three waterfalls tile. Below three columns they STACK rather than shrink: the 344 px
     * a 390 px phone gives this panel is 110 px each three across, 64 px of which is plot, where a
     * 43.75 Hz decode box on the default 300 Hz zoom is 9 px wide under a 37 px callsign. Stacked
     * they also share one x mapping, so 1551 Hz is at the same pixel in all three, which reads
     * better for "is it gone?" than side by side does.
     * 306 = the 300 px floor below which a panel stops being a plot, plus the gutter. The height
     * ratio holds the desktop's 330 px panel at exactly the 360 px it has always been.
     */
    function sizes() {
      const avail = fitW(wfP, 3 * 330 + 2 * GAP, 300);
      const cols = Math.max(1, Math.min(3, Math.floor((avail + GAP) / 306)));
      const w = Math.floor((avail - GAP * (cols - 1)) / cols);
      // The sync spectrum is measured off the panel beside this one, so once the waterfalls stack
      // it is exactly as wide as they are; on a desktop it keeps the 1010 px it has always had.
      return { cols, w, h: Math.min(360, Math.round(w * 1.09)), sw: fitW(spP, 1010, 300) };
    }
    let cur = null;   // the layout on screen, so drawBg() knows how many columns it is drawing
    function applyLayout(s) {
      cur = s;
      cvs.forEach((l, k) => {
        resizePlot(l, s.w, s.h);
        l.box.style.display = s.cols > 1 ? 'inline-block' : 'block';
        // No right margin on the last panel of a row, or three 330 px panels no longer fit the
        // 1002 px they were measured against and the third wraps.
        l.box.style.marginRight = (s.cols > 1 && k % s.cols !== s.cols - 1) ? GAP + 'px' : '0';
        l.box.style.marginBottom = s.cols === 3 ? '0' : GAP + 'px';
      });
      resizePlot(cvS, s.sw, SPH);
    }
    const s0 = sizes();
    const cvs = [0, 1, 2].map(() => layers(wfP, s0.w, s0.h));
    const cvS = canvas(spP, s0.sw, SPH);
    // The per-pass hit/candidate counts used to be one 631 px string right-aligned inside the
    // canvas, which on a phone starts at x = -281. They are the only place those numbers appear,
    // so they move to a line under the plot where they wrap for free.
    const spStats = el('div', 'stats'); spP.append(spStats);
    const list = el('div', 'stats'); listP.append(list);
    applyLayout(s0);

    const fminS = slider(ctl, { label: 'freq min', min: 200, max: 3500, step: 10, value: p.fmin, fmt: v => v + ' Hz', oninput: v => { p.fmin = v; if (p.fmax <= v + 50) p.fmax = v + 50; drawBgSoon(); } });
    const fmaxS = slider(ctl, { label: 'freq max', min: 300, max: 4000, step: 10, value: p.fmax, fmt: v => v + ' Hz', oninput: v => { p.fmax = v; if (p.fmin >= v - 50) p.fmin = v - 50; drawBgSoon(); } });
    // Colour floor and ceiling are part of heatmap()'s cache key, so every step of a drag re-renders
    // all three waterfalls: 50-69 ms a frame on a desktop, 150-250 ms on a phone, and a cache that
    // grows to ~31 MB on the way. The readout still follows the finger; only the render waits.
    const drawBgLater = debounce(() => { drawBg(); drawOv(); }, 180);
    slider(ctl, { label: 'color floor', min: 0, max: 100, value: p.dbLo, fmt: v => v + ' dB', oninput: v => { p.dbLo = v; drawBgLater(); } });
    slider(ctl, { label: 'color ceiling', min: 20, max: 140, value: p.dbHi, fmt: v => v + ' dB', oninput: v => { p.dbHi = v; drawBgLater(); } });
    ctl.append(el('div', 'note', 'Presets: '));
    const rerun = button(ctl, 'rerun the JS decoder (3 passes)', () => { app.runJsDecoder(3, [1, 2, 3]); startedRun(); st.live = null; refresh(); }); rerun.style.marginTop = '8px';
    // A three-pass run is a minute of one core on a phone, and until now the only way to stop it
    // was to close the tab. It sits on its own line at its own width rather than beside the rerun
    // button: side by side, the two do not fit the 254 px controls column without wrapping the
    // rerun label onto a second line. Terminating is the same teardown app.js does on pagehide.
    const cancelRow = el('div'); cancelRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:4px'; ctl.append(cancelRow);
    const cancelB = button(cancelRow, 'cancel', () => {
      if (!app.worker) return;
      app.worker.terminate(); app.worker = null; app.jsPasses = 0;
      app.status('JS decoder stopped'); syncRunUI(); drawBg(); drawOv();
    });
    ctl.append(el('div', 'note', 'The JS run uses the current stage-1 sync parameters and my-call from the encode of KC1WIH for AP. Each subtraction costs ~0.4 s in JS (8 FFTs of 180 000 points), so pass 2 appears after a few seconds.'));
    ctl.append(el('div', 'note', hasRecorded ? 'wsjtr ran with -p 3 -d 1,1,3: outer passes 1 and 2 at depth 1, pass 3 at depth 3 (BP + OSD + AP). Purple entries came from A7 cross-sequence decoding after pass 3, using callsigns heard in earlier windows.' : ''));

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
          if (tok !== mountTok || st.mode !== 'live' || !st.live || (st.live[i] && st.live[i].audio === a)) return;   // page changed under the idle callback
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

    // ---- live-run progress ----
    // The worker's progress messages never reach a page: runJsDecoder() puts them straight into
    // app.status(), and app.js is off limits. So the status line is the observable. Re-reading it
    // once a second is enough to keep a pass number, a candidate count and a clock on screen,
    // which is the whole difference between "slow" and "hung" on a phone.
    function startedRun() { prog.t0 = performance.now(); prog.pass = 1; prog.i = 0; prog.n = 0; prog.found = 0; prog.note = 'starting'; prog.frac = 0; syncRunUI(); }
    function readStatus() {
      const m = PROG_RE.exec(document.getElementById('loadstatus').textContent || '');
      if (!m) return;
      if (!prog.t0) prog.t0 = performance.now();
      prog.pass = +m[1];
      if (m[2]) { prog.i = +m[2]; prog.n = +m[3]; prog.found = +m[4]; prog.note = ''; }
      else { prog.note = m[5]; }
      // Three passes; inside a pass the candidate sweep is the measurable part and the subtraction
      // round that follows it is the tail, so call the tail nine tenths done rather than guess.
      const within = prog.note ? 0.9 : (prog.n ? prog.i / prog.n : 0);
      prog.frac = Math.max(0, Math.min(1, (prog.pass - 1 + within) / 3));
    }
    function syncRunUI() { cancelB.disabled = !app.worker; }
    /** Repaint only the panels that are still waiting. No heatmap touches this path. */
    function tickProgress() {
      syncRunUI();
      if (st.mode !== 'live') return;
      readStatus();
      const passes = passesData();
      let any = false;
      cvs.forEach((l, k) => { if (!(passes && passes[k])) { placeholder(l, k); any = true; } });
      if (!any && !app.worker) prog.t0 = 0;
    }
    st.unsubs.push((id => () => clearInterval(id))(setInterval(tickProgress, 1000)));

    /** What a waterfall shows before its pass exists: the wait, made legible. */
    function placeholder(l, k) {
      const cv = l[0], g = cv.g; clear(cv); clear(l[1]);
      const wide = cv.w - 20;
      if (st.mode !== 'live') { text(g, st.recordedError || 'loading…', 10, 10, { color: '#8b93a3', max: wide }); return; }
      text(g, `input to pass ${k + 1}: not computed yet`, 10, 10, { color: '#8b93a3', max: wide });
      if (!app.worker) { text(g, app.workerError ? 'decoder error: ' + app.workerError : `${coarse() ? 'tap' : 'press'} "rerun the JS decoder" to start`, 10, 28, { color: '#8b93a3', max: wide }); return; }
      const secs = prog.t0 ? Math.round((performance.now() - prog.t0) / 1000) : 0;
      const what = prog.note || `${prog.i}/${prog.n} candidates, ${prog.found} decodes`;
      text(g, `pass ${prog.pass || 1} of 3 · ${what}`, 10, 28, { color: '#8b93a3', max: wide });
      text(g, `${secs} s elapsed`, 10, 46, { color: '#8b93a3', max: wide });
      text(g, 'a 3-pass run is ~20 s on a laptop, longer on a phone', 10, 64, { color: '#8b93a3', max: wide });
      const bw = Math.min(wide, 260), by = 86;
      g.save(); g.strokeStyle = '#2a3242'; g.strokeRect(10.5, by + 0.5, bw, 8);
      g.fillStyle = passColor(prog.pass || 1); g.fillRect(11, by + 1, Math.max(0, prog.frac * (bw - 1)), 7); g.restore();
    }

    /** Backgrounds: three waterfalls, the sync spectra, and the decode list. */
    function drawBg() {
      const passes = passesData(); const have = !!(passes && passes.length);
      const decs = decodesList();
      cvs.forEach((l, k) => {
        const ps = have ? passes[k] : null;
        const cv = l[0], g = cv.g;
        if (!ps) { placeholder(l, k); return; }
        clear(cv);
        const s = ps.spec; const W = cv.w - L - R, H = cv.h - T - 40;
        const c0 = Math.max(0, Math.floor(p.fmin / s.df)), c1 = Math.min(s.nbins, Math.ceil(p.fmax / s.df));
        const fx = f => L + (f - p.fmin) / (p.fmax - p.fmin) * W, ty = t => T + t / app.duration * H;
        const y0 = ty(0.08), y1 = ty(0.08 + (s.rows - 1) * 0.04);
        heatmap(g, { data: s.data, rows: s.rows, cols: s.nbins, x: fx(c0 * s.df), y: y0, w: fx(c1 * s.df) - fx(c0 * s.df), h: y1 - y0, vmin: p.dbLo - 10 * Math.log10(3840 / 300), vmax: p.dbHi - 10 * Math.log10(3840 / 300), cmap: 'viridis', log: true, colRange: [c0, c1] });
        const placed = [];   // label boxes already on this panel: 1543 and 1555 Hz are 12 Hz apart
        // A7 and other post-pass-3 decodes (pass > 3) are drawn on the pass-3 panel: that is the
        // audio they came out of, and the blurb promises them.
        for (const d of decs) {
          const pi = Math.min(d.pass, 3) - 1;
          if (pi !== k || d.freq + 44 < p.fmin || d.freq > p.fmax) continue;
          const x = fx(d.freq), bw = fx(d.freq + 43.75) - x, y = ty(d.dt + 0.5), bh = ty(d.dt + 0.5 + 12.64) - y;
          g.strokeStyle = passColor(d.pass); g.lineWidth = 1.5; g.strokeRect(x - 2, y, bw + 4, bh);
          // The callsign used to sit at y+bh+3, which is on top of the frequency axis, and zoomed
          // out to the whole band it is a 37 px label on an 8 px box: twenty of them on top of
          // each other. Inside the box, and only when the box is wider than the name.
          const name = d.message.split(' ')[1] || d.message;
          g.save(); g.font = '10px system-ui'; const nw = g.measureText(name).width; g.restore();
          if (bw + 4 < nw + 4) continue;
          // Two decodes 12 Hz apart put their names on top of each other, so a name that would
          // land on one already drawn steps up a row instead. Four rows is the whole cluster.
          const lx0 = x + bw / 2 - nw / 2 - 3, lx1 = lx0 + nw + 6;
          let ly = Math.min(y + bh, T + H) - 13;
          for (let n = 0; n < 4 && placed.some(q => Math.abs(q.y - ly) < 12 && lx0 < q.x1 && lx1 > q.x0); n++) ly -= 14;
          placed.push({ x0: lx0, x1: lx1, y: ly });
          text(g, name, x + bw / 2, Math.max(T + 2, ly), { color: passColor(d.pass), font: '10px system-ui', align: 'center', bg: 'rgba(0,0,0,0.6)' });
        }
        axisX(g, { x: L, y: T + H, w: W, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, Math.min(4, tickCount(W))), fmt: v => v }); axisY(g, { x: L, y: T, h: H, min: 0, max: app.duration, ticks: [0, 3, 6, 9, 12], fmt: v => v + 's', flip: true });
        text(g, ps.label, L + W / 2, T + H + 22, { align: 'center', color: '#e6e9ef', max: W });
      });
      if (!have) { clear(cvS); spStats.textContent = ''; list.innerHTML = ''; return; }
      // Stacked, the spectrum is the same width as the waterfalls and takes their right margin
      // too, so its curve lines up column-for-column with the panels above it: the 1551 Hz spike
      // is at the same x as the KY9L trace. Side by side that cannot hold, so it keeps its own.
      const g = cvS.g; clear(cvS); const RS = cur && cur.cols === 1 ? R : 8;
      const W = cvS.w - L - RS, H = cvS.h - T - 26; const ymax = 12;
      passes.forEach((ps, k) => { const s = ps.surf, xs = [], ys = []; for (let i = 0; i < s.nb; i++) if (s.freqs[i] >= p.fmin && s.freqs[i] <= p.fmax) { xs.push(s.freqs[i]); ys.push(Math.min(ps.hits.red[i], ymax)); } linePlot(g, { xs, ys, x: L, y: T, w: W, h: H, xmin: p.fmin, xmax: p.fmax, ymin: 0, ymax, color: passColor(k + 1), width: 1.2 }); });
      hline(g, L, W, T + H - app.syncParams.syncMin / ymax * H, '#ff8c42', [5, 3]);
      axisX(g, { x: L, y: T + H, w: W, min: p.fmin, max: p.fmax, ticks: ticks(p.fmin, p.fmax, Math.min(8, tickCount(W))), fmt: v => v + ' Hz' }); axisY(g, { x: L, y: T, h: H, min: 0, max: ymax, ticks: [0, 4, 8, 12], fmt: v => v });
      spStats.innerHTML = passes.map((ps, k) => `<b style="color:${passColor(k + 1)}">pass ${k + 1} input</b>: ${ps.hits.hits.length} hits, ${ps.candidates.length} candidates`).join(' · ');
      const byPass = {}; for (const d of decs) (byPass[d.pass] = byPass[d.pass] || []).push(d);
      list.innerHTML = (Object.keys(byPass).sort().map(k => `<div><b style="color:${passColor(+k)}">${+k <= 3 ? 'pass ' + k : 'A7 / after pass 3'}</b> (${byPass[k].length}): <span style="font-family:monospace">${byPass[k].sort((a, b) => a.freq - b.freq).map(d => `${d.freq} ${d.message} (${d.snr}${d.how ? ', ' + d.how : ''})`).join(' · ')}</span></div>`).join('')) || '<span class="note">no decodes yet</span>';
      if (st.mode === 'live' && app.truth.wsjtr.length) { const ref = new Set(app.truth.wsjtr.map(d => d.message)); const got = decs.filter(d => ref.has(d.message)).length; const extra = decs.filter(d => !ref.has(d.message)); list.append(el('div', 'note', `JS decoder: ${decs.length} messages, ${got} of them in wsjtr's list of ${app.truth.wsjtr.length}${extra.length ? '; not in wsjtr\'s list: ' + extra.map(d => d.message).join(', ') : ''}.`)); }
    }
    /** Overlay: one playhead per waterfall, on the panels that have audio behind them. */
    function drawOv() {
      const passes = passesData(), t = app.clock.t;
      cvs.forEach((l, k) => { const cv = l[1], g = cv.g; clear(cv); if (!(passes && passes[k])) return; const W = cv.w - L - R, H = cv.h - T - 40; hline(g, L, W, T + t / app.duration * H, '#ff5c5c'); });
    }
    const drawBgSoon = coalesce(() => { drawBg(); drawOv(); });
    function refresh() { cap.set(...CAPTIONS[st.mode]); syncRunUI(); if (st.mode === 'recorded') loadRecorded(app, tok).then(() => { if (tok === mountTok) { drawBg(); drawOv(); } }); else { ensureAnalyses(); drawBg(); drawOv(); } }
    st.unsubs.push(app.clock.subscribe(() => drawOv()));
    st.unsubs.push(app.on(k => {
      if (k === 'sync') { invalidate(app); refresh(); }
      if (k === 'jspass' || k === 'jsdecodes') { if (st.mode === 'live') { ensureAnalyses(); drawBgSoon(); } }
    }));
    if (st.mode === 'live') { if (!app.worker) startedRun(); app.ensureJsDecoder(); }
    refresh();
    this.setTab = (id) => { if (!id || !VIEWS.some(v => v[0] === id) || (id === 'recorded' && !hasRecorded)) { app.canonicalTab(st.mode); return; } if (id === st.mode) return; st.mode = id; tabs.set(id); if (id === 'live') { if (!app.worker) startedRun(); app.ensureJsDecoder(); } refresh(); };
    this.resize = () => { applyLayout(sizes()); drawBg(); drawOv(); };
  },
  setTab: null,
  resize: null,
  // Each analyze() result is a 2.45 MB spectrogram, a 0.58 MB surface and 0.65 MB of audio, so
  // holding both tabs' worth is ~19 MB kept for the rest of the session on a page nobody is on.
  // Each analyse() result is a 2.45 MB spectrogram plus a 0.58 MB surface plus its audio, so both
  // tabs together retain ~19 MB for the rest of the session. A phone needs that back; a desktop
  // would rather keep it and re-enter instantly, so only a constrained device pays the recompute.
  unmount() { mountTok++; for (const u of st.unsubs) u(); st.unsubs = []; if (constrained()) { st.recorded = null; st.live = null; } this.setTab = null; this.resize = null; },
};
