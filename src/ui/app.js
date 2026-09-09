// App shell: loads the example window, runs the shared front-end DSP once, hosts stages, owns the transport clock.
import { loadWav } from '../dsp/wav.js';
import { spectrogram, syncSurface, syncHits, dedupeCandidates } from '../dsp/sync.js';
import { DecodeContext } from '../dsp/pipeline.js';
import { Clock } from './clock.js';
import { clearHeatmapCache, setHeatmapBudget } from './draw.js';
import { dpr, constrained } from './controls.js';
import { FS } from '../dsp/constants.js';

// Every runtime URL is resolved against this module, not against the document, so the app works
// unchanged at a domain root, in a project subpath (https://user.github.io/ft8-73/), and
// with or without a trailing slash on the directory.
const asset = (p) => new URL('../../' + p, import.meta.url).href;

const STAGES = [
  { id: 'home', title: 'Overview', load: () => import('../vis/home.js') },
  { id: 'signal', title: '0 · Signal', load: () => import('../vis/stage0_signal.js') },
  { id: 'sync', title: '1 · Coarse sync', load: () => import('../vis/stage1_sync.js') },
  { id: 'candidate', title: '2 · Candidate', load: () => import('../vis/stage2_candidate.js') },
  { id: 'ldpc', title: '3 · LDPC', load: () => import('../vis/stage3_ldpc.js') },
  { id: 'passes', title: '4 · Subtraction', load: () => import('../vis/stage4_passes.js') },
  { id: 'encode', title: 'E · Encode', load: () => import('../vis/stage5_encode.js') },
];

/**
 * requestIdleCallback with a timeout fallback (Safari has been slow to ship it, so a phone is
 * exactly where the fallback runs). Honour the timeout there instead of using a flat 60 ms:
 * warm() asks for 800 ms and getBaseline() for 3000 ms specifically so their work lands after
 * first paint rather than on top of the ~570 ms of DSP setAudio() has just done.
 */
