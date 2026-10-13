// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
// Derived from WSJT-X (https://wsjt.sourceforge.io/). Copyright 2001 - 2026 by Joe Taylor, K1JT,
// and the WSJT Development Team. Licensed under GPLv3.
//
// Spectrum baseline (noise floor) and SNR. Port of wsjtr snr.rs (WSJT-X get_spectrum_baseline.f90, baseline.f90,
// polyfit.f90, determ.f90) and the SNR arithmetic of wsjt_ft8.rs / ft8b.f90.
import { powerSpectrum } from './fft.js';

const FS = 12000, NFFT1 = 3840, NH1 = NFFT1 / 2, NST = NFFT1 / 2, NSEG = 10, NPCT = 10, NTERMS = 5;
export const BASELINE_DF = FS / NFFT1; // 3.125 Hz

function nuttall(n) { const w = new Float64Array(n); for (let i = 0; i < n; i++) { const t = i / n; w[i] = 0.3635819 - 0.4891775 * Math.cos(2 * Math.PI * t) + 0.1365995 * Math.cos(4 * Math.PI * t) - 0.0106411 * Math.cos(6 * Math.PI * t); } return w; }
function percentile(v, pct) { if (!v.length) return 0; const s = Float64Array.from(v).sort(); const j = Math.min(s.length, Math.max(1, Math.round(s.length * 0.01 * pct))); return s[j - 1]; }

// lib/determ.f90 with its column-swapping pivot.
function determ(a0, n) {
  const a = a0.map(r => r.slice()); let det = 1;
  for (let k = 0; k < n; k++) {
    if (a[k][k] === 0) { let jf = -1; for (let j = k; j < n; j++) if (a[k][j] !== 0) { jf = j; break; } if (jf < 0) return 0; for (let i = k; i < n; i++) { const t = a[i][jf]; a[i][jf] = a[i][k]; a[i][k] = t; } det = -det; }
    det *= a[k][k];
    for (let i = k + 1; i < n; i++) for (let j = k + 1; j < n; j++) a[i][j] -= a[i][k] * a[k][j] / a[k][k];
  }
  return det;
}
// lib/polyfit.f90, mode 0 (unit weights), NTERMS = 5 coefficients (a degree-4 polynomial), solved by Cramer's rule as in the Fortran.
export function polyfitWsjt(x, y) {
  if (!x.length || x.length !== y.length) return null;
  const nmax = 2 * NTERMS - 1; const sumx = new Float64Array(10), sumy = new Float64Array(10);
  for (let p = 0; p < x.length; p++) { let xt = 1; for (let n = 1; n <= nmax; n++) { sumx[n] += xt; xt *= x[p]; } let yt = y[p]; for (let n = 1; n <= NTERMS; n++) { sumy[n] += yt; yt *= x[p]; } }
  const base = Array.from({ length: NTERMS }, (_, j) => Array.from({ length: NTERMS }, (_, k) => sumx[j + k + 1]));
  const delta = determ(base, NTERMS); if (delta === 0) return null;
  const out = new Float64Array(NTERMS);
  for (let l = 0; l < NTERMS; l++) { const m = base.map(r => r.slice()); for (let j = 0; j < NTERMS; j++) m[j][l] = sumy[j + 1]; out[l] = determ(m, NTERMS) / delta; }
  return out;
}

/**
 * Full baseline computation. Returns { sbaseDb: Float32Array(NH1+1) 1-based like the Fortran (index 0 unused),
 * savgDb: Float32Array(NH1+1) the averaged Nuttall spectrum in dB over [ia, ib], ia, ib, points: [{bin, db}] the
 * lower-envelope points the polynomial was fitted to, coeffs, nAveraged }.
 */
