// Mixed-radix complex FFT (any length). Split real/imag Float64Arrays.
// Sizes used by the FT8 pipeline: 3840 (2^8*3*5), 192000 (2^9*3*5^3), 3200 (2^7*5^2), 32.

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
  const p = { n, factors, cos, sin, scratchRe: new Float64Array(n), scratchIm: new Float64Array(n) };
  cache.set(n, p);
  return p;
}

// Recursive decimation-in-time. out[k] = sum x[j] w^(jk), x read with stride from `inRe/inIm`.
function rec(p, inRe, inIm, inOff, stride, outRe, outIm, outOff, n, fi, sign) {
  if (n === 1) { outRe[outOff] = inRe[inOff]; outIm[outOff] = inIm[inOff]; return; }
  const r = p.factors[fi];
  const m = n / r;
  // r sub-transforms of size m
  for (let q = 0; q < r; q++) {
    rec(p, inRe, inIm, inOff + q * stride, stride * r, outRe, outIm, outOff + q * m, m, fi + 1, sign);
  }
  // combine: out[k + s*m] = sum_q W_n^{q(k+s m)} * sub_q[k]
  const tw = p.n / n; // twiddle index scale
  const tRe = new Float64Array(r), tIm = new Float64Array(r);
  for (let k = 0; k < m; k++) {
    for (let q = 0; q < r; q++) {
      const idx = ((q * k) % n) * tw;
      const c = p.cos[idx], s = sign * p.sin[idx];
      const xr = outRe[outOff + q * m + k], xi = outIm[outOff + q * m + k];
      tRe[q] = xr * c - xi * s;
      tIm[q] = xr * s + xi * c;
    }
    for (let s2 = 0; s2 < r; s2++) {
      let accRe = 0, accIm = 0;
      for (let q = 0; q < r; q++) {
        if (q === 0) { accRe += tRe[0]; accIm += tIm[0]; continue; }
        const idx = ((q * s2 * m) % n) * tw;
        const c = p.cos[idx], s = sign * p.sin[idx];
        accRe += tRe[q] * c - tIm[q] * s;
        accIm += tRe[q] * s + tIm[q] * c;
      }
      p.scratchRe[outOff + s2 * m + k] = accRe;
      p.scratchIm[outOff + s2 * m + k] = accIm;
    }
  }
  for (let i = 0; i < n; i++) { outRe[outOff + i] = p.scratchRe[outOff + i]; outIm[outOff + i] = p.scratchIm[outOff + i]; }
}

/** Forward (inverse=false) or inverse (unscaled) FFT. Returns {re, im}. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  const p = plan(n);
  const outRe = new Float64Array(n), outIm = new Float64Array(n);
  rec(p, re, im, 0, 1, outRe, outIm, 0, n, 0, inverse ? -1 : 1);
  return { re: outRe, im: outIm };
}

/** Power spectrum |X|^2 of a real input zero-padded to nfft. Returns Float64Array(nfft/2). */
export function powerSpectrum(x, nfft) {
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let i = 0; i < Math.min(x.length, nfft); i++) re[i] = x[i];
  const { re: R, im: I } = fft(re, im);
  const out = new Float64Array(nfft / 2);
  for (let i = 0; i < nfft / 2; i++) out[i] = R[i] * R[i] + I[i] * I[i];
  return out;
}