const idle = (fn, timeout = 1500) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, Math.min(timeout, 300)));
/** localStorage is unavailable or throws in some privacy modes; never let that break a page. */
const store = {
  get(k) { try { return localStorage.getItem('ft8fd:' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ft8fd:' + k, v); } catch { } },
};

// 32 MB of cached offscreen renders is a desktop budget. On a phone that competes with the DSP
// state for a per-tab allowance iOS enforces by blanking canvases, and with responsive plot sizes
// the renders are ~3x smaller anyway, so the smaller ceiling costs almost no hit rate.
if (constrained()) setHeatmapBudget(8, 2e6);

export const app = {
  clock: new Clock(),
  audio: null, rate: FS, duration: 13.5,
  truth: null,          // ground-truth decode lists (wsjtr + WSJT-X)
  spec: null, surf: null, // sync spectrogram + surface (fixed 200..4007 Hz)
  syncParams: { basePct: 0.40, syncMin: 1.2, mlag: 13, maxCandidates: 200, dtTol: 0.04, freqTol: 4, useRed2: true, freqMin: 200, freqMax: 4007 },
  hits: null, candidates: null, dropped: null,
  ctx: null,            // DecodeContext (192k FFT) lazily created
  selected: null,       // selected candidate {freq, dt, score, ...}
  listeners: new Set(), _jobId: 0, worker: null, name: '260726_190930', jsPassInputs: [], mycallBits: null,
  page: 'home', tab: null,   // current route: #<page> or #<page>/<tab>
  clockFormat: null,         // pages set this: the clock means something different on each
  asset, idle,
  status(msg) { document.getElementById('loadstatus').textContent = msg; },
  emit(kind) { for (const fn of this.listeners) fn(kind); },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  recomputeSync() {
    const p = this.syncParams;
    // Keyed on the spectrogram itself, not just the frequency range: setAudio() builds a new spec
    // for every window, and keying only on the range once let a new window reuse the old surface.
    if (!this.surf || this.surf._spec !== this.spec || this.surf._fmin !== p.freqMin || this.surf._fmax !== p.freqMax) { this.surf = syncSurface(this.spec, p.freqMin, p.freqMax); this.surf._spec = this.spec; this.surf._fmin = p.freqMin; this.surf._fmax = p.freqMax; }
    this.hits = syncHits(this.surf, p);
    const d = dedupeCandidates(this.hits.hits, p); this.candidates = d.kept; this.dropped = d.dropped;
    this.emit('sync');
  },
  /** Spectrum baseline (noise floor fit) for SNR, cached per audio. */
  async getBaseline() { if (!this._baseline || this._baselineAudio !== this.audio) { const m = await import('../dsp/baseline.js'); this._baseline = m.spectrumBaseline(this.audio, this.syncParams.freqMin, this.syncParams.freqMax); this._baseline.mod = m; this._baselineAudio = this.audio; } return this._baseline; },
  getCtx() { if (!this.ctx) { const quiet = this._warming; if (!quiet) this.status('building 192k-point FFT…'); this.ctx = new DecodeContext(this.audio); if (!quiet) this.status(''); } return this.ctx; },
  select(c) { this.selected = c; this.emit('select'); },
  /** Replace the audio (Float32Array @ 12 kHz) and recompute everything. */
  setAudio(samples, name, truth) {
    // Stop any decode still running on the previous window: its handler would happily write its
    // decodes and pass audio into the new window's state.
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this._jobId++;
    clearHeatmapCache();   // every cached render refers to the old window's arrays
    this.audio = samples.length > 180000 ? samples.slice(0, 180000) : samples; this.duration = this.audio.length / FS; this.name = name;
    this.truth = truth || { window: name, band: '', wsjtr: [], wsjtx: [], js: [] };
    this.ctx = null; this.selected = null; this.trace = null; this._baseline = null;
    // Order matters: clock.pause() and clock.setDuration() both emit to every page's clock
    // subscriber, and those read app.spec and app.surf. Pause first, while the old window is still
    // consistent, then replace spec and surf rather than nulling them, and only then move the clock.
    this.clock.pause();
    this.spec = spectrogram(this.audio); this.recomputeSync();
    this.clock.setDuration(this.duration);
    this.emit('audio');
    // With a reference decode list in hand the JS run is only needed for stage 4 and the "this JS
    // decoder" overlays, so it waits for an idle moment instead of competing with first paint.
    // Without one it is the only reference there is, so it starts now.
    // A full 3-pass decode is ~19 s of one core on a desktop and closer to a minute on a phone,
    // most of it in subtraction. Without a reference list it is the only decode list there is, so
    // a constrained device still gets one, just the single-pass depth-3 version; stage 4 asks for
    // all three passes itself when you open the view that teaches them.
    if (this.truth.wsjtr && this.truth.wsjtr.length) this.warm();
    else if (constrained()) { this.warm(); this.runJsDecoder(1, [3]); }
    else this.runJsDecoder();
  },
  /**
   * Precompute the expensive shared objects while the browser is idle, so no page pays for them.
   * Deliberately does NOT start the JS decoder: that is ~15 s of CPU nobody asked for, and with a
   * reference decode list in hand only stage 4 and the "this JS decoder" overlay need it. Both
   * call ensureJsDecoder().
   */
  warm() {
    if (this._warmScheduled) return; this._warmScheduled = true;
    idle(() => {
      this._warmScheduled = false; this._warming = true;
      try { this.getCtx(); } catch (e) { console.warn('warm ctx', e); }
      this._warming = false;
      idle(() => this.getBaseline().catch(() => { }), 3000);
    }, 800);
  },
  /**
   * Start the background JS decode unless a run that deep has already happened or is running.
   * `jsPasses` matters because a constrained device gets the cheap single-pass schedule on load
   * (see setAudio): stage 4, which is about subtraction, still has to be able to ask for all three.
   */
  jsPasses: 0,
  ensureJsDecoder(passes = 3, depths = [1, 2, 3]) {
    // A deeper request pre-empts a shallower run: a constrained device starts one pass on load, and
    // stage 4's live view then asks for three. Bailing on any live worker would leave that view
    // waiting forever for passes it had already been told were coming.
    if (this.worker && this.jsPasses >= passes) return;
    if (this.truth && this.truth.js && this.truth.js.length && this.jsPasses >= passes) return;
    this.runJsDecoder(passes, depths);
  },
  /** Run the JS decoder (multi-pass when subtraction is available) in a worker; fills truth.js. */
  runJsDecoder(passes = 3, depths = [1, 2, 3]) {
    if (this.worker) this.worker.terminate();
    this.workerError = null; this.jsPassInputs = []; this.truth.js = []; this.jsPasses = passes;
    const w = this.worker = new Worker(new URL('../dsp/worker.js', import.meta.url), { type: 'module' });
    const id = ++this._jobId; const label = this.name || 'window';
    w.onmessage = ev => { const m = ev.data; if (m.id !== id) return;
      if (m.type === 'progress') this.status(m.note ? `JS decoder pass ${m.pass}: ${m.note}` : `JS decoder pass ${m.pass}: ${m.i}/${m.n} candidates, ${m.found} decodes`);
      if (m.type === 'passInput') { this.jsPassInputs[m.pass - 1] = m.audio; this.emit('jspass'); }
      if (m.type === 'pass' || m.type === 'done') { this.truth.js = m.decodes; this.emit('jsdecodes'); }
      if (m.type === 'done') { this.status(`${label}: JS decoder found ${m.decodes.length} messages`); w.terminate(); if (this.worker === w) this.worker = null; } };
    w.onerror = e => { this.workerError = e.message || 'worker failed to start'; this.status('JS decoder error: ' + this.workerError); if (this.worker === w) this.worker = null; this.emit('jsdecodes'); };
    w.postMessage({ id, audio: this.audio, params: { ...this.syncParams, mycallBits: this.mycallBits || null }, passes, depths });
  },
  /** Reference decode list: wsjtr's when we have it for this audio, else the JS decoder's own. */
  ref() { if (!this.truth) return []; return this.truth.wsjtr.length ? this.truth.wsjtr : (this.truth.js || []); },
  /** Nearest reference decode (within 6 Hz and 0.25 s) for a candidate. */
  truthFor(c) { if (!this.truth) return null; let best = null, bd = 1e9; for (const d of this.ref()) { const df = Math.abs(d.freq - c.freq), ddt = Math.abs(d.dt - c.dt); if (df <= 6 && ddt <= 0.25 && df + 10 * ddt < bd) { bd = df + 10 * ddt; best = d; } } return best; },
  /**
   * Switch the current page's view. The view id lives in the hash (#ldpc/heat) so a link lands on
   * the exact view, and the last view per page is remembered for when the hash names none.
   */
  setTab(id) { this.canonicalTab(id); if (current && current.setTab) current.setTab(this.tab); },
  /**
   * Make the hash name the view that is actually on screen. Called both when a tab is picked and
   * when a page resolves an unknown or absent id to a real view, so a shared link always shows the
   * recipient what the sender was looking at. replaceState, not location.hash: picking a view is
   * not a navigation, and Back should leave the page rather than walk six LDPC views.
   */
  canonicalTab(id) {
    this.tab = id || null;
    store.set('tab:' + this.page, id || '');
    const want = '#' + this.page + (id ? '/' + id : '');
    if (location.hash !== want) history.replaceState(null, '', want);
  },
  /** The view this page should open with: the one in the URL, else the last one used, else null. */
  tabFor(page, valid) {
    const want = this.page === page ? this.tab : null;
    if (want && valid.includes(want)) return want;
    const last = store.get('tab:' + page);
    return last && valid.includes(last) ? last : null;
  },
};
window.app = app;

// ---- transport wiring ----
const $ = id => document.getElementById(id);
const clock = app.clock;
$('btn-play').onclick = () => clock.toggle();
$('btn-stop').onclick = () => clock.stop();
$('loop').onchange = e => { clock.loop = e.target.checked; };
$('speed').oninput = e => { const s = Math.pow(2, +e.target.value); clock.setSpeed(s); $('speed-val').textContent = (s >= 1 ? s.toFixed(0) : s.toFixed(3).replace(/0+$/, '')) + '×'; };
$('scrub').oninput = e => clock.seek(+e.target.value * clock.duration);
clock.subscribe((c, kind) => {
  $('btn-play').textContent = c.playing ? '❚❚' : '▶';
  if (kind !== 'seek') $('scrub').value = c.duration ? c.t / c.duration : 0;
  $('clock-readout').textContent = app.clockFormat ? app.clockFormat(c.t, c) : c.t.toFixed(2) + ' s';
});
// rAF stops while the tab is hidden but WebAudio keeps playing, so a backgrounded phone goes on
// making sound with a frozen playhead. Pause on the way out (the pages stop their buffer source on
// 'pause') and resume on the way back in; a constrained device also drops the decoder worker,
// which iOS would otherwise leave pinning a core behind a switched-away tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    app._resumeOnShow = clock.playing;
    clock.pause();
    if (app.worker && constrained()) { app.worker.terminate(); app.worker = null; app.jsPasses = 0; }
  } else if (app._resumeOnShow) { app._resumeOnShow = false; clock.play(); }
  else if (clock.playing) clock._emit('seek');
});
window.addEventListener('pagehide', () => { clock.pause(); if (app.worker) { app.worker.terminate(); app.worker = null; app.jsPasses = 0; } });
document.addEventListener('keydown', e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return; if (e.code === 'Space') { e.preventDefault(); clock.toggle(); } if (e.code === 'Home') clock.stop(); });

