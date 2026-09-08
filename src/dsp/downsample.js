// Port of wsjtr wsjt_ft8.rs Ft8Downsampler (WSJT-X ft8_downsample.f90):
// 192000-point FFT of the whole window, extract ~62.5 Hz around f0, taper, shift carrier to DC,
// 3200-point inverse FFT -> 200 Hz complex baseband (32 samples per symbol), NP2 = 2812 useful samples.
import { fft } from './fft.js';

export const NFFT1 = 192000;
export const NFFT2 = 3200;
export const NP2 = 2812;
export const FS2 = 200;
export const NMAX = 180000;

export class Downsampler {
  constructor(audio) {
    const re = new Float64Array(NFFT1), im = new Float64Array(NFFT1);
    const n = Math.min(audio.length, NMAX);
    for (let i = 0; i < n; i++) re[i] = audio[i];
    const X = fft(re, im);
    this.cxRe = X.re; this.cxIm = X.im;
    this.taper = new Float64Array(101);
    for (let i = 0; i <= 100; i++) this.taper[i] = 0.5 * (1 + Math.cos(i * Math.PI / 100));
  }

  /** Returns { re, im } Float64Array(NFFT2) complex baseband at 200 Hz, carrier f0 at DC. */
  downsample(f0) {
    const df = 12000 / NFFT1, baud = 6.25;
    const i0 = Math.round(f0 / df);
    const it = Math.min(Math.round((f0 + 8.5 * baud) / df), NFFT1 / 2);
    const ib = Math.max(Math.round((f0 - 1.5 * baud) / df), 1);
    const c1Re = new Float64Array(NFFT2), c1Im = new Float64Array(NFFT2);
    let k = 0;
    for (let i = ib; i <= it && k < NFFT2; i++, k++) { c1Re[k] = this.cxRe[i]; c1Im[k] = this.cxIm[i]; }
    if (k > 0) {
      const edge = Math.min(100, k - 1);
      for (let n = 0; n <= edge; n++) { const w = this.taper[100 - Math.min(n, 100)]; c1Re[n] *= w; c1Im[n] *= w; }
      if (k > 100) for (let n = 0; n <= 100; n++) { const idx = k - 1 - 100 + n; if (idx < NFFT2) { c1Re[idx] *= this.taper[n]; c1Im[idx] *= this.taper[n]; } }
    }
    // rotate left by (i0 - ib) so the carrier lands at DC
    let shift = ((i0 - ib) % NFFT2 + NFFT2) % NFFT2;
    const rRe = new Float64Array(NFFT2), rIm = new Float64Array(NFFT2);
    for (let i = 0; i < NFFT2; i++) { rRe[i] = c1Re[(i + shift) % NFFT2]; rIm[i] = c1Im[(i + shift) % NFFT2]; }
    const out = fft(rRe, rIm, true);
    const fac = 1 / Math.sqrt(NFFT1 * NFFT2);
    for (let i = 0; i < NFFT2; i++) { out.re[i] *= fac; out.im[i] *= fac; }
    return out;
  }
}
