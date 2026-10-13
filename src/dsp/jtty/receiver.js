// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
// Derived from WSJT-X (https://wsjt.sourceforge.io/). Copyright 2001 - 2026 by Joe Taylor, K1JT,
// and the WSJT Development Team. Licensed under GPLv3.
//
// The JTTY receiver: an asynchronous, streaming decoder.
// Port of WSJT-X 3.2 lib/jtty/jtty_mdecode.f90 (module jtty_mdec: jtty_mdecode, jtty_mdecode_step,
// message assembly), rjtty.f90 (the chunk loop), ana64a.f90, jtty_peakup.f90
// (jtty_peakup_coherent), jtty_payload_correlators.f90, subtract_jtty.f90 and lib/twkfreq.f90,
// with the receiver defaults documented in lib/jtty/receiver_defaults.md.
//
// There are no time slots. rjtty feeds the decoder 2.36 s chunks (a frame and a quarter) stepped
// by a quarter frame (0.472 s). In each chunk the decoder looks for a sync sequence starting in
// the first quarter frame (plus 24 ms), in three frequency channels, decodes what passes a gate,
// subtracts it, and stitches frames into messages across chunks.
//
// Sample indices here are 0-based; `istart` keeps the Fortran's 1-based value so the arithmetic
// ((istart-1)/12000 etc.) reads the same as the source.
import { fftPow2 } from './fft2.js';
import { SYNC13, tbccDecode, tbccEncode } from './fec.js';
import { unpackFrame, MAX_FRAMES } from './codec.js';
import { genWave, syncWave } from './wave.js';

export const FS6 = 6000, NFFT = 8192, DF2 = FS6 / NFFT, NH2 = NFFT / 2;
const DT = 1 / FS6;
// Receiver settings (jtty_mdecode.f90's parameters)
export const P = {
  PRESUBTRACT_DECODED: true, SAME_WORD_FREQ_TOLERANCE: 32.0, SYNC_EDGE_STEPS: 12, SYNC_HOLD_HZ: 16.0,
  GATE_FIRST: true, COHERENT_PEAKUP: true, QSO_SYNC_FLOOR: 11.0, WIDE_SYNC_FLOOR: 13.0, SYNC_LEVEL_HZ: 150.0,
  SYNC_LEVEL_STRIDE: 4, WIDE_CANDIDATES: 8, MAX_SYMBOL_ERRORS: 30, QSO_GATE_NSYNC: 7, WIDE_GATE_NSYNC: 7,
  WIDE_GATE_SNR: 3.3, MAX_ACTIVE_MESSAGES: 30, MAX_CONTINUATION_GAP: 3, MAX_RETRO_STEPS: 3,
  FRAME_HISTORY_TIME_TOLERANCE: 0.05, FRAME_HISTORY_FREQ_TOLERANCE: 3.0, NEAR_SIMULTANEOUS_FREQ_TOLERANCE: 12.0,
  CONTINUATION_TIME_TOLERANCE: 0.1, MAXCAND: 100, MAX_SUBTRACTED: 16,
};
const MAX_RECENT_FRAMES = P.MAX_ACTIVE_MESSAGES * MAX_FRAMES;
const nint = x => (x < 0 ? -Math.round(-x) : Math.round(x));
const db = x => (x > 1.259e-10 ? 10 * Math.log10(x) : -99);

/** ana64a: int16-scale real samples at 12 kHz -> analytic signal at 6 kHz, zero-padded to nana. */
export function ana64a(x, off, npts, nana) {
  const re = new Float64Array(nana), im = new Float64Array(nana), fac = 2 / (32767 * nana);
  for (let i = 0; i < npts; i++) re[i] = fac * (x[off + i] || 0);
  fftPow2(re, im);
  const n2 = nana / 2;
  for (let i = n2 / 2 + 1; i < n2; i++) { re[i] = 0; im[i] = 0; }
  re[0] *= 0.5; im[0] *= 0.5;
  const r2 = re.subarray(0, n2), i2 = im.subarray(0, n2);
  fftPow2(r2, i2, true);
  re.fill(0, n2); im.fill(0, n2);
  return { re, im };
}

/** twkfreq with a(1)=fshift only: out[n] = in[n] * exp(j*2pi*fshift*(n+1)/fs). */
export function twkfreq(re, im, off, n, fshift, fs = FS6, out = null) {
  const o = out || { re: new Float64Array(n), im: new Float64Array(n) }, d = 2 * Math.PI * fshift / fs;
  for (let i = 0; i < n; i++) { const a = d * (i + 1), c = Math.cos(a), s = Math.sin(a), xr = re[off + i] || 0, xi = im[off + i] || 0; o.re[i] = xr * c - xi * s; o.im[i] = xr * s + xi * c; }
  return o;
}

