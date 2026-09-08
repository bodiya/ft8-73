// OSD / AP test: (a) noise margin gained by OSD on one candidate, (b) full window at depth 3 vs wsjtr's list.
import fs from 'node:fs';
import { parseWav } from '../src/dsp/wav.js';
import { spectrogram, syncSurface, syncHits, dedupeCandidates } from '../src/dsp/sync.js';
import { DecodeContext, decodeCandidate, tonesFromBits77 } from '../src/dsp/pipeline.js';
import { bpDecodeTrace } from '../src/dsp/ldpc.js';
import { bpWithZsum, osdDecode, decodeBpThenOsd, osdParamsFromDepth, osdParamsFromNdeep } from '../src/dsp/osd.js';
import { unpack77, messageOk } from '../src/dsp/unpack77.js';

let ap;
try { ap = await import('../src/dsp/ap.js'); } catch (e) {
  console.log('ap.js import failed (pack77.js missing?) -> using local CQ-only AP:', e.message.split('\n')[0]);
  const MCQ = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, -1, -1];
  ap = { applyApCq(llr) { const o = Float64Array.from(llr); let a = 0; for (const v of llr) a = Math.max(a, Math.abs(v)); a *= 1.1; for (let i = 0; i < 29; i++) o[i] = -a * MCQ[i]; o[74] = a; o[75] = a; o[76] = -a; return o; } };
}

const truth = JSON.parse(fs.readFileSync('data/260726_190930.decodes.json'));
const { samples } = parseWav(fs.readFileSync('data/260726_190930.wav').buffer);
const spec = spectrogram(samples), surf = syncSurface(spec), hits = syncHits(surf, { syncMin: 1.2 });
const { kept } = dedupeCandidates(hits.hits, { maxCandidates: 200 });
const ctx = new DecodeContext(samples);
const jt9r = (arr) => Float64Array.from(arr, v => -v); // pipeline llr sets are WSJT-X sign; flip to jt9r convention
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

// ---------- (a) noise margin ----------
console.log('=== (a) OSD noise margin ===');
const base = decodeCandidate(ctx, kept.find(c => { const r = decodeCandidate(ctx, c, { depth: 3 }); return r.result && r.result.bp.iterations.length > 2; }), { depth: 3 });
const truthBits = base.result.bits77 ?? base.result.bp.bits77;
const llr0 = jt9r(base.llr.amp.a);
console.log(`candidate ${base.freq.toFixed(1)} Hz: "${base.result.message.text}" decodes with BP (${base.result.metric}/${base.result.pass}, ${base.result.bp.iterations.length - 1} it)`);
// Rust unit test equivalent: two low-reliability wrong hard decisions, OSD order 2 must fix them.
{ const { codeword } = tonesFromBits77(truthBits); const l = Float64Array.from(codeword, b => b ? -4 : 4); for (const i of [5, 123]) l[i] = -Math.sign(l[i]) * 0.05; const r = osdDecode(l, 2); console.log(`two low-reliability flips (5,123): OSD ${r.ok ? 'ok' : 'FAIL'}, winner flips ${JSON.stringify(r.trace.winner.flipsCodeword)}, same bits: ${same(r.bits77, truthBits)}; order-1 pool-91: ${(() => { const l2 = Float64Array.from(codeword, b => b ? -4 : 4); l2[80] = -l2[80] * 0.05 / 4; const q = osdDecode(l2, 1, osdParamsFromNdeep(1)); return q.ok && same(q.bits77, truthBits) ? 'ok' : 'FAIL'; })()}`); }
// sanity: OSD alone on clean LLRs
{ const r = osdDecode(llr0, 2); console.log(`OSD order 2 on clean amp/a LLRs: ${r.ok ? 'ok' : 'fail'} (${r.trace.patternsTried} patterns, order-0 dist ${r.trace.order0.dist.toFixed(1)}, winner flips ${JSON.stringify(r.trace.winner.flipsCodeword)}), same bits: ${same(r.bits77, truthBits)}`); }
const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], osdT = { n: 0, ms: 0 };
const rate = (fn, sigma) => seeds.filter(s => { const r = mulberry(s * 977 + 13); const l = Float64Array.from(llr0, v => v + gauss(r) * sigma); return fn(l); }).length / seeds.length;
const tests = {
  'BP only': l => { const r = bpDecodeTrace(l); return r.ok && same(r.bits77, truthBits); },
  'BP+OSD1 (ndeep1, pool 91)': l => { const t0 = performance.now(); const r = decodeBpThenOsd(l, 30, 2); osdT.ms += performance.now() - t0; osdT.n++; return r.ok && same(r.bits77, truthBits); },
  'BP+OSD2 (depth3 default, pool 36)': l => { const r = decodeBpThenOsd(l, 30, 3, 'default'); return r.ok && same(r.bits77, truthBits); },
  'BP+OSD2 deep (pool 91, npre1)': l => { const r = decodeBpThenOsd(l, 30, 3, 'deep'); return r.ok && same(r.bits77, truthBits); },
};
const margin = {};
for (const [name, fn] of Object.entries(tests)) {
  let last = 0; const row = [];
  for (let sigma = 1; sigma <= 3; sigma += 0.25) { const p = rate(fn, sigma); row.push(`${sigma}:${Math.round(p * 10)}/10`); if (p >= 0.5) last = sigma; }
  margin[name] = last; console.log(`${name.padEnd(36)} last σ with ≥5/10 successes: ${last}   [${row.join(' ')}]`);
}
console.log(`OSD gain over BP alone: +${(margin['BP+OSD2 (depth3 default, pool 36)'] - margin['BP only']).toFixed(1)} σ (default), +${(margin['BP+OSD2 deep (pool 91, npre1)'] - margin['BP only']).toFixed(1)} σ (deep)`);

