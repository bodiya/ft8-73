// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Mixed-radix complex FFT (any length). Split real/imag Float64Arrays.
// Sizes used by the FT8 pipeline: 3840 (2^8*3*5), 192000 (2^9*3*5^3), 3200 (2^7*5^2), 32.
//
// Arithmetic is unchanged from the straightforward version: the same twiddle values from the
// same table, multiplied and accumulated in the same order, so every output is bit-identical.
// What changed is bookkeeping: the per-level combine twiddles are tabulated once in plan()
// instead of being re-derived with an integer modulo inside the innermost loop, the per-call
// scratch is owned by the plan instead of being allocated at every recursion, and
// powerSpectrum() reuses its working buffers.

const cache = new Map();

function plan(n) {
  if (cache.has(n)) return cache.get(n);
  // factorize
  const factors = [];
  let m = n;
  for (const p of [4, 2, 3, 5]) {
    while (m % p === 0) { factors.push(p); m /= p; }
  }
  for (let p = 7; m > 1; p += 2) {
    while (m % p === 0) { factors.push(p); m /= p; }
  }
  // twiddles for the whole size
  const cos = new Float64Array(n), sin = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = -2 * Math.PI * i / n; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  // Per-level combine twiddles W_n^{q*s2*m}, r x r per level. `n` shrinks by one factor per level,
  // so level fi has sub-size nl = n / (f0..f_{fi-1}) and stride tw = n / nl.
  const levels = []; let nl = n, maxR = 1;
  for (let fi = 0; fi < factors.length; fi++) {
    const r = factors[fi], mm = nl / r, tw = n / nl;
    const cc = new Float64Array(r * r), ss = new Float64Array(r * r);
    for (let q = 0; q < r; q++) for (let s2 = 0; s2 < r; s2++) { const idx = ((q * s2 * mm) % nl) * tw; cc[q * r + s2] = cos[idx]; ss[q * r + s2] = sin[idx]; }
    levels.push({ r, m: mm, tw, cc, ss });
    if (r > maxR) maxR = r;
    nl = mm;
  }
  const p = { n, factors, cos, sin, levels, scratchRe: new Float64Array(n), scratchIm: new Float64Array(n), tRe: new Float64Array(maxR), tIm: new Float64Array(maxR) };
  cache.set(n, p);
  return p;
}

// Recursive decimation-in-time. out[k] = sum x[j] w^(jk), x read with stride from `inRe/inIm`.
// tRe/tIm live only inside the combine loop, which never recurses, so one shared pair is enough.
function rec(p, inRe, inIm, inOff, stride, outRe, outIm, outOff, n, fi, sign) {
  if (n === 1) { outRe[outOff] = inRe[inOff]; outIm[outOff] = inIm[inOff]; return; }
  const lv = p.levels[fi], r = lv.r, m = lv.m, tw = lv.tw, cc = lv.cc, ss = lv.ss;
  // r sub-transforms of size m
  for (let q = 0; q < r; q++) {
    rec(p, inRe, inIm, inOff + q * stride, stride * r, outRe, outIm, outOff + q * m, m, fi + 1, sign);
  }
  // combine: out[k + s*m] = sum_q W_n^{q(k+s m)} * sub_q[k]
  const tRe = p.tRe, tIm = p.tIm, cosT = p.cos, sinT = p.sin;
  const sRe = p.scratchRe, sIm = p.scratchIm;
  for (let k = 0; k < m; k++) {
    for (let q = 0; q < r; q++) {
      const idx = (q * k) * tw;   // q < r and k < m, so q*k < n: the old `% n` was always a no-op
      const c = cosT[idx], s = sign * sinT[idx];
      const xr = outRe[outOff + q * m + k], xi = outIm[outOff + q * m + k];
      tRe[q] = xr * c - xi * s;
      tIm[q] = xr * s + xi * c;
    }
    for (let s2 = 0; s2 < r; s2++) {
      let accRe = tRe[0], accIm = tIm[0];
      for (let q = 1; q < r; q++) {
        const c = cc[q * r + s2], s = sign * ss[q * r + s2];
        accRe += tRe[q] * c - tIm[q] * s;
        accIm += tRe[q] * s + tIm[q] * c;
      }
      sRe[outOff + s2 * m + k] = accRe;
      sIm[outOff + s2 * m + k] = accIm;
    }
  }
  for (let i = 0; i < n; i++) { outRe[outOff + i] = sRe[outOff + i]; outIm[outOff + i] = sIm[outOff + i]; }
}

/** Forward (inverse=false) or inverse (unscaled) FFT. Returns {re, im} in freshly allocated arrays. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  const p = plan(n);
  const outRe = new Float64Array(n), outIm = new Float64Array(n);
  rec(p, re, im, 0, 1, outRe, outIm, 0, n, 0, inverse ? -1 : 1);
  return { re: outRe, im: outIm };
}

// Reusable input/output scratch per FFT size. The four Float64Array(nfft) these replace were the
// expensive allocations (the spectrogram makes 337 calls); the small result array is still fresh
// each time, because sharing it would make powerSpectrum unsafe to hold across calls for a 2% win.
const psBufs = new Map();
function psBuf(nfft) {
  let b = psBufs.get(nfft);
  if (!b) { b = { re: new Float64Array(nfft), im: new Float64Array(nfft), outRe: new Float64Array(nfft), outIm: new Float64Array(nfft) }; psBufs.set(nfft, b); }
  return b;
}

/** Power spectrum |X|^2 of a real input zero-padded to nfft. Returns Float64Array(nfft/2). */
export function powerSpectrum(x, nfft) {
  const b = psBuf(nfft);
  const re = b.re, im = b.im;
  const nx = Math.min(x.length, nfft);
  for (let i = 0; i < nx; i++) re[i] = x[i];
  if (nx < nfft) re.fill(0, nx);
  im.fill(0);
  const p = plan(nfft);
  const R = b.outRe, I = b.outIm;
  rec(p, re, im, 0, 1, R, I, 0, nfft, 0, 1);
  const out = new Float64Array(nfft / 2);
  for (let i = 0; i < nfft / 2; i++) out[i] = R[i] * R[i] + I[i] * I[i];
  return out;
}