/** ctones(0:nss-1, 0:3): one symbol of each tone, starting at phase 0. */
function makeTones(nss) {
  const re = [], im = [];
  for (let t = 0; t < 4; t++) { const r = new Float64Array(nss), i = new Float64Array(nss); for (let n = 0; n < nss; n++) { const a = 2 * Math.PI * t * n / nss; r[n] = Math.cos(a); i[n] = Math.sin(a); } re.push(r); im.push(i); }
  return { re, im };
}

/** jtty_correlate_payload_symbols: 46 x 4 complex correlations, z[k*4+t] = sum conj(tone_t) * c1. */
export function correlatePayload(c1, n, start, nss, tones) {
  const re = new Float64Array(46 * 4), im = new Float64Array(46 * 4);
  if (start < 0 || start >= n) return { re, im };
  const avail = Math.min(46, Math.floor((n - start) / nss));
  for (let k = 0; k < avail; k++) {
    const first = start + k * nss;
    for (let t = 0; t < 4; t++) {
      const tr = tones.re[t], ti = tones.im[t]; let sr = 0, si = 0;
      for (let o = 0; o < nss; o++) { const xr = c1.re[first + o], xi = c1.im[first + o]; sr += tr[o] * xr + ti[o] * xi; si += tr[o] * xi - ti[o] * xr; }
      re[k * 4 + t] = sr; im[k * 4 + t] = si;
    }
  }
  return { re, im };
}

/** Per-symbol tone powers of the 13 sync symbols at sample offset i0 in c1. */
function syncPowers(c1, n, i0base, nss, tones) {
  const pow = [];
  for (let j = 0; j < 13; j++) {
    const i0 = i0base + j * nss; if (i0 + nss > n) break;
    const p = new Float64Array(4);
    for (let t = 0; t < 4; t++) { const tr = tones.re[t], ti = tones.im[t]; let sr = 0, si = 0; for (let o = 0; o < nss; o++) { const xr = c1.re[i0 + o], xi = c1.im[i0 + o]; sr += tr[o] * xr + ti[o] * xi; si += tr[o] * xi - ti[o] * xr; } p[t] = sr * sr + si * si; }
    pow.push(p);
  }
  return pow;
}
const argmax = p => { let k = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[k]) k = i; return k; };

/**
 * jtty_peakup_coherent: refine a pick's start and tone-0 frequency by combining the 13 sync
 * phasors coherently over +-4 ms (4-sample hops), +-2.5 Hz (0.5 Hz) and a +-0.25 Hz sub-grid.
 */
export function peakupCoherent(c0, n, nss, csync, xdt0, f0) {
  const ia = Math.max(0, nint((xdt0 - 0.004) / DT)), ib = nint((xdt0 + 0.004) / DT);
  const nspan = Math.min(n, ib + 13 * nss) - ia;
  if (nspan < nss) return { xdt: xdt0, f1: f0, p: 0 };
  const rotR = [], rotI = [];
  for (let k = 0; k < 13; k++) { const tk = k * nss * DT; const r = new Float64Array(11), i = new Float64Array(11); for (let m = -5; m <= 5; m++) { const a = 2 * Math.PI * 0.05 * m * tk; r[m + 5] = Math.cos(a); i[m + 5] = -Math.sin(a); } rotR.push(r); rotI.push(i); }
  let pmax = -1, bi0 = nint(xdt0 / DT), bidf = 0, bm = 0;
  const cw = { re: new Float64Array(nspan), im: new Float64Array(nspan) }, zr = new Float64Array(13), zi = new Float64Array(13);
  for (let idf = -5; idf <= 5; idf++) {
    twkfreq(c0.re, c0.im, ia, nspan, -(f0 + 0.5 * idf), FS6, cw);
    for (let i0 = ia; i0 <= ib; i0 += 4) {
      for (let k = 0; k < 13; k++) {
        const st = i0 - ia + k * nss; zr[k] = 0; zi[k] = 0;
        if (st + nss > nspan) continue;
        let sr = 0, si = 0; const off = k * nss;
        for (let o = 0; o < nss; o++) { const ar = csync.re[off + o], ai = -csync.im[off + o], xr = cw.re[st + o], xi = cw.im[st + o]; sr += ar * xr - ai * xi; si += ar * xi + ai * xr; }
        zr[k] = sr; zi[k] = si;
      }
      for (let m = 0; m < 11; m++) {
        let ar = 0, ai = 0; for (let k = 0; k < 13; k++) { const rr = rotR[k][m], ri = rotI[k][m]; ar += zr[k] * rr - zi[k] * ri; ai += zr[k] * ri + zi[k] * rr; }
        const p = ar * ar + ai * ai;
        if (p > pmax) { pmax = p; bi0 = i0; bidf = idf; bm = m - 5; }
      }
    }
  }
  return { xdt: bi0 * DT, f1: f0 + 0.5 * bidf + 0.05 * bm, p: Math.max(pmax, 0) };
}

