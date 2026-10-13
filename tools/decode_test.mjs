// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Node harness: run the JS pipeline on the bundled window and compare with wsjtr's decode list.
import fs from 'node:fs';
import { parseWav } from '../src/dsp/wav.js';
import { spectrogram, syncSurface, syncHits, dedupeCandidates } from '../src/dsp/sync.js';
import { DecodeContext, decodeCandidate } from '../src/dsp/pipeline.js';

const file = process.argv[2] || 'data/260726_190930.wav';
const truth = JSON.parse(fs.readFileSync('data/260726_190930.decodes.json'));
const { samples, rate } = parseWav(fs.readFileSync(file).buffer);
console.log(`loaded ${samples.length} samples @ ${rate}`);
let t = Date.now();
const spec = spectrogram(samples); console.log(`spectrogram ${spec.rows}x${spec.nbins} in ${Date.now() - t} ms`); t = Date.now();
const surf = syncSurface(spec); console.log(`sync surface ${surf.nl}x${surf.nb} in ${Date.now() - t} ms`); t = Date.now();
const hits = syncHits(surf, { syncMin: 1.2 }); console.log(`hits ${hits.hits.length} (base ${hits.base.toFixed(1)}) in ${Date.now() - t} ms`); t = Date.now();
const { kept } = dedupeCandidates(hits.hits, { maxCandidates: 200 }); console.log(`candidates ${kept.length}`);
const ctx = new DecodeContext(samples); console.log(`downsampler init ${Date.now() - t} ms`); t = Date.now();
const found = new Map();
let n = 0;
for (const c of kept) {
  const r = decodeCandidate(ctx, c, { depth: +(process.argv[3] || 3), lite: true });
  n++;
  if (r.result && !found.has(r.result.message.text)) { found.set(r.result.message.text, r); console.log(`  ${r.snrEstimate.toFixed(0).padStart(4)} ${r.dt.toFixed(1).padStart(5)} ${r.freq.toFixed(0).padStart(5)} ${r.result.metric}/${r.result.pass}/${r.result.how}${r.result.ap ? '+ap' + r.result.ap : ''} ${r.result.message.text}`); }
}
console.log(`decoded ${found.size} unique messages from ${n} candidates in ${Date.now() - t} ms`);
const truthSet = new Set(truth.wsjtr.map(d => d.message));
const p1 = truth.wsjtr.filter(d => d.pass === 1).map(d => d.message);
console.log(`wsjtr pass-1 decodes: ${p1.length}; of those found here: ${p1.filter(m => found.has(m)).length}`);
console.log('missing pass-1:', p1.filter(m => !found.has(m)));
console.log('found but not in wsjtr list:', [...found.keys()].filter(m => !truthSet.has(m)));