// ---------- (b) full window, depth 3 ----------
console.log('\n=== (b) full window, depth 3: BP -> OSD(zsum snapshots, channel) -> CQ AP ===');
const truthAll = new Set([...truth.wsjtr.map(d => d.message), ...truth.wsjtx.map(d => d.message)]);
const wsjtrSet = new Set(truth.wsjtr.map(d => d.message));
const found = new Map(); let nOsd = 0, nOsdMs = 0, nAp = 0;
const t0 = performance.now();
function accept(bits77, llr, how) {
  const un = unpack77(bits77); if (!un || !messageOk(bits77, un.text)) return null;
  const { codeword } = tonesFromBits77(bits77); let he = 0; for (let i = 0; i < 174; i++) if ((llr[i] < 0 ? 1 : 0) !== codeword[i]) he++;
  if (he > 36) return null; return { text: un.text, how, hardErrors: he };
}
for (const c of kept) {
  const tr = decodeCandidate(ctx, c, { depth: 3, metrics: [] }); // gates + LLRs only, no BP attempts
  const sets = [];
  for (const metric of ['amp', 'pow']) { if ((metric === 'amp' && !tr.allowAmp) || (metric === 'pow' && !tr.allowPow)) continue; for (const pass of ['a', 'b', 'c', 'd', 'e']) sets.push({ metric, pass, llr: jt9r(tr.llr[metric][pass]) }); }
  let res = null;
  for (const s of sets) { const ts = performance.now(); const r = decodeBpThenOsd(s.llr, 30, 3, 'default'); const dt = performance.now() - ts; if (r.how !== 'bp') { nOsd++; nOsdMs += dt; } if (r.ok) { res = accept(r.bits77, s.llr, `${r.how} ${s.metric}/${s.pass}`); if (res) break; } }
  if (!res) for (const metric of ['amp', 'pow']) { if ((metric === 'amp' && !tr.allowAmp) || (metric === 'pow' && !tr.allowPow)) continue; for (const pass of ['a', 'c']) { const l = ap.applyApCq(jt9r(tr.llr[metric][pass])); nAp++; const r = decodeBpThenOsd(l, 30, 3, 'default'); if (r.ok) { res = accept(r.bits77, l, `ap-cq ${r.how} ${metric}/${pass}`); if (res) break; } } if (res) break; }
  if (res && !found.has(res.text)) { found.set(res.text, { ...res, freq: tr.freq, dt: tr.dt }); if (!res.how.startsWith('bp')) console.log(`  ${res.how.padEnd(18)} ${tr.freq.toFixed(0).padStart(5)} Hz  ${res.text}${wsjtrSet.has(res.text) ? '' : truthAll.has(res.text) ? '  (WSJT-X only)' : '  (NOT IN EITHER LIST)'}`); }
}
const total = performance.now() - t0;
const byHow = {}; for (const f of found.values()) { const k = f.how.split(' ')[0]; byHow[k] = (byHow[k] || 0) + 1; }
console.log(`unique messages: ${found.size} (${JSON.stringify(byHow)}) in ${(total / 1000).toFixed(1)} s; OSD calls (BP failed): ${nOsd}, mean ${(nOsdMs / Math.max(1, nOsd)).toFixed(1)} ms per BP+OSD attempt; AP attempts: ${nAp}`);
const bad = [...found.keys()].filter(m => !truthAll.has(m));
console.log(`in wsjtr list: ${[...found.keys()].filter(m => wsjtrSet.has(m)).length}, WSJT-X-only: ${[...found.keys()].filter(m => !wsjtrSet.has(m) && truthAll.has(m)).length}, outside both: ${bad.length} ${bad.length ? JSON.stringify(bad) : ''}`);
const p1 = truth.wsjtr.filter(d => d.pass === 1).map(d => d.message);
console.log(`wsjtr pass-1 (18): found ${p1.filter(m => found.has(m)).length}; wsjtr all passes (51): found ${truth.wsjtr.filter(d => found.has(d.message)).length}`);
