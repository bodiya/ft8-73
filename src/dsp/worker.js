// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Web Worker: run the JS decoder on a window (multi-pass when subtraction is available) and post compact decodes.
import { spectrogram, syncSurface, syncHits, dedupeCandidates, dropToneSums } from './sync.js';
import { DecodeContext, decodeCandidate } from './pipeline.js';

self.onmessage = async (ev) => {
  const { audio, params, passes = 1, depths = [1], id } = ev.data;
  let work = Float32Array.from(audio);
  const decodes = []; const seen = new Set();
  let Subtractor = null, baseline = null;
  try { const m = await import('./subtract.js'); Subtractor = m.Subtractor; } catch (e) { /* not available yet */ }
  try { baseline = await import('./baseline.js'); } catch (e) { }
  for (let pass = 1; pass <= passes; pass++) {
    const depth = depths[Math.min(pass, depths.length) - 1] || 1;
    self.postMessage({ id, type: 'passInput', pass, audio: Float32Array.from(work) });
    const spec = spectrogram(work); const surf = syncSurface(spec, params.freqMin, params.freqMax);
    const hits = syncHits(surf, params); const { kept } = dedupeCandidates(hits.hits, params); dropToneSums(spec);
    const ctx = new DecodeContext(work);
    let sbase = null; if (baseline) { try { sbase = baseline.spectrumBaselineDb(work, params.freqMin, params.freqMax); } catch (e) { sbase = null; } }
    const newOnes = [];
    for (let i = 0; i < kept.length; i++) {
      const c = kept[i];
      const r = decodeCandidate(ctx, c, { depth, lite: true, mycallBits: params.mycallBits || null });
      if (r.result && !seen.has(r.result.message.text)) {
        seen.add(r.result.message.text);
        let snr = r.snrEstimate;
        if (sbase) { try { const xb = baseline.xbaseFromSbaseDb(sbase, r.freq); const { xsig, xnoi } = baseline.signalAndNoisePower(r.bins, r.result.tones); const v = baseline.computeXsnrDb(r.syncQuality.nsync, xsig, xnoi, xb); if (v) snr = Math.max(-25, v.snr); } catch (e) { } }
        const d = { freq: Math.round(r.freq), dt: +r.dt.toFixed(1), snr: Math.round(snr), message: r.result.message.text, pass, how: (r.result.ap ? 'ap' + r.result.ap + '+' : '') + (r.result.how || 'bp'), set: r.result.metric + '/' + r.result.pass, tones: Array.from(r.result.tones), freqExact: r.freq, dtExact: r.dt };
        decodes.push(d); newOnes.push(d);
      }
      if (i % 10 === 0) self.postMessage({ id, type: 'progress', pass, i, n: kept.length, found: decodes.length });
    }
    self.postMessage({ id, type: 'pass', pass, decodes: decodes.slice(), candidates: kept.length });
    if (pass < passes) {
      if (!Subtractor || !newOnes.length) break;
      const sub = new Subtractor();
      let k = 0; for (const d of newOnes) { self.postMessage({ id, type: 'progress', pass, i: 0, n: 0, found: decodes.length, note: `subtracting ${++k}/${newOnes.length}` }); sub.subtract(work, Uint8Array.from(d.tones), d.freqExact, d.dtExact + 0.5); }
    }
  }
  self.postMessage({ id, type: 'done', decodes });
};
