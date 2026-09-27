// Web Worker: run the JTTY receiver over a recording chunk by chunk and stream what it did.
// Each forward decode window posts its sync surface (quantized), its picks and any new frame
// decodes, so the page can show a streaming decoder streaming.
import { Receiver } from './receiver.js';

/** s0 / local noise level in dB, 0.25 dB steps from -10 dB, transposed to [step][bin] for display. */
function quantize(call) {
  const { s0, level } = call.surface, [j0, j1] = call.bins, nb = j1 - j0 + 1, nc = call.ncols;
  const q = new Uint8Array(nb * nc);
  for (let j = 0; j < nb; j++) { const lv = level[j] || 1e-30; for (let i = 0; i < nc; i++) { const v = 10 * Math.log10(s0[j * nc + i] / lv + 1e-12); q[i * nb + j] = Math.max(0, Math.min(255, Math.round((v + 10) * 4))); } }
  const lvDb = Float32Array.from(level, v => 10 * Math.log10(v + 1e-30));
  return { q, lvDb };
}
const slimPick = p => { const o = { ...p }; delete o.event; if (p.event) o.eventIdx = p.event._idx; return o; };
const slimEvent = e => { const o = { ...e }; return o; };

self.onmessage = (ev) => {
  const { id, audio, opts } = ev.data;
  try {
    const rx = new Receiver({ ...opts, trace: true });
    rx.x = audio;
    const nwave = audio.length; let istart = 1, k = 0, sent = 0;
    const n = Math.max(0, Math.floor((nwave - rx.nchunk) / rx.stepSamples) + 1);
    self.postMessage({ id, type: 'start', n, nchunk: rx.nchunk, step: rx.stepSamples, nss: rx.nss });
    while (istart + rx.nchunk - 1 <= nwave) {
      const c0 = rx.calls.length;
      rx.step(istart, 1);
      const calls = rx.calls.slice(c0); rx.calls.length = 0;   // the trace is posted, not kept
      for (let i = sent; i < rx.events.length; i++) rx.events[i]._idx = i;
      const fwd = calls[0], out = { istart: fwd.istart, t0: fwd.t0, tEnd: fwd.tEnd, bins: fwd.bins, ncols: fwd.ncols, nstepSearch: fwd.nstepSearch, presub: fwd.presub.map(p => ({ f1: p.f1, tsync: p.tsync, why: p.why })), picks: fwd.picks.map(slimPick),
        retro: calls.slice(1).map(c => ({ istart: c.istart, t0: c.t0, picks: c.picks.filter(p => p.event).map(slimPick) })) };
      const tr = [];
      if (fwd.surface) { const s = quantize(fwd); out.q = s.q; out.lvDb = s.lvDb; tr.push(s.q.buffer, s.lvDb.buffer); }
      const events = rx.events.slice(sent).map(slimEvent); sent = rx.events.length;
      const messages = [...rx.messages.values()].map(m => ({ id: m.id, text: m.text, f1: m.f1, startTsync: m.startTsync, complete: m.complete, nframes: m.frames.length }));
      self.postMessage({ id, type: 'step', k: k++, n, call: out, events, messages }, tr);
      istart += rx.stepSamples;
    }
    self.postMessage({ id, type: 'done' });
  } catch (e) { self.postMessage({ id, type: 'error', message: e.message || String(e) }); }
};
