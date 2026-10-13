// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
// Derived from WSJT-X (https://wsjt.sourceforge.io/). Copyright 2001 - 2026 by Joe Taylor, K1JT,
// and the WSJT Development Team. Licensed under GPLv3.
//
// FT8 waveform synthesis and signal subtraction.
// Port of wsjtr subtract_ft8.rs / gen_ft8wave.rs (WSJT-X subtractft8.f90, gen_ft8wave.f90, peakup.f90).
import { fft } from './fft.js';

export const FS = 12000;
export const NSPS = 1920;
export const NSYM = 79;
export const NFRAME = NSPS * NSYM;   // 151680 samples = 12.64 s
export const NMAX = 15 * FS;         // 180000: the subtraction works on a full 15 s buffer
export const NFILT = 4000;           // smoothing FIR length (cos^2 window)
export const TX_OFFSET_SAMPLES = 6000; // nominal TX start 0.5 s into the window
const TWOPI = 2 * Math.PI;

// Abramowitz-Stegun 7.1.26 erf approximation (same one wsjtr uses).
export function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
/** GFSK frequency pulse for bandwidth-time product bt at time t (in symbol units). */
export function gfskPulse(bt, t) { const c = Math.PI * Math.sqrt(2 / Math.LN2); return 0.5 * (erf(c * bt * (t + 0.5)) - erf(c * bt * (t - 0.5))); }

let PULSE = null;
/** The 3-symbol-long GFSK pulse (BT = 2.0) sampled at 12 kHz: Float64Array(3*NSPS). */
export function gfskPulseTable() {
  if (!PULSE) { PULSE = new Float64Array(3 * NSPS); for (let i = 0; i < 3 * NSPS; i++) PULSE[i] = gfskPulse(2.0, (i + 1 - 1.5 * NSPS) / NSPS); }
  return PULSE;
}

/**
 * Instantaneous phase increment per sample (rad) for the 79 tones at carrier f0, length (NSYM+2)*NSPS.
 * Index NSPS..NSPS+NFRAME is the transmitted frame; the extra symbol on each side is a dummy copy of the first/last tone
 * so the Gaussian smoothing has something to overlap with.
 */
export function instantaneousPhaseIncrement(tones, f0) {
  const pulse = gfskPulseTable(), dphiPeak = TWOPI / NSPS;
  const dphi = new Float64Array((NSYM + 2) * NSPS);
  for (let j = 0; j < NSYM; j++) { const ib = j * NSPS, tone = tones[j]; for (let n = 0; n < 3 * NSPS; n++) dphi[ib + n] += dphiPeak * pulse[n] * tone; }
  for (let n = 0; n < 2 * NSPS; n++) dphi[n] += dphiPeak * tones[0] * pulse[NSPS + n];
  const start = NSYM * NSPS; for (let n = 0; n < 2 * NSPS; n++) dphi[start + n] += dphiPeak * tones[NSYM - 1] * pulse[n];
  const shift = TWOPI * f0 / FS; for (let i = 0; i < dphi.length; i++) dphi[i] += shift;
  return dphi;
}

/** Raised-cosine amplitude ramps (240 samples) applied in place to the first and last symbol of a frame-length signal. */
function applyRamps(re, im, off = 0) {
  const nramp = Math.round(NSPS / 8);
  for (let i = 0; i < nramp; i++) { const w = (1 - Math.cos(TWOPI * i / (2 * nramp))) / 2; re[off + i] *= w; if (im) im[off + i] *= w; }
  const k1 = NSYM * NSPS - nramp;
  for (let i = 0; i < nramp; i++) { const w = (1 + Math.cos(TWOPI * i / (2 * nramp))) / 2; re[off + k1 + i] *= w; if (im) im[off + k1 + i] *= w; }
}

/**
 * Complex analytic FT8 waveform (unit amplitude) for 79 tones at carrier f0 Hz: { re, im } Float64Array(NFRAME).
 * This is the reference `cref` used by the subtractor (gen_ft8wave with icmplx=1).
 */
