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
 * Costas score at (bin i, lag j). jstrt = nominal start row, nssy = rows per symbol (4), nfos = bins per tone (2).
 * Returns { abc, bc, score } where score = max(abc, bc).
 */
export function syncAt(spec, i, j, jstrt = 12, nssy = 4, nfos = 2, maxRow = Infinity) {
  const { nbins, data } = spec; const rows = Math.min(spec.rows, maxRow);
  let ta = 0, tb = 0, tc = 0, t0a = 0, t0b = 0, t0c = 0;
  const at = (bin, m) => (bin < 0 || bin >= nbins || m < 0 || m >= rows) ? 0 : data[m * nbins + bin];
  const sumTones = (m) => { let s = 0; for (let t = 0; t <= 6; t++) s += at(i + nfos * t, m); return s; };
  for (let n = 0; n < 7; n++) {
    const m = j + jstrt + nssy * n;
    const bin = i + nfos * COSTAS[n];
    if (m >= 0 && m < rows) { ta += at(bin, m); t0a += sumTones(m); }
    const m2 = m + nssy * 36;
    if (m2 >= 0 && m2 < rows) { tb += at(bin, m2); t0b += sumTones(m2); }
    const m3 = m + nssy * 72;
    if (m3 >= 0 && m3 < rows) { tc += at(bin, m3); t0c += sumTones(m3); }
  }
  const t = ta + tb + tc;
  let t0 = (t0a + t0b + t0c - t) / 6;
  const abc = t0 > 0 ? t / t0 : 0;
  const tbc = tb + tc;
  let t0bc = (t0b + t0c - tbc) / 6;
  const bc = t0bc > 0 ? tbc / t0bc : 0;
  return { abc, bc, score: Math.max(abc, bc) };
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
  for (let li = 0; li < nl; li++) {
    const j = li - JZ;
    for (let bi = 0; bi < nb; bi++) surface[li * nb + bi] = syncAt(spec, ia + bi, j, jstrt, 4, 2, maxRow).score;
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