/** The low-pass filter subtract_jtty builds once per (frame length, FFT size): FFT of a cos^2 window. */
const subFilters = new Map();
function subFilter(nfft, nss) {
  const key = nfft + ':' + nss; let f = subFilters.get(key); if (f) return f;
  const nfilt = 2 * nss, w = new Float64Array(nfilt + 1); let sum = 0;
  for (let j = -nfilt / 2; j <= nfilt / 2; j++) { w[j + nfilt / 2] = Math.cos(Math.PI * j / nfilt) ** 2; sum += w[j + nfilt / 2]; }
  const arr = new Float64Array(nfft); for (let k = 0; k <= nfilt; k++) arr[k] = w[k] / sum;
  const re = new Float64Array(nfft), im = new Float64Array(nfft), sh = nfilt / 2 + 1;
  for (let m = 0; m < nfft; m++) re[m] = arr[(m + sh) % nfft];   // cshift(cw, nfilt/2+1)
  fftPow2(re, im); for (let i = 0; i < nfft; i++) { re[i] /= nfft; im[i] /= nfft; }
  f = { re, im }; subFilters.set(key, f); return f;
}

/**
 * subtract_jtty: rebuild the decoded frame at unit amplitude, estimate its complex gain with a
 * two-symbol low-pass of c0 * conj(ref), and subtract gain * ref from c0 in place.
 */
export function subtractFrame(c0, nvalid, tones59, nss, f1, xdt) {
  const n = c0.re.length, nframe = 59 * nss, cw = subFilter(n, nss);
  const ref = genWave(tones59, nss, FS6, f1, { complex: true });
  const nstart = nint(xdt * FS6), ar = new Float64Array(n), ai = new Float64Array(n);
  for (let i = 0; i < nframe; i++) { const j = nstart + i; if (j >= 0 && j < nvalid) { const xr = c0.re[j], xi = c0.im[j], rr = ref.re[i], ri = -ref.im[i]; ar[i] = xr * rr - xi * ri; ai[i] = xr * ri + xi * rr; } }
  fftPow2(ar, ai);
  for (let i = 0; i < n; i++) { const xr = ar[i], xi = ai[i]; ar[i] = xr * cw.re[i] - xi * cw.im[i]; ai[i] = xr * cw.im[i] + xi * cw.re[i]; }
  fftPow2(ar, ai, true);
  for (let i = 0; i < nframe; i++) { const j = nstart + i; if (j >= 0 && j < nvalid) { const gr = ar[i], gi = ai[i], rr = ref.re[i], ri = ref.im[i]; c0.re[j] -= gr * rr - gi * ri; c0.im[j] -= gr * ri + gi * rr; } }
}

/** The (upper) median of an array, as select_median / Wirth's selection returns it. */
function upperMedian(a) { const s = Float64Array.from(a).sort(); return s[Math.floor(s.length / 2)]; }
/** running_median: med[i] = upper median of x[max(0,i-h) .. min(n-1,i+h)]. */
function runningMedian(x, h) {
  const n = x.length, out = new Float64Array(n), win = [];
  const ins = v => { let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 0, v); };
  const rem = v => { let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 1); };
  for (let i = 0; i < Math.min(n, h); i++) ins(x[i]);
  for (let i = 0; i < n; i++) { if (i - h - 1 >= 0) rem(x[i - h - 1]); if (i + h < n) ins(x[i + h]); out[i] = win[win.length >> 1]; }
  return out;
}

/** jtty_search_window: the bins [ja, jb] a channel searches. */
function searchWindow(fc, fwid, nfa, nfb, constrain) {
  if (constrain) { if (nfa > nfb) return null; fc = Math.max(nfa, Math.min(fc, nfb)); }
  let ja = Math.max(3, Math.trunc((fc - fwid) / DF2)), jb = Math.min(NH2 - 2, Math.trunc((fc + fwid) / DF2));
  if (constrain) { ja = Math.max(ja, Math.ceil(nfa / DF2)); jb = Math.min(jb, Math.floor(nfb / DF2)); }
  return ja <= jb ? { ja, jb, fc, fwid } : null;
}

/** display_message_text: a gap of five '~' becomes ' ... ', other '~' become spaces, one leading space dropped. */
export function displayText(s) {
  let m = s.split('');
  for (let i = 0; i + 4 < m.length; i++) if (m.slice(i, i + 5).join('') === '~~~~~') m.splice(i, 5, ' ', '.', '.', '.', ' ');
  let out = m.join('').replace(/~/g, ' ');
  if (out[0] === ' ') out = out.slice(1);
  return out.trimEnd();
}

/**
 * The receiver. new Receiver(opts).decodeAll(samples) runs rjtty's loop over a whole recording;
 * step() is one call of jtty_mdecode_step. With opts.trace, every call records what it did.
 */
