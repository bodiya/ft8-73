// Fine sync + symbol extraction on the 200 Hz baseband. Port of wsjt_ft8.rs (ft8b.f90 / sync8d.f90).
import { fft } from './fft.js';
import { COSTAS } from './constants.js';
import { NP2, FS2 } from './downsample.js';

const TWOPI = 2 * Math.PI;
// csync[i][n] = exp(j 2π tone_i n / 32)
const CSYNC = COSTAS.map(tone => {
  const re = new Float64Array(32), im = new Float64Array(32);
  for (let n = 0; n < 32; n++) { const phi = TWOPI * tone * n / 32; re[n] = Math.cos(phi); im[n] = Math.sin(phi); }
  return { re, im };
});

export function ctwk32(delf) {
  const re = new Float64Array(32), im = new Float64Array(32);
  const dphi = TWOPI * delf / FS2; let phi = 0;
  for (let i = 0; i < 32; i++) { re[i] = Math.cos(phi); im[i] = Math.sin(phi); phi = (phi + dphi) % TWOPI; }
  return { re, im };
}

/** Coherent matched-filter Costas sync at baseband sample offset i0 (sum of |corr|^2 over 21 sync symbols). */
export function sync8d(cd, i0, ctwk = null) {
  let sync = 0;
  for (let i = 0; i < 7; i++) {
    const i1 = i0 + i * 32, i2 = i1 + 36 * 32, i3 = i1 + 72 * 32;
    let z1r = 0, z1i = 0, z2r = 0, z2i = 0, z3r = 0, z3i = 0;
    const cs = CSYNC[i];
    for (let n = 0; n < 32; n++) {
      // w = conj(ctwk[n] * cs[n])
      let wr = cs.re[n], wi = cs.im[n];
      if (ctwk) { const a = wr, b = wi; wr = ctwk.re[n] * a - ctwk.im[n] * b; wi = ctwk.re[n] * b + ctwk.im[n] * a; }
      wi = -wi;
      const p1 = i1 + n, p2 = i2 + n, p3 = i3 + n;
      if (i1 >= 0 && p1 >= 0 && p1 < NP2) { z1r += cd.re[p1] * wr - cd.im[p1] * wi; z1i += cd.re[p1] * wi + cd.im[p1] * wr; }
      if (i2 >= 0 && p2 >= 0 && p2 < NP2) { z2r += cd.re[p2] * wr - cd.im[p2] * wi; z2i += cd.re[p2] * wi + cd.im[p2] * wr; }
      if (i3 >= 0 && p3 >= 0 && p3 < NP2) { z3r += cd.re[p3] * wr - cd.im[p3] * wi; z3i += cd.re[p3] * wi + cd.im[p3] * wr; }
    }
    sync += z1r * z1r + z1i * z1i + z2r * z2r + z2i * z2i + z3r * z3r + z3i * z3i;
  }
  return sync;
}

/**
 * Fine sync: time search ±10 samples (5 ms each) then frequency tweak ±2.5 Hz in 0.5 Hz steps.
 * Returns { ibest, delf, timeCurve:[{idt, sync}], freqCurve:[{delf, sync}] }.
 */
export function fineSync(cd, dtLag, dtOffset = 0.5) {
  const i0 = Math.round((dtLag + dtOffset) * FS2);
  let best = 0, ibest = i0; const timeCurve = [];
  for (let idt = i0 - 10; idt <= i0 + 10; idt++) { const s = sync8d(cd, idt); timeCurve.push({ idt, sync: s }); if (s > best) { best = s; ibest = idt; } }
  let bestF = 0, delf = 0; const freqCurve = [];
  for (let ifr = -5; ifr <= 5; ifr++) { const d = ifr * 0.5; const s = sync8d(cd, ibest, ctwk32(d)); freqCurve.push({ delf: d, sync: s }); if (s > bestF) { bestF = s; delf = d; } }
  return { ibest, delf, timeCurve, freqCurve };
}

export function timeRefine(cd, ibest) {
  let best = 0, ib2 = ibest; const curve = [];
  for (let idt = -4; idt <= 4; idt++) { const s = sync8d(cd, ibest + idt); curve.push({ idt, sync: s }); if (s > best) { best = s; ib2 = ibest + idt; } }
  return { ibest2: ib2, curve };
}

/** 79 symbols x 8 tones complex bins via 32-point FFT. Returns { re: Float64Array(79*8), im } (scaled by 1/1000). */
export function extractSymbolBins(cd, ibest) {
  const re = new Float64Array(79 * 8), im = new Float64Array(79 * 8);
  const bre = new Float64Array(32), bim = new Float64Array(32);
  for (let sym = 0; sym < 79; sym++) {
    const i1 = ibest + sym * 32;
    bre.fill(0); bim.fill(0);
    if (i1 >= 0 && i1 + 31 < NP2 && i1 + 31 < cd.re.length) for (let n = 0; n < 32; n++) { bre[n] = cd.re[i1 + n]; bim[n] = cd.im[i1 + n]; }
    const X = fft(bre, bim);
    for (let t = 0; t < 8; t++) { re[sym * 8 + t] = X.re[t] / 1000; im[sym * 8 + t] = X.im[t] / 1000; }
  }
  return { re, im };
}

export function binPower(bins, sym, tone) { const k = sym * 8 + tone; return bins.re[k] * bins.re[k] + bins.im[k] * bins.im[k]; }
export function binMag(bins, sym, tone) { return Math.sqrt(binPower(bins, sym, tone)); }

/** nsync = number of the 21 Costas symbols whose strongest tone is the expected one (0..21). */
export function syncQuality(bins) {
  let nCorrect = 0, syncP = 0, otherP = 0; const perSymbol = [];
  for (const start of [0, 36, 72]) for (let n = 0; n < 7; n++) {
    const s = start + n, expected = COSTAS[n];
    let maxT = 0, maxP = 0, sum = 0;
    for (let t = 0; t < 8; t++) { const p = binPower(bins, s, t); sum += p; if (p > maxP) { maxP = p; maxT = t; } }
    const ok = maxT === expected; if (ok) nCorrect++;
    perSymbol.push({ sym: s, expected, got: maxT, ok });
    const ep = binPower(bins, s, expected); syncP += ep; otherP += sum - ep;
  }
  return { nsync: nCorrect, metric: otherP > 0 ? syncP / (otherP / 7) : 0, perSymbol };
}

/** Hard-decision tone per symbol (argmax power). */
export function hardTones(bins) {
  const out = new Uint8Array(79);
  for (let s = 0; s < 79; s++) { let bt = 0, bp = -1; for (let t = 0; t < 8; t++) { const p = binPower(bins, s, t); if (p > bp) { bp = p; bt = t; } } out[s] = bt; }
  return out;
}
