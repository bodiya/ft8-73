// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Subtraction test: decode the raw window, subtract, compare to wsjtr's recorded pass-2 residual, re-decode, and check SNRs.
import fs from 'node:fs';
import { parseWav } from '../src/dsp/wav.js';
import { spectrogram, syncSurface, syncHits, dedupeCandidates } from '../src/dsp/sync.js';
import { DecodeContext, decodeCandidate } from '../src/dsp/pipeline.js';
import { Subtractor, synthesizeFt8, NMAX } from '../src/dsp/subtract.js';
import { spectrumBaseline, xbaseFromSbaseDb, signalAndNoisePower, computeXsnrDb } from '../src/dsp/baseline.js';
import { powerSpectrum } from '../src/dsp/fft.js';

const truth = JSON.parse(fs.readFileSync('data/260726_190930.decodes.json'));
const raw = parseWav(fs.readFileSync('data/260726_190930.wav').buffer).samples;
const pass2 = parseWav(fs.readFileSync('data/260726_190930_pass2.wav').buffer).samples;

function decodeAll(audio, label) {
  const t = Date.now();
  const spec = spectrogram(audio), surf = syncSurface(spec), hits = syncHits(surf), { kept } = dedupeCandidates(hits.hits, { maxCandidates: 200 });
  const ctx = new DecodeContext(audio); const found = new Map();
  for (const c of kept) { const r = decodeCandidate(ctx, c, { depth: 3 }); if (r.result && !found.has(r.result.message.text)) found.set(r.result.message.text, r); }
  console.log(`${label}: ${hits.hits.length} hits, ${kept.length} candidates, ${found.size} unique decodes (${Date.now() - t} ms)`);
  return found;
}
function bandPowersDb(audio, bands) {
  const x = new Float64Array(NMAX); x.set(audio.subarray(0, Math.min(audio.length, NMAX)));
  const ps = powerSpectrum(x, NMAX); const df = 12000 / NMAX;
  return bands.map(([a, b]) => { let s = 0; for (let i = Math.round(a / df); i < Math.round(b / df); i++) s += ps[i]; return 10 * Math.log10(s + 1e-9); });
}

// --- pass 1 on raw ---
const found1 = decodeAll(raw, 'raw');
const p1msgs = new Set(truth.wsjtr.filter(d => d.pass === 1).map(d => d.message));

// --- (c) SNR via the baseline path vs wsjtr's reported SNR ---
const base = spectrumBaseline(raw, 200, 4007);
console.log('\nSNR check (baseline path vs wsjtr reported):');
let maxErr = 0, sumErr = 0, nErr = 0;
for (const [msg, r] of found1) {
  const d = truth.wsjtr.find(x => x.message === msg); if (!d) continue;
  const { xsig, xnoi } = signalAndNoisePower(r.bins, r.result.tones);
  const s = computeXsnrDb(r.syncQuality.nsync, xsig, xnoi, xbaseFromSbaseDb(base.sbaseDb, r.freq));
  const snr = Math.max(-25, Math.round(s.snr)); const err = snr - d.snr; maxErr = Math.max(maxErr, Math.abs(err)); sumErr += Math.abs(err); nErr++;
  console.log(`  ${String(snr).padStart(4)} (wsjtr ${String(d.snr).padStart(4)}, pass ${d.pass}) tone-est ${s.snrTone.toFixed(0).padStart(4)}  ${r.freq.toFixed(0).padStart(5)} Hz  ${msg}`);
}
console.log(`  mean |error| ${(sumErr / nErr).toFixed(2)} dB, max ${maxErr} dB over ${nErr} decodes`);

// --- (a) subtract only the messages wsjtr reported in its first output burst and compare with wsjtr's pass-2 input ---
const sub = new Subtractor();
const resA = Float32Array.from(raw);
let tSub = 0, nSub = 0;
for (const [msg, r] of found1) if (p1msgs.has(msg)) { const t = Date.now(); const o = sub.subtract(resA, r.result.tones, r.freq, r.dt + 0.5); tSub += Date.now() - t; nSub++; if (!o.applied) console.log('  skipped', msg, o.reason); else if (o.offsetSamples) console.log(`  ${msg}: DT refined by ${o.offsetSamples} samples`); }
console.log(`\nsubtracted ${nSub} pass-1 messages, ${(tSub / nSub).toFixed(0)} ms each (refineDt on: 4 filter passes = 8 FFTs of 180000)`);
const bands = [[700, 800], [1000, 1100], [1500, 1600], [1850, 1950], [2500, 2600], [3050, 3150], [2100, 2200]];
const pr = bandPowersDb(raw, bands), pa = bandPowersDb(resA, bands), pw = bandPowersDb(pass2, bands);
console.log('band power (dB): raw | JS residual | wsjtr pass-2 input | JS-wsjtr');
bands.forEach((b, i) => console.log(`  ${b[0]}-${b[1]} Hz: ${pr[i].toFixed(1)} | ${pa[i].toFixed(1)} | ${pw[i].toFixed(1)} | ${(pa[i] - pw[i]).toFixed(2)}`));
console.log('note: bands with one strong pass-1 signal (700-800, 1850-1950, 3050-3150) should agree to ~0.0 dB. Bands where wsjtr also removed');
console.log('      later decodes differ: pass2.wav is the input to wsjtr\'s second OUTER pass, and each outer pass runs up to 4 internal');
console.log('      decode/subtract rounds (decoder.rs decode_multipass), so it already lacks e.g. 1543/1555 Hz (inferred "pass 3" in the list).');

// --- (b) subtract everything found on pass 1, re-decode the residual ---
const resB = Float32Array.from(raw);
for (const [, r] of found1) sub.subtract(resB, r.result.tones, r.freq, r.dt + 0.5);
const found2 = decodeAll(resB, 'residual after subtracting all 28');
const later = truth.wsjtr.filter(d => d.pass > 1);
const newMsgs = [...found2.keys()].filter(m => !found1.has(m));
console.log('new messages on pass 2:');
for (const m of newMsgs) { const d = truth.wsjtr.find(x => x.message === m); const r = found2.get(m); console.log(`  ${r.freq.toFixed(0).padStart(5)} Hz ${r.dt.toFixed(1).padStart(5)} ${m}  ${d ? `(wsjtr pass ${d.pass}, ${d.snr} dB)` : '(NOT in wsjtr list)'}`); }
console.log(`re-found on pass 2: ${[...found2.keys()].filter(m => found1.has(m)).length} of the 28 already-subtracted messages (should be ~0)`);
console.log(`wsjtr later-pass messages found: ${later.filter(d => found2.has(d.message)).length} / ${later.length}`);

// --- synthesize sanity: a clean synthesized signal decodes ---
const tones = found1.values().next().value.result.tones;
const synth = synthesizeFt8(tones, 1500, { amplitude: 3000, totalLength: 162000 });
const f3 = decodeAll(synth, 'synthesized CQ at 1500 Hz');
console.log('  decoded:', [...f3.keys()].join(' | '), 'expected', found1.keys().next().value);