export class Receiver {
  constructor(opts = {}) {
    this.nsps = opts.nsps || 384; this.f0 = opts.f0 ?? 1500; this.ftol = opts.ftol ?? 50; this.smin = opts.smin ?? 2.6;
    this.nfa = opts.nfa ?? 200; this.nfb = opts.nfb ?? 2800; this.trace = !!opts.trace; this.keepSurfaces = opts.keepSurfaces !== false;
    this.nss = this.nsps / 2; this.nframe6 = 59 * this.nss; this.ntstep = this.nframe6 / 4; this.ntgrid = this.ntstep / 12;
    this.nframe = 59 * this.nsps; this.nchunk = this.nframe + this.nframe / 4; this.stepSamples = this.nframe / 4;
    this.csync = syncWave(this.nss); this.tones = makeTones(this.nss);
    this.ndecodes = 0; this.active = []; this.recent = []; this.known = []; this.nextId = 1;
    this.messages = new Map(); this.events = []; this.calls = [];
    this.interferer = null; this.subtracted = [];
  }
  /** rjtty: step the chunk through the recording. onStep(k, n) reports progress. */
  decodeAll(x, onStep) {
    const nwave = x.length; this.x = x; let istart = 1, k = 0;
    const n = Math.max(0, Math.floor((nwave - this.nchunk) / this.stepSamples) + 1);
    while (istart + this.nchunk - 1 <= nwave) { this.step(istart, 1); istart += this.stepSamples; if (onStep) onStep(++k, n); }
    return this;
  }
  /** jtty_mdecode_step: one forward call, then retro re-sweeps of the 3 previous windows for each new subtraction. */
  step(istart, istart0 = 1) {
    const stepS = this.stepSamples;
    this.pruneReceiveState((istart - 1) / 12000, this.nframe / 12000);
    this.interferer = null;
    const fwd = this.mdecode(istart, istart0, null);
    const local = this.subtracted.slice();
    for (const s of local) for (let k = 1; k <= P.MAX_RETRO_STEPS; k++) {
      const prev = istart - k * stepS; if (prev < 1) continue;
      this.mdecode(prev, istart0, s, fwd);
    }
    return fwd;
  }

  // ---- receive state ----
  sameRecent(a, b) { return Math.abs(a.f1 - b.f1) < P.NEAR_SIMULTANEOUS_FREQ_TOLERANCE && Math.abs(a.tsync - b.tsync) < P.FRAME_HISTORY_TIME_TOLERANCE; }
  isRecentFrame(c) {
    for (const r of this.recent) {
      if (this.sameRecent(c, r)) return true;
      if (c.decoded === r.decoded && Math.abs(c.f1 - r.f1) < P.SAME_WORD_FREQ_TOLERANCE && Math.abs(c.tsync - r.tsync) < P.FRAME_HISTORY_TIME_TOLERANCE) return true;
    }
    return false;
  }
  rememberRecent(c) { if (this.recent.length >= MAX_RECENT_FRAMES) this.recent.shift(); this.recent.push({ f1: c.f1, tsync: c.tsync, decoded: c.decoded }); }
  queueUpdate(m, complete) {
    const e = this.messages.get(m.id) || { id: m.id, startTsync: m.startTsync, frames: [] };
    e.f1 = m.f1; e.raw = m.decoded; e.text = displayText(m.decoded); e.complete = complete; this.messages.set(m.id, e);
  }
  startMessage(c) {
    if (!c.isLast && this.active.length >= P.MAX_ACTIVE_MESSAGES) return null;
    this.rememberRecent(c);
    const m = { id: this.nextId++, f1: c.f1, tsync: c.tsync, startTsync: c.tsync, decoded: c.decoded, trailingSep: c.trailingSep };
    if (m.decoded.startsWith('599 ')) m.decoded = '~' + m.decoded;
    m.k = m.decoded.length;
    this.queueUpdate(m, c.isLast);
    if (!c.isLast) this.active.push(m);
    return m;
  }
  appendMessage(idx, c, gap) {
    const a = this.active[idx]; if (!a) return null;
    this.rememberRecent(c);
    const k = a.k, n = c.decoded.length;
    if (gap > 1) {
      const nstart = n >= 1 && c.decoded[0] === '~' ? 2 : 1;
      const kz = Math.min(k + 5 + (n - nstart + 1), 80), nchar = Math.max(kz - k - 5, 0);
      a.decoded = (a.decoded.trimEnd() + '~~~~~' + c.decoded.slice(nstart - 1, nstart - 1 + nchar)).slice(0, 80); a.k = k + 5 + nchar;
    } else {
      const kz = Math.min(k + n, 80), add = c.decoded.padEnd(80).slice(0, kz - k);
      a.decoded = (a.decoded.trimEnd() + (a.trailingSep ? ' ' : '') + add).slice(0, 80); a.k = kz;
    }
    a.trailingSep = c.trailingSep; a.f1 = c.f1; a.tsync = c.tsync;
    this.queueUpdate(a, c.isLast);
    const snap = { ...a };
    if (c.isLast) this.active.splice(idx, 1);   // remove_active_message moves the last entry into the hole
    return snap;
  }
  pruneReceiveState(fwd, period) {
    const oldest = fwd - P.MAX_RETRO_STEPS * period / 4;
    this.recent = this.recent.filter(r => !(r.tsync < oldest - P.FRAME_HISTORY_TIME_TOLERANCE));
    this.known = this.known.filter(k => !(k.tsync + period < oldest));
    for (let i = 0; i < this.active.length;) {
      if (oldest - this.active[i].tsync > P.MAX_CONTINUATION_GAP * period + P.CONTINUATION_TIME_TOLERANCE) { this.queueUpdate(this.active[i], false); this.removeActive(i); }
      else i++;
    }
  }
  removeActive(i) { const last = this.active.pop(); if (i < this.active.length) this.active[i] = last; }
  classify(ex, c, period) {
    const df1 = c.f1 - ex.f1, dts = c.tsync - ex.tsync; let match = false, gap = 1, win = false;
    const nfp = nint(dts / period), fpr = Math.abs(dts - period * nfp);
    if (nfp >= 1 && nfp <= P.MAX_CONTINUATION_GAP && fpr < P.CONTINUATION_TIME_TOLERANCE) { const tol = 10 + 3 * (nfp - 1); match = Math.abs(df1) < tol; if (match) gap = nfp; }
    if (!match) {
      const q = period / 4, ns = nint(dts / q), res = Math.abs(dts - q * ns);
      if (Math.abs(ns) <= P.MAX_RETRO_STEPS && Math.abs(df1) < 10 && res < 0.003 && !(Math.abs(ns) % 4 === 0 && ns !== 0)) { match = true; win = true; }
    }
    return { match, win, gap };
  }

