// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
// Derived from WSJT-X (https://wsjt.sourceforge.io/). Copyright 2001 - 2026 by Joe Taylor, K1JT,
// and the WSJT Development Team. Licensed under GPLv3.
//
// Coarse sync: port of wsjtr sync.rs (WSJT-X sync8.f90).
import { powerSpectrum } from './fft.js';
import { FS, NSPS, COSTAS, NFFT_SYNC, NSTEP_SYNC, DF_SYNC, TSTEP_SYNC, JZ, MLAG } from './constants.js';

/**
 * Spectrogram used by the sync search: 1920-sample frames zero-padded to 3840 points,
 * hop 480 samples. Returns { rows, nbins, data(Float32Array rows*nbins), df, tstep }.
 * Frames start at sample 0 (compute_time_window in sync.rs yields start 0 for dt_offset 0.5).
 */
export function spectrogram(audio) {
  const nbins = NFFT_SYNC / 2;
  const rows = Math.floor((audio.length - NSPS) / NSTEP_SYNC) + 1;
  const data = new Float32Array(rows * nbins);
  const frame = new Float64Array(NSPS);
  for (let t = 0; t < rows; t++) {
    const s = t * NSTEP_SYNC;
    for (let i = 0; i < NSPS; i++) frame[i] = audio[s + i];
    const ps = powerSpectrum(frame, NFFT_SYNC);
    const base = t * nbins;
    for (let i = 0; i < nbins; i++) data[base + i] = ps[i] / 300; // scale as in sync.rs (irrelevant to ratios)
  }
  return { rows, nbins, data, df: DF_SYNC, tstep: TSTEP_SYNC };
}

/**
 * Sum of the 7 tone slots starting at bin b in row m: sum over t of data[m][b + 2t], with bins
 * past the end counting as zero. syncSurface asks for the same (m, b) at all 125 lags, so this
 * is precomputed once per spectrogram and cached on it. Float64 accumulator in ascending t, so
 * every sum is bit-identical to the on-the-fly loop it replaces.
 */
export function toneSums(spec) {
  if (spec._tsum) return spec._tsum;
  const { rows, nbins, data } = spec;
  const ts = new Float64Array(rows * nbins);
  for (let m = 0; m < rows; m++) {
    const base = m * nbins;
    for (let b = 0; b < nbins; b++) {
      let s = 0;
      for (let t = 0; t <= 6; t++) { const k = b + 2 * t; if (k < nbins) s += data[base + k]; }
      ts[base + b] = s;
    }
  }
  spec._tsum = ts;
  return ts;
}
/** Free the table (5 MB for a 13.5 s window). Worth calling when a spectrogram is kept only for
 *  display after its one syncSurface call; pointless when the same spec is searched repeatedly. */
export function dropToneSums(spec) { spec._tsum = null; }

// Scratch for syncCore so the inner loop of syncSurface allocates nothing: [abc, bc, score].
const _sc = new Float64Array(3);
/** The Costas score itself. Writes _sc; `ts` is toneSums(spec) or null for the generic path. */
function syncCore(spec, i, j, jstrt, nssy, nfos, rows, ts) {
  const nbins = spec.nbins, data = spec.data;
  let ta = 0, tb = 0, tc = 0, t0a = 0, t0b = 0, t0c = 0;
  for (let n = 0; n < 7; n++) {
    const bin = i + nfos * COSTAS[n];
    const binOk = bin >= 0 && bin < nbins;
    const m0 = j + jstrt + nssy * n;
    for (let blk = 0; blk < 3; blk++) {
      const m = m0 + nssy * 36 * blk;
      if (m < 0 || m >= rows) continue;
      const base = m * nbins;
      const tv = binOk ? data[base + bin] : 0;
      let sv;
      if (ts) sv = ts[base + i];
      else { sv = 0; for (let t = 0; t <= 6; t++) { const b = i + nfos * t; if (b >= 0 && b < nbins) sv += data[base + b]; } }
      if (blk === 0) { ta += tv; t0a += sv; } else if (blk === 1) { tb += tv; t0b += sv; } else { tc += tv; t0c += sv; }
    }
  }
  const t = ta + tb + tc;
  const t0 = (t0a + t0b + t0c - t) / 6;
  const abc = t0 > 0 ? t / t0 : 0;
  const tbc = tb + tc;
  const t0bc = (t0b + t0c - tbc) / 6;
  const bc = t0bc > 0 ? tbc / t0bc : 0;
  _sc[0] = abc; _sc[1] = bc; _sc[2] = abc > bc ? abc : bc;
}

/**
 * Costas score at (bin i, lag j). jstrt = nominal start row, nssy = rows per symbol (4), nfos = bins per tone (2).
 * Returns { abc, bc, score } where score = max(abc, bc).
 */
export function syncAt(spec, i, j, jstrt = 12, nssy = 4, nfos = 2, maxRow = Infinity) {
  const rows = Math.min(spec.rows, maxRow);
  const ts = (nfos === 2 && i >= 0 && i < spec.nbins) ? toneSums(spec) : null;
  syncCore(spec, i, j, jstrt, nssy, nfos, rows, ts);
  return { abc: _sc[0], bc: _sc[1], score: _sc[2] };
}