export function synthesizeFt8Complex(tones, f0) {
  const dphi = instantaneousPhaseIncrement(tones, f0);
  const re = new Float64Array(NFRAME), im = new Float64Array(NFRAME);
  let phi = 0;
  for (let k = 0, j = NSPS; k < NFRAME; k++, j++) { re[k] = Math.cos(phi); im[k] = Math.sin(phi); phi += dphi[j]; if (phi >= TWOPI) phi -= TWOPI * Math.floor(phi / TWOPI); }
  applyRamps(re, im);
  return { re, im };
}

/**
 * Real FT8 transmit audio at 12 kHz (gen_ft8wave.rs). opts: { amplitude (1), leadIn (TX_OFFSET_SAMPLES): silence before the signal,
 * totalLength (leadIn + NFRAME): pad with trailing zeros to this length }.
 * Returns Float32Array. With defaults: 6000 zeros + 151680 samples = 13.14 s.
 */
export function synthesizeFt8(tones, f0, opts = {}) {
  const amp = opts.amplitude ?? 1, lead = opts.leadIn ?? TX_OFFSET_SAMPLES, total = Math.max(opts.totalLength ?? (lead + NFRAME), lead + NFRAME);
  const dphi = instantaneousPhaseIncrement(tones, f0);
  const out = new Float32Array(total);
  let phi = 0;
  for (let k = 0, j = NSPS; k < NFRAME; k++, j++) { out[lead + k] = Math.cos(phi); phi += dphi[j]; if (phi >= TWOPI) phi -= TWOPI * Math.floor(phi / TWOPI); }
  applyRamps(out, null, lead);
  if (amp !== 1) for (let i = lead; i < lead + NFRAME; i++) out[i] *= amp;
  return out;
}

/** Parabolic interpolation of the minimum of three equally spaced points (peakup.f90). */
export function peakup(ym, y0, yp) { const d = 2 * (yp + ym - 2 * y0); return Math.abs(d) < 1e-12 ? 0 : -(yp - ym) / d; }

/**
 * Subtracts decoded FT8 signals from a 12 kHz audio buffer (Ft8Subtractor).
 * Algorithm: camp = dd · conj(cref); cfilt = LPF(camp) via a 4001-tap cos² FIR applied in the frequency domain (one
 * 180000-point FFT pair), end-corrected near the frame edges; dd -= 2·Re(cfilt · cref).
 * Construct once per window; the FIR response is precomputed.
 */
export class Subtractor {
  constructor(dtConfig = {}) {
    this.dtConfig = { range: dtConfig.range ?? 90, steps: dtConfig.steps ?? 1 };
    const window = new Float64Array(NFILT + 1); let sumw = 0;
    for (let j = 0; j <= NFILT; j++) { const x = Math.cos(Math.PI * (j - NFILT / 2) / NFILT); window[j] = x * x; sumw += x * x; }
    for (let j = 0; j <= NFILT; j++) window[j] /= sumw;
    this.endCorrection = new Float64Array(NFILT / 2 + 1);
    for (let j = 0; j <= NFILT / 2; j++) { let tail = 0; for (let k = j; k <= NFILT / 2; k++) tail += window[k]; const den = 1 - tail; this.endCorrection[j] = Math.abs(den) > 1e-12 ? 1 / den : 1; }
    // cw_freq = FFT(window rotated left by NFILT/2+1) / NMAX
    const re = new Float64Array(NMAX), im = new Float64Array(NMAX); const rot = NFILT / 2 + 1;
    for (let i = 0; i <= NFILT; i++) re[((i - rot) % NMAX + NMAX) % NMAX] = window[i];
    const CW = fft(re, im); this.cwRe = CW.re; this.cwIm = CW.im;
    for (let i = 0; i < NMAX; i++) { this.cwRe[i] /= NMAX; this.cwIm[i] /= NMAX; }
    this.lastLog = null;
  }

