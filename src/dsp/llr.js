// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
// Derived from WSJT-X (https://wsjt.sourceforge.io/). Copyright 2001 - 2026 by Joe Taylor, K1JT,
// and the WSJT Development Team. Licensed under GPLv3.
//
// Soft-symbol -> LLR metrics. Port of llr_passes_from_bins in wsjt_ft8.rs (ft8b.f90 "bmet").
import { GRAY_MAP } from './constants.js';

function maxByBit(s2, bitPos) {
  let max1 = -1, max0 = -1;
  for (let i = 0; i < s2.length; i++) { const v = s2[i]; if ((i >> bitPos) & 1) { if (v > max1) max1 = v; } else if (v > max0) max0 = v; }
  return [Math.max(max1, 0), Math.max(max0, 0)];
}
function fillBitMetrics(s2, ibmax, bitBase, out, outNorm) {
  for (let ib = 0; ib <= ibmax; ib++) {
    const bitPos = ibmax - ib; const [m1, m0] = maxByBit(s2, bitPos); const bm = m1 - m0; const idx = bitBase + ib;
    if (idx >= 174) continue;
    out[idx] = bm;
    if (outNorm) { const den = Math.max(m1, m0); outNorm[idx] = den > 0 ? bm / den : 0; }
  }
}
function normalize(b) {
  let mean = 0, mean2 = 0; for (const v of b) { mean += v; mean2 += v * v; } mean /= 174; mean2 /= 174;
  const varr = Math.max(mean2 - mean * mean, 0); const sigma = varr > 0 ? Math.sqrt(varr) : Math.sqrt(mean2);
  if (sigma > 0) for (let i = 0; i < 174; i++) b[i] /= sigma;
  return sigma;
}

/**
 * Compute the five LLR sets (a: 1-symbol, b: 2-symbol, c: 3-symbol, d: normalized 1-symbol, e: best-of-abc).
 * power=false -> amplitude metric (|bin|), true -> power metric (|bin|^2).
 * Sign convention: positive = bit 0 (WSJT-X). Returns { a,b,c,d,e } Float64Array(174) each, scaled by 2.83.
 */
export function llrPasses(bins, power = false) {
  const bre = bins.re, bim = bins.im;
  const mag = (sym, tone) => { const k = sym * 8 + tone; return Math.hypot(bre[k], bim[k]); };
  const cplx = (sym, tone) => { const k = sym * 8 + tone; return [bre[k], bim[k]]; };
  const bmeta = new Float64Array(174), bmetb = new Float64Array(174), bmetc = new Float64Array(174), bmetd = new Float64Array(174);
  const s8 = new Float64Array(8), s64 = new Float64Array(64), s512 = new Float64Array(512);
  for (let nsym = 1; nsym <= 3; nsym++) {
    const ibmax = nsym === 1 ? 2 : nsym === 2 ? 5 : 8;
    for (let half = 0; half < 2; half++) {
      const symOff = half === 0 ? 7 : 43, bitOff = half * 87;
      for (let k = 1; k <= 29; k += nsym) {
        const ks = symOff + (k - 1), bitBase = bitOff + (k - 1) * 3;
        if (nsym === 1) {
          for (let i = 0; i < 8; i++) s8[i] = mag(ks, GRAY_MAP[i]);
          if (power) for (let i = 0; i < 8; i++) s8[i] *= s8[i];
          fillBitMetrics(s8, ibmax, bitBase, bmeta, bmetd);
        } else if (nsym === 2) {
          for (let i = 0; i < 64; i++) {
            const i2 = (i & 63) >> 3, i3 = i & 7;
            const a = cplx(ks, GRAY_MAP[i2]), b = cplx(Math.min(ks + 1, 78), GRAY_MAP[i3]);
            s64[i] = Math.hypot(a[0] + b[0], a[1] + b[1]);
          }
          if (power) for (let i = 0; i < 64; i++) s64[i] *= s64[i];
          fillBitMetrics(s64, ibmax, bitBase, bmetb, null);
        } else {
          for (let i = 0; i < 512; i++) {
            const i1 = i >> 6, i2 = (i & 63) >> 3, i3 = i & 7;
            const a = cplx(ks, GRAY_MAP[i1]), b = cplx(Math.min(ks + 1, 78), GRAY_MAP[i2]), c = cplx(Math.min(ks + 2, 78), GRAY_MAP[i3]);
            s512[i] = Math.hypot(a[0] + b[0] + c[0], a[1] + b[1] + c[1]);
          }
          if (power) for (let i = 0; i < 512; i++) s512[i] *= s512[i];
          fillBitMetrics(s512, ibmax, bitBase, bmetc, null);
        }
      }
    }
  }
  const bmete = new Float64Array(174);
  for (let i = 0; i < 174; i++) { let best = bmeta[i]; if (Math.abs(bmetb[i]) > Math.abs(best)) best = bmetb[i]; if (Math.abs(bmetc[i]) > Math.abs(best)) best = bmetc[i]; bmete[i] = best; }
  for (const b of [bmeta, bmetb, bmetc, bmetd, bmete]) { normalize(b); for (let i = 0; i < 174; i++) b[i] *= 2.83; }
  return { a: bmeta, b: bmetb, c: bmetc, d: bmetd, e: bmete };
}

export const LLR_PASS_INFO = {
  a: '1-symbol amplitude: per bit, max|bin| over tones with bit=1 minus max over bit=0',
  b: '2-symbol blocks: coherent sum of 2 consecutive symbols (64 hypotheses)',
  c: '3-symbol blocks: coherent sum of 3 consecutive symbols (512 hypotheses)',
  d: '1-symbol, normalized by the larger max (scale-free)',
  e: 'best-of a/b/c per bit (largest magnitude wins)',
};