/**
 * Full sync surface over frequency bins [ia..ib] and lags [-JZ..JZ].
 * Returns { ia, ib, nb, nl, surface(Float32Array nl*nb, row=lag), lags[], freqs[] }.
 */
export function syncSurface(spec, freqMin = 200, freqMax = 4007, dtOffset = 0.5, maxRow = Infinity) {
  const jstrt = Math.round(dtOffset / spec.tstep);
  let ia = Math.max(1, Math.round(freqMin / spec.df));
  let ib = Math.min(spec.nbins - 1, Math.round(freqMax / spec.df));
  const nb = ib - ia + 1, nl = 2 * JZ + 1;
  const surface = new Float32Array(nl * nb);
  const rows = Math.min(spec.rows, maxRow), ts = toneSums(spec);
  for (let li = 0; li < nl; li++) {
    const j = li - JZ;
    for (let bi = 0; bi < nb; bi++) { syncCore(spec, ia + bi, j, jstrt, 4, 2, rows, ts); surface[li * nb + bi] = _sc[2]; }
  }
  const lags = Array.from({ length: nl }, (_, li) => (li - JZ));
  const freqs = Array.from({ length: nb }, (_, bi) => (ia + bi) * spec.df);
  return { ia, ib, nb, nl, surface, lags, freqs, jstrt, tstep: spec.tstep, df: spec.df, maxRow: Math.min(spec.rows, maxRow) };
}

/** k-th percentile of an array (WSJT-X style: index round(pct*n) 1-based). */
export function percentile(values, pct) {
  const s = Float32Array.from(values).sort();
  if (!s.length) return 0;
  const idx = Math.max(1, Math.round(pct * s.length)) - 1;
  return s[Math.min(idx, s.length - 1)];
}

/**
 * Collapse the surface into the "red" spectra and produce raw sync hits.
 * opts: { mlag (13), basePct (0.40), syncMin (1.2), maxHits (1000), useRed2 (true) }
 * Returns { red, red2, jpeak, jpeak2, base, base2, hits:[{freq, dt, score, bin, lag, kind}] } — red arrays normalized.
 */
export function syncHits(surf, opts = {}) {
  const mlag = opts.mlag ?? MLAG, basePct = opts.basePct ?? 0.40, syncMin = opts.syncMin ?? 1.2;
  const maxHits = opts.maxHits ?? 1000, useRed2 = opts.useRed2 ?? true;
  const { nb, nl, surface, tstep } = surf;
  const red = new Float32Array(nb), red2 = new Float32Array(nb);
  const jpeak = new Int16Array(nb), jpeak2 = new Int16Array(nb);
  for (let bi = 0; bi < nb; bi++) {
    let best = -1, bestJ = 0, best2 = -1, bestJ2 = 0;
    for (let li = 0; li < nl; li++) {
      const j = li - JZ, v = surface[li * nb + bi];
      if (Math.abs(j) <= mlag && v > best) { best = v; bestJ = j; }
      if (v > best2) { best2 = v; bestJ2 = j; }
    }
    red[bi] = best; red2[bi] = best2; jpeak[bi] = bestJ; jpeak2[bi] = bestJ2;
  }
  const base = percentile(red, basePct), base2 = percentile(red2, basePct);
  if (base > 0) for (let i = 0; i < nb; i++) red[i] /= base;
  if (base2 > 0) for (let i = 0; i < nb; i++) red2[i] /= base2;
  const order = Array.from({ length: nb }, (_, i) => i).sort((a, b) => red[b] - red[a]);
  const hits = [];
  for (const bi of order) {
    if (hits.length >= maxHits) break;
    const freq = surf.freqs[bi];
    if (red[bi] >= syncMin) hits.push({ freq, dt: (jpeak[bi] - 0.5) * tstep, score: red[bi], bin: bi, lag: jpeak[bi], kind: 'red' });
    if (!useRed2 || jpeak2[bi] === jpeak[bi]) continue;
    if (red2[bi] >= syncMin) hits.push({ freq, dt: (jpeak2[bi] - 0.5) * tstep, score: red2[bi], bin: bi, lag: jpeak2[bi], kind: 'red2' });
  }
  return { red, red2, jpeak, jpeak2, base, base2, hits };
}

/** Dedupe hits (candidates.rs): strongest first, drop anything within (dtTol, freqTol) of a kept one, cap at max. */
export function dedupeCandidates(hits, opts = {}) {
  const dtTol = opts.dtTol ?? 0.04, freqTol = opts.freqTol ?? 4.0, max = opts.maxCandidates ?? 200;
  const sorted = hits.slice().sort((a, b) => b.score - a.score);
  const kept = [], dropped = [];
  for (const c of sorted) {
    const dup = kept.find(k => Math.abs(k.dt - c.dt) <= dtTol && Math.abs(k.freq - c.freq) <= freqTol);
    if (dup) { dropped.push({ ...c, dupOf: dup }); continue; }
    kept.push(c);
    if (kept.length >= max) break;
  }
  return { kept, dropped };
}
