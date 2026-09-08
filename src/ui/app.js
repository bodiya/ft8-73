// App shell: loads the example window, runs the shared front-end DSP once, hosts stages, owns the transport clock.
import { loadWav } from '../dsp/wav.js';
import { spectrogram, syncSurface, syncHits, dedupeCandidates } from '../dsp/sync.js';
import { DecodeContext } from '../dsp/pipeline.js';
import { Clock } from './clock.js';
import { FS } from '../dsp/constants.js';

// Every runtime URL is resolved against this module, not against the document, so the app works
// unchanged at a domain root, in a project subpath (https://user.github.io/ft8-for-dummies/), and
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

/** requestIdleCallback with a timeout fallback (Safari only shipped rIC in 18.2). */
const idle = (fn, timeout = 1500) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 60));
/** localStorage is unavailable or throws in some privacy modes; never let that break a page. */
const store = {
  get(k) { try { return localStorage.getItem('ft8fd:' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ft8fd:' + k, v); } catch { } },
};

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
  asset,
  status(msg) { document.getElementById('loadstatus').textContent = msg; },
  emit(kind) { for (const fn of this.listeners) fn(kind); },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  recomputeSync() {
    const p = this.syncParams;
    if (!this.surf || this.surf._fmin !== p.freqMin || this.surf._fmax !== p.freqMax) { this.surf = syncSurface(this.spec, p.freqMin, p.freqMax); this.surf._fmin = p.freqMin; this.surf._fmax = p.freqMax; }
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
    this.audio = samples.length > 180000 ? samples.slice(0, 180000) : samples; this.duration = this.audio.length / FS; this.name = name;
    this.truth = truth || { window: name, band: '', wsjtr: [], wsjtx: [], js: [] };
    this.spec = null; this.surf = null; this.ctx = null; this.selected = null; this.trace = null; this._baseline = null;
    this.clock.pause(); this.clock.setDuration(this.duration);
    this.spec = spectrogram(this.audio); this.recomputeSync();
    this.emit('audio');
    // With a reference decode list in hand the JS run is only needed for stage 4 and the "this JS
    // decoder" overlays, so it waits for an idle moment instead of competing with first paint.
    // Without one it is the only reference there is, so it starts now.
    if (this.truth.wsjtr && this.truth.wsjtr.length) this.warm(); else this.runJsDecoder();
  },
  /** Precompute the expensive shared objects while the browser is idle, so no page pays for them. */
  warm() {
    if (this._warmScheduled) return; this._warmScheduled = true;
    idle(() => {
      this._warmScheduled = false; this._warming = true;
      try { this.getCtx(); } catch (e) { console.warn('warm ctx', e); }
      this._warming = false;
      idle(() => { this.getBaseline().catch(() => { }); idle(() => this.ensureJsDecoder(), 6000); }, 3000);
    }, 800);
  },
  /** Start the background 3-pass JS decode unless it has already run or is running. */
  ensureJsDecoder() { if (this.worker || (this.truth && this.truth.js && this.truth.js.length)) return; this.runJsDecoder(); },
  /** Run the JS decoder (multi-pass when subtraction is available) in a worker; fills truth.js. */
  runJsDecoder(passes = 3, depths = [1, 2, 3]) {
    if (this.worker) this.worker.terminate();
    this.jsPassInputs = []; this.truth.js = [];
    const w = this.worker = new Worker(new URL('../dsp/worker.js', import.meta.url), { type: 'module' });
    const id = ++this._jobId; const label = this.name || 'window';
    w.onmessage = ev => { const m = ev.data; if (m.id !== id) return;
      if (m.type === 'progress') this.status(m.note ? `JS decoder pass ${m.pass}: ${m.note}` : `JS decoder pass ${m.pass}: ${m.i}/${m.n} candidates, ${m.found} decodes`);
      if (m.type === 'passInput') { this.jsPassInputs[m.pass - 1] = m.audio; this.emit('jspass'); }
      if (m.type === 'pass' || m.type === 'done') { this.truth.js = m.decodes; this.emit('jsdecodes'); }
      if (m.type === 'done') { this.status(`${label}: JS decoder found ${m.decodes.length} messages`); w.terminate(); if (this.worker === w) this.worker = null; } };
    w.onerror = e => { this.status('JS decoder error: ' + e.message); };
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
  setTab(id) { store.set('tab:' + this.page, id || ''); location.hash = '#' + this.page + (id ? '/' + id : ''); },
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
  $('clock-readout').textContent = c.t.toFixed(2) + ' s';
});
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
async function route(force = false) {
  const [id, tab] = (location.hash || '#home').slice(1).split('/');
  const s = STAGES.find(x => x.id === id) || STAGES[0];
  const samePage = !force && current && app.page === s.id;
  app.page = s.id; app.tab = tab || null;
  for (const a of nav.children) a.classList.toggle('active', a.dataset.id === s.id);
  // A view change inside the same page is not a navigation: keep the mounted page and let it swap.
  if (samePage && current.setTab) { current.setTab(app.tab); return; }
  if (current && current.unmount) current.unmount();
  clock.pause();
  const root = $('stage'); root.innerHTML = '';
  const mod = await s.load();
  current = mod.default;
  current.mount(root, app);
}
window.addEventListener('hashchange', () => route());

// ---- load data ----
(async () => {
  app.status('loading example window…');
  const [wav, truth] = await Promise.all([loadWav(asset('data/260726_190930.wav')), fetch(asset('data/260726_190930.decodes.json')).then(r => r.json())]);
  truth.js = truth.js || [];
  app.exampleAudio = wav.samples; app.exampleTruth = truth;
  app.status('computing spectrogram + sync surface…');
  await new Promise(r => setTimeout(r, 10));
  app.ready = true;
  app.setAudio(wav.samples, '260726_190930', truth);
  app.status('');
  app.emit('ready');
  route(true);
})().catch(e => { app.status('could not load: ' + e.message); console.error(e); });