  /**
   * jtty_mdecode: one decode window. interferer (retro call) is a frame to subtract before the
   * search. fwd is the forward call this retro call belongs to, for the trace.
   */
  mdecode(istart, istart0, interferer, fwd = null) {
    const nss = this.nss, nchunk = this.nchunk, nchunk6 = nchunk / 2, x = this.x, t0 = (istart - 1) / 12000;
    this.subtracted = [];
    if (istart === istart0 && !interferer) { this.ndecodes = 0; this.active = []; this.recent = []; this.known = []; }
    const call = { istart, t0, tEnd: (istart - 1 + nchunk) / 12000, retro: !!interferer, of: fwd, picks: [], presub: [], surface: null };
    if (this.trace) this.calls.push(call);
    let any = false; for (let i = 0; i < nchunk; i++) if (x[istart - 1 + i]) { any = true; break; }
    if (!any) return call;
    const nana = 2 ** nint(Math.log(nchunk) / Math.log(2) + 0.5);
    // ana64a zeroes from npts; mdecode then zeroes from nchunk6 (the analytic signal is nchunk/2 long at 6 kHz)
    const c0 = ana64a(x, istart - 1, nchunk, nana); c0.re.fill(0, nchunk6); c0.im.fill(0, nchunk6);
    const full59 = payload => { const t = new Uint8Array(59); t.set(SYNC13); t.set(tbccEncode(payload).tones, 13); return t; };
    if (interferer) { subtractFrame(c0, nchunk6, full59(interferer.payload), nss, interferer.f1, interferer.tsync - t0); call.presub.push({ ...interferer, why: 'retro' }); }
    if (P.PRESUBTRACT_DECODED) for (const k of this.known) {
      const xdt = k.tsync - t0; if (xdt >= 0 || xdt + this.nframe6 / FS6 <= 0) continue;
      subtractFrame(c0, nchunk6, full59(k.payload), nss, k.f1, xdt); call.presub.push({ f1: k.f1, tsync: k.tsync, why: 'known' });
    }

    const nfz = nint(10 / DF2), ntz = nint(0.016 * 6000 / 12), nfzHold = nint(P.SYNC_HOLD_HZ / DF2);
    const chanWin = ich => ich === 0 ? searchWindow(this.f0, this.ftol, this.nfa, this.nfb, false) : searchWindow(ich === 1 ? 1350 : 1650, 150, this.nfa, this.nfb, true);
    let firstBin = NH2 - 2, lastBin = 3;
    for (let ich = 0; ich <= 2; ich++) { const w = chanWin(ich); if (!w) continue; firstBin = Math.min(firstBin, w.ja); lastBin = Math.max(lastBin, w.jb); }
    const nbins = lastBin - firstBin + 1, ncols = this.ntgrid + P.SYNC_EDGE_STEPS + 1;
    const nstepSurface = ncols - 1, nstepSearch = nstepSurface - P.SYNC_EDGE_STEPS;
    call.bins = [firstBin, lastBin]; call.ncols = ncols; call.nstepSearch = nstepSearch;
    let s0 = null, level = null, s0Valid = false, anySub = false, ncand = 0;
    const cand = [];
    const S = (j, i) => (j - firstBin) * ncols + i;
    const buildS0 = () => {
      s0 = new Float64Array(nbins * ncols);
      const cr = new Float64Array(NFFT), ci = new Float64Array(NFFT), L = 13 * nss, cs = this.csync;
      for (let istep = 0, i0 = 0; istep < ncols; istep++, i0 += 12) {
        cr.fill(0); ci.fill(0);
        for (let n = 0; n < L; n++) { const ar = cs.re[n], ai = -cs.im[n], xr = c0.re[i0 + n], xi = c0.im[i0 + n]; cr[n] = ar * xr - ai * xi; ci[n] = ar * xi + ai * xr; }
        fftPow2(cr, ci);
        const pw = j => cr[j] * cr[j] + ci[j] * ci[j];
        for (let j = firstBin; j <= lastBin; j++) s0[S(j, istep)] = pw(j - 2) + 2 * pw(j - 1) + 3 * pw(j) + 2 * pw(j + 1) + pw(j + 2);
      }
      s0Valid = true;
      // build_sync_level: median over time of each bin (every 4th column), then a +-150 Hz running median
      const ncol = Math.floor(nstepSurface / P.SYNC_LEVEL_STRIDE) + 1, perBin = new Float64Array(nbins), col = new Float64Array(ncol);
      for (let j = firstBin; j <= lastBin; j++) { for (let k = 0; k < ncol; k++) col[k] = s0[S(j, k * P.SYNC_LEVEL_STRIDE)]; perBin[j - firstBin] = upperMedian(col); }
      level = runningMedian(perBin, nint(P.SYNC_LEVEL_HZ / DF2));
      if (this.trace && this.keepSurfaces && !call.surface) call.surface = { s0: Float32Array.from(s0), level: Float32Array.from(level) };
    };

    let pt = 0, pa = 0;   // shared with decode_and_merge, as in the Fortran (the SNR adds the data symbols to the sync sums)
    const okList = [];     // channel 0's decoded neighbourhoods this call
    let c1 = null;
    const shift = f => { c1 = twkfreq(c0.re, c0.im, 0, nchunk6, -f); };

    const decodeAndMerge = (cd, ich, ipass, ic, pick) => {
      const start = nint(cd.xdt / DT) + 13 * nss;
      const z = correlatePayload(c1, nchunk6, start, nss, this.tones);
      const dec = tbccDecode(z);
      if (pick) { pick.z = { re: Float32Array.from(z.re), im: Float32Array.from(z.im) }; pick.ladder = dec.rungs.map(r => ({ L: r.L, pool: r.pool, accepted: r.accepted, n: r.candidates.length })); }
      const irx = new Uint8Array(46), pow = new Float64Array(184);
      for (let k = 0; k < 46; k++) { for (let t = 0; t < 4; t++) pow[k * 4 + t] = z.re[k * 4 + t] ** 2 + z.im[k * 4 + t] ** 2; irx[k] = argmax(pow.subarray(k * 4, k * 4 + 4)); }
      cd.decoded = '';
      if (!dec.ok) { if (pick) pick.result = 'no codeword'; return false; }
      const fr = unpackFrame(dec.payload);
      if (!fr.valid) { if (pick) pick.result = 'invalid source'; return false; }
      cd.decoded = fr.text; cd.trailingSep = fr.trailingSep; cd.isLast = fr.eom;
      const chk = tbccEncode(dec.payload).tones;
      let nerr = 0;
      const sp = syncPowers(c1, nchunk6, nint(cd.xdt / DT), nss, this.tones);
      for (let j = 0; j < 13; j++) { if (j >= sp.length) { nerr++; continue; } if (argmax(sp[j]) !== SYNC13[j]) nerr++; }
      for (let k = 0; k < 46; k++) if (chk[k] !== irx[k]) nerr++;
      if (pick) { pick.nsymerrs = nerr; pick.frame = fr.text; pick.L = dec.L; pick.rank = dec.rank; }
      if (nerr > P.MAX_SYMBOL_ERRORS) { cd.decoded = ''; if (pick) pick.result = 'symbol errors'; return false; }
      this.ndecodes++;
      for (let k = 0; k < 46; k++) { pt += pow[k * 4 + chk[k]]; pa += pow[k * 4] + pow[k * 4 + 1] + pow[k * 4 + 2] + pow[k * 4 + 3]; }
      const pn = (pa - pt) / 3; if (pn > 0) cd.snrdb = db(pt / pn);
      cd.tsync = t0 + cd.xdt;
      let dupe = false;
      for (let i = 0; i < cand.length - 1; i++) if (cand[i].decoded === cd.decoded && Math.abs(cand[i].tsync - cd.tsync) < 0.032) dupe = true;
      if (ich !== 0) for (const o of okList) if (Math.abs(cd.f1 - o.f1) < P.FRAME_HISTORY_FREQ_TOLERANCE && Math.abs(cd.tsync - o.tsync) < P.FRAME_HISTORY_TIME_TOLERANCE) dupe = true;
      if (dupe) { if (pick) pick.result = 'duplicate'; return true; }
      const t59 = new Uint8Array(59); t59.set(SYNC13); t59.set(chk, 13);
      subtractFrame(c0, nchunk6, t59, nss, cd.f1, cd.xdt); anySub = true; s0Valid = false;
      if (this.subtracted.length < P.MAX_SUBTRACTED) this.subtracted.push({ f1: cd.f1, tsync: cd.tsync, payload: dec.payload });
      // message assembly
      let pure = this.isRecentFrame(cd), idx = -1, match = false, bestGap = 1;
      if (!pure && this.active.length) {
        let haveWin = false, best = -1, bestDf = 1e30;
        for (let i = 0; i < this.active.length; i++) {
          const r = this.classify(this.active[i], cd, this.nframe6 / FS6); if (!r.match) continue;
          if (r.win) { if (!haveWin) idx = i; haveWin = true; continue; }
          const d = Math.abs(cd.f1 - this.active[i].f1); if (d < bestDf) { bestDf = d; best = i; bestGap = r.gap; }
        }
        if (haveWin) { match = true; pure = true; } else if (best >= 0) { match = true; idx = best; }
      }
      if (!pure && this.known.length < MAX_RECENT_FRAMES) this.known.push({ f1: cd.f1, tsync: cd.tsync, payload: dec.payload });
      let msg = null;
      if (!pure && match) msg = this.appendMessage(idx, cd, bestGap);
      else if (!pure) msg = this.startMessage(cd);
      const ev = { tsync: cd.tsync, f1: cd.f1, xdt: cd.xdt, snr: nint(cd.snrdb - 20), snrdb: cd.snrdb, nsync: cd.nsync, nsymerrs: nerr, ichan: ich, ipass, ic,
        frame: displayText(cd.decoded) || cd.decoded, raw: cd.decoded, eom: cd.isLast, pure, retro: !!interferer, istart, tAvail: fwd ? fwd.tEnd : call.tEnd,
        L: dec.L, rank: dec.rank, z: { re: Float32Array.from(z.re), im: Float32Array.from(z.im) }, messageId: msg ? msg.id : null, message: msg ? displayText(msg.decoded) : displayText(cd.decoded), tones: t59 };
      if (msg) { const m = this.messages.get(msg.id); if (m) m.frames.push(ev); }
      this.events.push(ev);
      if (pick) { pick.result = pure ? 'seen before' : 'decoded'; pick.event = ev; }
      return true;
    };

    const processChannel = (ich, ipass) => {
      const w = chanWin(ich); if (!w) return;
      const { ja, jb } = w;
      let nc0 = 2, floor = P.QSO_SYNC_FLOOR;
      if (ich === 0) nc0 = Math.max(2, Math.min(8, nint(w.fwid / (nfz * DF2))));
      else { floor = P.WIDE_SYNC_FLOOR; if (floor > 0) nc0 = P.WIDE_CANDIDATES; }
      let decodedAny = false;
      if (ich !== 0) for (const o of okList) { const a = Math.max(ja, o.ja), b = Math.min(jb, o.jb); for (let j = a; j <= b; j++) for (let i = 0; i < ncols; i++) s0[S(j, i)] = 0; }
      const jam = Math.max(firstBin, ja - nfzHold), jbm = Math.min(lastBin, jb + nfzHold);
      const mask = new Uint8Array(nbins * ncols);
      for (let j = jam; j <= jbm; j++) for (let i = 0; i < ncols; i++) mask[S(j, i)] = floor > 0 ? (s0[S(j, i)] > floor * level[j - firstBin] ? 1 : 0) : 1;
      const clear = (j1, j2, i1, i2, arr, v) => { for (let j = j1; j <= j2; j++) for (let i = i1; i <= i2; i++) arr[S(j, i)] = v; };
      for (let ic = 1; ic <= nc0; ic++) {
        let jpk = -1, ipk = -1;
        for (;;) {
          // maxloc in column-major order (bin index fastest), first maximum wins
          let best = -Infinity; jpk = -1;
          for (let i = 0; i < ncols; i++) for (let j = jam; j <= jbm; j++) { const q = S(j, i); if (mask[q] && s0[q] > best) { best = s0[q]; jpk = j; ipk = i; } }
          if (jpk < 0) break;
          if (ipk > nstepSearch || jpk < ja || jpk > jb) {
            if (this.trace) call.picks.push({ ich, ipass, ic, j: jpk, istep: ipk, f: jpk * DF2, xdt: ipk * DT * 12, held: true, ratio: s0[S(jpk, ipk)] / level[jpk - firstBin] });
            clear(Math.max(jam, jpk - nfzHold), Math.min(jbm, jpk + nfzHold), Math.max(0, ipk - P.SYNC_EDGE_STEPS), Math.min(nstepSurface, ipk + P.SYNC_EDGE_STEPS), mask, 0);
            continue;
          }
          clear(Math.max(jam, jpk + 1 - nfz), Math.min(jbm, jpk + 1 + nfz), Math.max(0, ipk + 1 - ntz), Math.min(nstepSurface, ipk + 1 + ntz), mask, 0);
          if (ich !== 0) clear(Math.max(ja, jpk + 1 - nfz), Math.min(jb, jpk + 1 + nfz), Math.max(0, ipk + 1 - ntz), Math.min(nstepSurface, ipk + 1 + ntz), s0, 0);
          break;
        }
        if (jpk < 0) break;
        if (cand.length >= P.MAXCAND) break;
        const cd = { xdt: ipk * DT * 12, f1: jpk * DF2, decoded: '', tsync: 0, snrdb: -99.9 };
        cand.push(cd);
        const pick = this.trace ? { ich, ipass, ic, j: jpk, istep: ipk, f: cd.f1, xdt: cd.xdt, held: false, ratio: s0[S(jpk, ipk)] / level[jpk - firstBin] } : null;
        if (pick) call.picks.push(pick);
        shift(cd.f1);
        const sp = syncPowers(c1, nchunk6, nint(cd.xdt / DT), nss, this.tones);
        pt = 0; pa = 0; let nsync = 0;
        for (let j = 0; j < sp.length; j++) { if (argmax(sp[j]) === SYNC13[j]) nsync++; pt += sp[j][SYNC13[j]]; pa += sp[j][0] + sp[j][1] + sp[j][2] + sp[j][3]; }
        let snrdb = -99.9; const pn = (pa - pt) / 3; if (pn > 0) snrdb = db(pt / pn);
        cd.snrdb = snrdb; cd.nsync = nsync;
        const gate = ich === 0 ? nsync >= P.QSO_GATE_NSYNC && snrdb >= this.smin : nsync >= P.WIDE_GATE_NSYNC && snrdb >= P.WIDE_GATE_SNR;
        if (pick) { pick.nsync = nsync; pick.snrdb = snrdb; pick.gate = gate; pick.sync = sp.map(p => Array.from(p)); }
        if (!gate) { if (pick) pick.result = 'gate'; continue; }
        if (P.GATE_FIRST && P.COHERENT_PEAKUP) {
          const r = peakupCoherent(c0, nchunk6, nss, this.csync, cd.xdt, cd.f1); cd.xdt = r.xdt; cd.f1 = r.f1;
          if (pick) { pick.fRef = cd.f1; pick.xdtRef = cd.xdt; }
          shift(cd.f1);
        }
        const ok = decodeAndMerge(cd, ich, ipass, ic, pick);
        if (ok && ich === 0 && okList.length < 16) okList.push({ ja: nint(cd.f1 / DF2) - nfz, jb: nint(cd.f1 / DF2) + nfz, f1: cd.f1, tsync: cd.tsync });
        if (ok) decodedAny = true;
      }
      if (!decodedAny) {
        // sticky-sync retry: a message whose next frame is due now gets one blind decode at its predicted place
        for (const am of this.active) {
          if (am.f1 < w.fc - w.fwid || am.f1 > w.fc + w.fwid) continue;
          if (Math.abs((t0 - am.tsync) - this.nframe6 / FS6) > 0.1) continue;
          const xr = am.tsync + this.nframe6 / FS6 - t0; if (xr < 0) continue;
          if (cand.length >= P.MAXCAND) break;
          const cd = { xdt: xr, f1: am.f1, decoded: '', tsync: 0, snrdb: -99.9, nsync: -1 };
          cand.push(cd); shift(cd.f1);
          const pick = this.trace ? { ich, ipass, ic: -1, f: cd.f1, xdt: cd.xdt, held: false, sticky: true } : null;
          if (pick) call.picks.push(pick);
          const ok = decodeAndMerge(cd, ich, ipass, -1, pick);
          if (ok && ich === 0 && okList.length < 16) okList.push({ ja: nint(cd.f1 / DF2) - nfz, jb: nint(cd.f1 / DF2) + nfz, f1: cd.f1, tsync: cd.tsync });
          break;
        }
      }
    };

    // Phase A: channel 0 (the QSO window) gets first claim, up to two passes
    for (let ipass = 1; ipass <= 2; ipass++) { if (ipass === 2 && !anySub) break; if (!s0Valid) buildS0(); processChannel(0, ipass); }
    // Phase B: the two wide channels
    anySub = false;
    for (let ipass = 1; ipass <= 2; ipass++) { if (ipass === 2 && !anySub) break; if (!s0Valid) buildS0(); for (let ich = 1; ich <= 2; ich++) processChannel(ich, ipass); s0Valid = false; }
    return call;
  }
}

/**
 * The 46 x 4 correlations of one frame straight from the audio, with no pre-subtraction: for the
 * trellis page's "what if the frequency were off" experiments. istart is 1-based as elsewhere.
 */
export function frameCorrelations(x, istart, xdt, f1, nsps = 384) {
  const nchunk = 59 * nsps * 5 / 4, nss = nsps / 2, nchunk6 = nchunk / 2;
  const nana = 2 ** nint(Math.log(nchunk) / Math.log(2) + 0.5);
  const c0 = ana64a(x, istart - 1, nchunk, nana); c0.re.fill(0, nchunk6); c0.im.fill(0, nchunk6);
  const c1 = twkfreq(c0.re, c0.im, 0, nchunk6, -f1);
  return correlatePayload(c1, nchunk6, nint(xdt / DT) + 13 * nss, nss, makeTones(nss));
}