// ---- load your own WAV ----
import('../dsp/resample.js').then(({ resampleTo12k }) => {
  const inp = document.getElementById('wavfile');
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    app.status('reading ' + f.name + '…');
    try {
      const { parseWav } = await import('../dsp/wav.js');
      const wav = parseWav(await f.arrayBuffer());
      const s12 = wav.rate === 12000 ? wav.samples : resampleTo12k(wav.samples, wav.rate);
      if (s12.length < 1920 * 79) { app.status('WAV too short: need at least 12.64 s'); return; }
      app.setAudio(s12, f.name.replace(/\.wav$/i, ''), null);
      app.status(`${f.name}: ${(s12.length / 12000).toFixed(1)} s${wav.rate !== 12000 ? ` (resampled from ${wav.rate} Hz)` : ''}`);
      route(true);
    } catch (e) { app.status('could not load WAV: ' + e.message); }
  };
  document.getElementById('btn-example').onclick = () => { if (app.exampleAudio) { app.setAudio(app.exampleAudio, '260726_190930', app.exampleTruth); route(true); } };
});

// ---- routing: #<page> or #<page>/<view> ----
let current = null;
const nav = $('nav');
for (const s of STAGES) { const a = document.createElement('a'); a.href = '#' + s.id; a.textContent = s.title; a.dataset.id = s.id; nav.append(a); }
let routeToken = 0;
async function route(force = false) {
  const token = ++routeToken;
  const [id, tab] = (location.hash || '#home').slice(1).split('/');
  const s = STAGES.find(x => x.id === id) || STAGES[0];
  if (id && id !== s.id) history.replaceState(null, '', '#' + s.id);   // hash named a page that does not exist
  const samePage = !force && current && app.page === s.id;
  app.page = s.id; app.tab = tab || null;
  for (const a of nav.children) a.classList.toggle('active', a.dataset.id === s.id);
  // A view change inside the same page is not a navigation: keep the mounted page and let it swap.
  if (samePage && current.setTab) { current.setTab(app.tab); return; }
  // Drop the reference before awaiting: two navigations in flight would otherwise both reach the
  // same module's unmount(), and a second unmount can undo what the winner has already set up.
  const prev = current; current = null;
  if (prev && prev.unmount) prev.unmount();
  app.clockFormat = null;
  clock.pause();
  clearHeatmapCache();   // every entry belongs to the page just unmounted; the new one starts cold anyway
  const root = $('stage'); root.innerHTML = '';
  const mod = await s.load();
  if (token !== routeToken) return;   // a newer navigation won while this module was loading
  current = mod.default;
  current.mount(root, app);
  layoutKey = readLayoutKey();
}
window.addEventListener('hashchange', () => route());