export function spectrumBaseline(audio, freqMin = 200, freqMax = 4007) {
  const sbase = new Float32Array(NH1 + 1), savgDb = new Float32Array(NH1 + 1);
  const empty = { sbaseDb: sbase, savgDb, ia: 0, ib: 0, points: [], coeffs: null, nAveraged: 0 };
  if (audio.length < NFFT1) return empty;
  let nfa = freqMin, nfb = freqMax; const nwin = nfb - nfa;
  if (nfa < 100) { nfa = 100; if (nwin < 100) nfb = nfa + nwin; }
  if (nfb > 4910) { nfb = 4910; if (nwin < 100) nfa = nfb - nwin; }
  const ia = Math.max(1, Math.round(nfa / BASELINE_DF)), ib = Math.max(1, Math.round(nfb / BASELINE_DF));
  if (ia >= ib || ib > NH1) return empty;
  const win = nuttall(NFFT1); let sum = 0; for (const w of win) sum += w; const scale = (1920 * 2) / (300 * sum); for (let i = 0; i < NFFT1; i++) win[i] *= scale;
  const nf = audio.length > NST + NFFT1 ? Math.floor((audio.length - NFFT1) / NST) + 1 : 1;
  const savg = new Float64Array(NH1 + 1), tmp = new Float64Array(NFFT1); let nAveraged = 0;
  for (let j = 0; j < nf; j++) { const s = j * NST; if (s + NFFT1 > audio.length) break; for (let i = 0; i < NFFT1; i++) tmp[i] = audio[s + i] * win[i]; const ps = powerSpectrum(tmp, NFFT1); for (let i = 1; i <= NH1; i++) savg[i] += ps[i]; nAveraged++; }
  const sDb = new Float64Array(NH1 + 1); for (let i = ia; i <= ib; i++) sDb[i] = 10 * Math.log10(Math.max(savg[i], 1e-30));
  for (let i = ia; i <= ib; i++) savgDb[i] = sDb[i];
  const nlen = Math.floor((ib - ia + 1) / NSEG); if (nlen < 2) return { ...empty, savgDb, ia, ib };
  const i0 = Math.floor((ib - ia + 1) / 2); const xs = [], ys = [], points = [];
  for (let seg = 0; seg < NSEG; seg++) { const ja = ia + seg * nlen, jb = Math.min(ja + nlen - 1, ib); if (jb <= ja) continue; const base = percentile(sDb.slice(ja, jb + 1), NPCT); for (let i = ja; i <= jb; i++) if (sDb[i] <= base) { xs.push(i - i0); ys.push(sDb[i]); points.push({ bin: i, db: sDb[i] }); } }
  let a = polyfitWsjt(xs, ys); if (!a) a = Float64Array.from([percentile(sDb.slice(ia, ib + 1), NPCT), 0, 0, 0, 0]);
  for (let i = ia; i <= ib; i++) { const t = i - i0; sbase[i] = a[0] + t * (a[1] + t * (a[2] + t * (a[3] + t * a[4]))) + 0.65; }
  return { sbaseDb: sbase, savgDb, ia, ib, points, coeffs: a, nAveraged };
}
/** Just the baseline in dB, 1-based bins (compute_spectrum_baseline_db). */
export function spectrumBaselineDb(audio, freqMin = 200, freqMax = 4007) { return spectrumBaseline(audio, freqMin, freqMax).sbaseDb; }

/** xbase = 10^(0.1·(sbase(nint(f/3.125)) − 40)) (ft8_decode.f90). */
export function xbaseFromSbaseDb(sbaseDb, freqHz) { const bin = Math.min(NH1, Math.max(1, Math.round(freqHz / BASELINE_DF))); return Math.pow(10, 0.1 * ((sbaseDb[bin] || 0) - 40)); }

/** ft8b.f90 xsig/xnoi from the 79×8 symbol bins (scaled by 1/1000 as in pipeline.js) and the decoded tone sequence. */
export function signalAndNoisePower(bins, tones) {
  let xsig = 0, xnoi = 0;
  for (let i = 0; i < 79; i++) { const k = i * 8, t = Math.min(7, tones[i]), ios = (tones[i] + 4) % 7; xsig += (bins.re[k + t] ** 2 + bins.im[k + t] ** 2) * 1e6; xnoi += (bins.re[k + ios] ** 2 + bins.im[k + ios] ** 2) * 1e6; }
  return { xsig, xnoi: Math.max(xnoi, 1e-12) };
}

/**
 * SNR in dB (2500 Hz reference) as reported by wsjtr: the baseline path xsnr2 = 10·log10(xsig/xbase/3e6 − 1) − 27.
 * Returns null when the candidate is rejected (nsync ≤ 10 and xsnr < −25). Also returns the tone-vs-off-tone estimate.
 */
export function computeXsnrDb(nsync, xsig, xnoi, xbase) {
  let xsnr = 0.001, xsnr2 = 0.001;
  const arg = xsig / xnoi - 1; if (arg > 0.1) xsnr = arg;
  const arg2 = xsig / Math.max(xbase, 1e-30) / 3e6 - 1; if (arg2 > 0.1) xsnr2 = arg2;
  const snrTone = 10 * Math.log10(xsnr) - 27, snrBase = 10 * Math.log10(xsnr2) - 27;
  if (nsync <= 10 && snrBase < -25) return null;
  return { snr: snrBase, snrTone };
}
