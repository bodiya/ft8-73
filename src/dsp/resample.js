// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Windowed-sinc resampler to 12 kHz (Kaiser window, like jt9r audio.rs; 16 zero crossings).
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; } return s; }
export function resampleTo12k(samples, rate) {
  if (rate === 12000) return Float32Array.from(samples);
  const ratio = rate / 12000, outLen = Math.floor(samples.length / ratio);
  const zc = 16, beta = 8, cutoff = Math.min(1, 1 / ratio) * 0.95, half = zc * Math.max(1, ratio);
  const out = new Float32Array(outLen), i0b = besselI0(beta);
  for (let n = 0; n < outLen; n++) {
    const center = n * ratio; let acc = 0, wsum = 0;
    for (let k = Math.max(0, Math.ceil(center - half)); k <= Math.min(samples.length - 1, Math.floor(center + half)); k++) {
      const x = (k - center) / Math.max(1, ratio); const t = x / zc; if (Math.abs(t) >= 1) continue;
      const w = besselI0(beta * Math.sqrt(1 - t * t)) / i0b; const arg = Math.PI * x * cutoff; const sinc = arg === 0 ? 1 : Math.sin(arg) / arg;
      acc += samples[k] * sinc * cutoff * w; wsum += sinc * cutoff * w;
    }
    out[n] = wsum !== 0 ? acc / wsum * cutoff : 0;
  }
  return out;
}