// ---- viewport changes ----
// Pages size their canvases from the column they sit in, so a rotation or a desktop zoom has to
// rebuild them. The key is the quantized layout width plus the device pixel ratio, and comparing
// it is what makes this safe on a phone: iOS fires resize continuously while its URL bar collapses
// during a scroll, and Android fires one whenever the keyboard opens over a text field. Neither
// changes the width, so both expire into a no-op. clientWidth, never innerWidth: under mobile
// emulation innerWidth tracks the overflow rather than the layout viewport.
let layoutKey = '';
const readLayoutKey = () => Math.round(document.documentElement.clientWidth / 10) + '@' + dpr();
let rzTimer = 0;
function viewportChanged() {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    const k = readLayoutKey(); if (k === layoutKey) return; layoutKey = k;
    relayout();
  }, 200);
}
window.addEventListener('resize', viewportChanged, { passive: true });
window.addEventListener('orientationchange', () => requestAnimationFrame(viewportChanged));
/**
 * Ask the current page to rebuild at the new width. Pages expose resize() the same way they expose
 * setTab: assigned in mount, nulled in unmount. The fallback remount is a last resort because
 * route() pauses the clock, wipes the DOM and (on stage 0 and 5) suspends the AudioContext, so it
 * restores the transport position and scroll around it.
 */
function relayout() {
  if (current && current.resize) { try { current.resize(); return; } catch (e) { console.warn('resize hook failed', e); } }
  const t = clock.t, playing = clock.playing, y = window.scrollY;
  route(true).then(() => { clock.seek(t); if (playing) clock.play(); window.scrollTo(0, y); });
}

// ---- load data ----
(async () => {
  app.status('loading example window…');
  // Start both fetches, then paint. The landing page reads neither the 317 KB window nor the
  // ~200 ms of front-end DSP that follows it, and stage pages already know how to show "loading…"
  // and mount themselves on the 'ready' event.
  const wavP = loadWav(asset('data/260726_190930.wav'));
  const truthP = fetch(asset('data/260726_190930.decodes.json')).then(r => r.json());
  await route(true);
  const truth = await truthP;
  truth.js = truth.js || [];
  app.exampleTruth = truth; app.truth = truth;
  app.emit('truth');
  const wav = await wavP;
  app.exampleAudio = wav.samples;
  app.status('computing spectrogram + sync surface…');
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  app.ready = true;
  app.setAudio(wav.samples, '260726_190930', truth);
  app.status('');
  app.emit('ready');
})().catch(e => { app.status('could not load: ' + e.message); console.error(e); });