  /** Low-pass filtered complex amplitude estimate of cref inside dd starting at sample nstart. Returns {re, im} length NMAX (frame at 0..NFRAME). */
  _filter(dd, nstart) {
    const c = this.cref; const re = new Float64Array(NMAX), im = new Float64Array(NMAX);
    for (let i = 0; i < NFRAME; i++) { const j = nstart + i; if (j >= 0 && j < NMAX) { const x = dd[j]; re[i] = x * c.re[i]; im[i] = -x * c.im[i]; } }
    const F = fft(re, im);
    for (let i = 0; i < NMAX; i++) { const a = F.re[i], b = F.im[i], cr = this.cwRe[i], ci = this.cwIm[i]; F.re[i] = a * cr - b * ci; F.im[i] = a * ci + b * cr; }
    const out = fft(F.re, F.im, true); // unscaled inverse; the 1/NMAX is folded into cw
    const ec = this.endCorrection, edge = NFILT / 2;
    for (let i = 0; i <= edge; i++) { out.re[i] *= ec[i]; out.im[i] *= ec[i]; const k = Math.max(0, NFRAME - 1 - i); out.re[k] *= ec[i]; out.im[k] *= ec[i]; }
    return out;
  }
  _residual(dd, nstart, cf) {
    const c = this.cref; let sq = 0;
    for (let i = 0; i < NFRAME; i++) { const j = nstart + i; if (j >= 0 && j < NMAX) { const r = dd[j] - 2 * (cf.re[i] * c.re[i] - cf.im[i] * c.im[i]); sq += r * r; } }
    return sq;
  }
  _apply(dd, nstart, cf) {
    const c = this.cref;
    for (let i = 0; i < NFRAME; i++) { const j = nstart + i; if (j >= 0 && j < NMAX) dd[j] -= 2 * (cf.re[i] * c.re[i] - cf.im[i] * c.im[i]); }
  }

  /**
   * Subtract one decoded signal in place from `audio` (Float32Array or Float64Array, any length; a 15 s working buffer is used).
   * tones: 79 tone indices; f0: Hz; dtAbs: signal start in seconds from the start of the buffer (= reported DT + 0.5).
   * opts: { refineDt (true): try start offsets -range..+range samples (3 points by default), parabolic-interpolate the minimum
   *         residual energy, and skip the subtraction if the interpolation is unreliable (|dx| > 1), exactly as wsjtr does.
   *         returnSignal (false): also return the subtracted waveform (Float32Array, buffer-length) for visualization }.
   * Returns { applied, offsetSamples, residuals, signal? }.
   */
  subtract(audio, tones, f0, dtAbs, opts = {}) {
    const refine = opts.refineDt ?? true;
    const dd = new Float64Array(NMAX); dd.set(audio.subarray(0, Math.min(audio.length, NMAX)));
    this.cref = synthesizeFt8Complex(tones, f0);
    const nstart = Math.round(dtAbs * FS);
    let idt = 0, residuals = null, cfAt0 = null;
    if (refine) {
      const range = this.dtConfig.range, steps = Math.max(1, this.dtConfig.steps), stepSize = Math.floor(range / steps);
      const offsets = []; for (let i = -steps; i <= steps; i++) offsets.push(i * stepSize);
      residuals = offsets.map(off => { const cf = this._filter(dd, nstart + off); if (off === 0) cfAt0 = cf; return this._residual(dd, nstart + off, cf); });
      let best = 0; for (let i = 1; i < residuals.length; i++) if (residuals[i] < residuals[best]) best = i;
      if (best > 0 && best < residuals.length - 1) {
        const dx = peakup(residuals[best - 1], residuals[best], residuals[best + 1]);
        if (Math.abs(dx) > 1) { this.lastLog = `skip (parabolic dx=${dx.toFixed(2)})`; return { applied: false, offsetSamples: 0, residuals, reason: this.lastLog }; }
        idt = offsets[best] + Math.round(stepSize * dx);
      } else idt = offsets[best];
    }
    const before = opts.returnSignal ? Float64Array.from(dd) : null;
    const cf = (idt === 0 && cfAt0) ? cfAt0 : this._filter(dd, nstart + idt);
    this._apply(dd, nstart + idt, cf);
    const n = Math.min(audio.length, NMAX); for (let i = 0; i < n; i++) audio[i] = dd[i];
    const out = { applied: true, offsetSamples: idt, residuals };
    if (before) { out.signal = new Float32Array(n); for (let i = 0; i < n; i++) out.signal[i] = before[i] - dd[i]; }
    return out;
  }
}
