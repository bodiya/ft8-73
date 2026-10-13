// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
// Derived from WSJT-X (https://wsjt.sourceforge.io/). Copyright 2001 - 2026 by Joe Taylor, K1JT,
// and the WSJT Development Team. Licensed under GPLv3.
//
// JTTY waveforms: the GFSK modulator, the sync template, and a transmission simulator.
// Ports of WSJT-X 3.2 lib/jtty/gen_jttywave.f90, gen_syncwave.f90, genjtty.f90 and sjtty.f90
// (the AWGN path; no Watterson fading), plus lib/gfsk_pulse.f90.
import { SYNC13, frameTones } from './fec.js';

/** erf(x): Numerical Recipes' erfcc Chebyshev fit, relative error < 1.2e-7 (float32 is what the Fortran has). */
export function erf(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}
/** gfsk_pulse(b, t): a unit frequency step smoothed by a Gaussian of bandwidth-time product b. */
export function gfskPulse(b, t) { const c = Math.PI * Math.sqrt(2 / Math.log(2)); return 0.5 * (erf(c * b * (t + 0.5)) - erf(c * b * (t - 0.5))); }

/** The message's channel tones: 59 per frame (13 sync + 46 data), frames back to back. */
export function messageTones(frames) { const out = new Uint8Array(59 * frames.length); frames.forEach((f, i) => out.set(frameTones(f), 59 * i)); return out; }

/**
 * gen_jttywave: phase increments of the smoothed frequency, (nsym+2)*nsps long, including the
 * dummy first and last symbols. f0 is the frequency of tone 0; tone spacing is fs/nsps (hmod 1).
 */
export function phaseIncrements(tones, nsps, fs, f0, bt = 2.0) {
  const nsym = tones.length, pulse = new Float64Array(3 * nsps);
  for (let i = 1; i <= 3 * nsps; i++) pulse[i - 1] = gfskPulse(bt, (i - 1.5 * nsps) / nsps);
  const dphi = new Float64Array((nsym + 2) * nsps), peak = 2 * Math.PI / nsps;
  for (let j = 0; j < nsym; j++) { const ib = j * nsps; for (let i = 0; i < 3 * nsps; i++) dphi[ib + i] += peak * pulse[i] * tones[j]; }
  for (let i = 0; i < 2 * nsps; i++) dphi[i] += peak * tones[0] * pulse[nsps + i];
  for (let i = 0; i < 2 * nsps; i++) dphi[nsym * nsps + i] += peak * tones[nsym - 1] * pulse[i];
  const w0 = 2 * Math.PI * f0 / fs; for (let i = 0; i < dphi.length; i++) dphi[i] += w0;
  return dphi;
}
const NTAB = 65536;
/**
 * The waveform itself, nsym*nsps samples. complex=true returns { re, im } using the Fortran's
 * 65536-entry phase table; complex=false returns sin(phi). Both carry the nsps/8 raised-cosine
 * ramps at the ends.
 */
export function genWave(tones, nsps, fs, f0, { complex = false, bt = 2.0 } = {}) {
  const nsym = tones.length, n = nsym * nsps, dphi = phaseIncrements(tones, nsps, fs, f0, bt), TWO = 2 * Math.PI;
  const re = new Float64Array(n), im = complex ? new Float64Array(n) : null;
  let phi = 0;
  for (let k = 0; k < n; k++) {
    if (complex) { const i = Math.min(NTAB - 1, Math.floor(phi * NTAB / TWO)); const a = TWO * i / NTAB; re[k] = Math.cos(a); im[k] = Math.sin(a); }
    else re[k] = Math.sin(phi);
    phi = (phi + dphi[nsps + k]) % TWO;
  }
  const nramp = Math.round(nsps / 8);
  for (let i = 0; i < nramp; i++) {
    const up = (1 - Math.cos(TWO * i / (2 * nramp))) / 2, dn = (1 + Math.cos(TWO * i / (2 * nramp))) / 2, k1 = n - nramp + i;
    re[i] *= up; re[k1] *= dn; if (im) { im[i] *= up; im[k1] *= dn; }
  }
  return complex ? { re, im } : re;
}

/** gen_syncwave: the 13-symbol sync template at 6000 Sa/s, nss samples per symbol, continuous phase. */
export function syncWave(nss) {
  const re = new Float64Array(13 * nss), im = new Float64Array(13 * nss); let phi = 0, k = 0;
  for (let i = 0; i < 13; i++) { const d = 2 * Math.PI * SYNC13[i] / nss; for (let j = 0; j < nss; j++) { re[k] = Math.cos(phi); im[k] = Math.sin(phi); k++; phi += d; } }
  return { re, im };
}

/** Seeded Gaussian noise (a Box-Muller pair from a 32-bit LCG), so a page redraw is reproducible. */
export function gaussian(seed = 12345) {
  let s = seed >>> 0, spare = null;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => { if (spare != null) { const v = spare; spare = null; return v; } const r = Math.sqrt(-2 * Math.log(u())), a = 2 * Math.PI * u(); spare = r * Math.sin(a); return r * Math.cos(a); };
}

/**
 * sjtty's AWGN transmission: the complex waveform delayed by dt, scaled so its power over the
 * noise power in 2500 Hz is snrDb, imag() taken, unit-variance noise added, times 100, rounded to
 * 16-bit integers. One frame of noise follows the signal. snrDb > 90 means no noise, full scale.
 * Returns Float32Array samples at 12 kHz in int16 units, as parseWav() gives.
 */
export function simulate(tones, { f0 = 1500, dt = 0.5, snrDb = -10, nsps = 384, seed = 12345, total = 0 } = {}) {
  const fs = 12000, nwave = nsps * tones.length, i0 = Math.round(dt * fs);
  const iz = Math.max(total, i0 + nwave + nsps * 59);
  const { im } = genWave(tones, nsps, fs, f0, { complex: true });
  const sig = snrDb > 90 ? 1 : Math.sqrt(2 * 2500 / (fs / 2)) * Math.pow(10, 0.05 * snrDb);
  const wave = new Float64Array(iz);
  for (let i = 0; i < nwave && i0 + i < iz; i++) wave[i0 + i] = sig * im[i];
  if (snrDb <= 90) { const g = gaussian(seed); for (let i = 0; i < iz; i++) wave[i] = 100 * (wave[i] + g()); }
  else { let pk = 0; for (const v of wave) pk = Math.max(pk, Math.abs(v)); const f = 32766.9 / (pk || 1); for (let i = 0; i < iz; i++) wave[i] *= f; }
  const out = new Float32Array(iz); for (let i = 0; i < iz; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(wave[i])));
  return out;
}
