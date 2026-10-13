// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Glue: run the whole per-candidate decode with a full trace for visualization.
import { Downsampler } from './downsample.js';
import { fineSync, timeRefine, extractSymbolBins, syncQuality, hardTones } from './finesync.js';
import { llrPasses } from './llr.js';
import { bpDecodeTrace, appendCrc, ldpcEncode } from './ldpc.js';
import { decodeBpThenOsd } from './osd.js';
import { applyApCq, applyApMyCall } from './ap.js';
import { unpack77, messageOk } from './unpack77.js';
import { GRAY_MAP, COSTAS } from './constants.js';
import { FS2 } from './downsample.js';

export class DecodeContext {
  constructor(audio) { this.audio = audio; this.ds = new Downsampler(audio); }
}

/** Expected 79-tone sequence for a 77-bit message (re-encode). */
export function tonesFromBits77(bits77) {
  const cw = ldpcEncode(appendCrc(bits77));
  const tones = new Uint8Array(79);
  let k = 0;
  for (let s = 0; s < 79; s++) {
    if (s < 7) tones[s] = COSTAS[s]; else if (s >= 36 && s < 43) tones[s] = COSTAS[s - 36]; else if (s >= 72) tones[s] = COSTAS[s - 72];
    else { const v = (cw[k] << 2) | (cw[k + 1] << 1) | cw[k + 2]; k += 3; tones[s] = GRAY_MAP[v]; }
  }
  return { tones, codeword: cw };
}

/**
 * Decode one candidate the way wsjt_ft8.rs decode_candidate_wsjt does.
 * opts: { dtOffset 0.5, maxIter 30, earlyStop true, depth 3 (1: BP only, 2: +OSD order 1, 3: +OSD order 2 + AP), osdMode 'default',
 *   mycallBits (Float32Array 29, WSJT-X sign convention) | null, ap (true at depth 3), passOrder ['a','b','c','d','e'], metrics ['amp','pow'],
 *   stopAtFirst true, dtNudge 0 (baseband samples), freqNudge 0 (Hz), lite false (drop per-iteration BP traces) }
 * Returns a trace object with every intermediate.
 */
export function decodeCandidate(ctx, cand, opts = {}) {
  const dtOffset = opts.dtOffset ?? 0.5, depth = opts.depth ?? 3, maxIter = opts.maxIter ?? 30;
  const cd0 = ctx.ds.downsample(cand.freq);
  const fs = fineSync(cd0, cand.dt, dtOffset);
  const freq = cand.freq + fs.delf + (opts.freqNudge || 0);
  const cd1 = ctx.ds.downsample(freq);
  const tr = timeRefine(cd1, fs.ibest);
  const ibest2 = tr.ibest2 + (opts.dtNudge || 0);
  const dt = (ibest2 - 1) / FS2 - dtOffset;
  const bins = extractSymbolBins(cd1, ibest2);
  const sq = syncQuality(bins);
  const hard = hardTones(bins);
  const allowAmp = depth <= 2 ? sq.nsync > 8 : sq.nsync > 6;
  const allowPow = depth <= 2 ? sq.nsync > 8 : sq.nsync > 7;
  const llr = { amp: llrPasses(bins, false), pow: llrPasses(bins, true) };
  const attempts = [];
  let result = null;
  const passOrder = opts.passOrder ?? ['a', 'b', 'c', 'd', 'e'];
  const metrics = opts.metrics ?? ['amp', 'pow'];
  const allowed = m => m === 'amp' ? allowAmp : allowPow;

  // One LDPC attempt on a jt9r-convention LLR vector (negative => bit 1). Returns the attempt record.
  const attempt = (l, meta) => {
    const bp = bpDecodeTrace(l, { maxIter, earlyStop: opts.earlyStop ?? true });
    const att = { ...meta, llr: l, bp, ok: false, how: null };
    let bits77 = null;
    if (bp.ok) { bits77 = bp.bits77; att.how = 'bp'; }
    else if (depth >= 2) {
      const o = decodeBpThenOsd(l, maxIter, depth, opts.osdMode ?? 'default');
      att.osd = { attempts: o.osdAttempts, trace: o.osdTrace, source: o.osdSource };
      if (o.ok) { bits77 = o.bits77; att.how = 'osd'; }
    }
    if (bits77) {
      const un = unpack77(bits77);
      if (un && messageOk(bits77, un.text)) {
        const { tones, codeword } = tonesFromBits77(bits77);
        let hardErrors = 0; for (let i = 0; i < 174; i++) if ((l[i] < 0 ? 1 : 0) !== codeword[i]) hardErrors++;
        att.hardErrors = hardErrors; att.message = un; att.tones = tones; att.codeword = codeword; att.bits77 = bits77;
        if (hardErrors <= 36) att.ok = true; else att.reject = `${hardErrors} hard errors > 36`;
      } else att.reject = un ? 'message failed sanity gate' : 'unpack failed';
    }
    if (opts.lite) att.bp = { ok: bp.ok, reason: bp.reason, nIter: bp.iterations.length - 1, iterations: [] };
    attempts.push(att);
    return att;
  };
  const flip = v => Float64Array.from(v, x => -x);
  const stop = opts.stopAtFirst ?? true;

  outer: {
    for (const metric of metrics) {
      if (!allowed(metric)) { attempts.push({ metric, skipped: true, reason: `sync gate: nsync=${sq.nsync}` }); continue; }
      for (const pass of passOrder) {
        const a = attempt(flip(llr[metric][pass]), { metric, pass, ap: 0 });
        if (a.ok) { result = result || a; if (stop) break outer; }
      }
    }
    // A-priori passes (depth 3): CQ, then MyCall, on LLR sets a and c, amp then pow.
    if (depth >= 3 && (opts.ap ?? true)) {
      const apKinds = [{ ap: 1, fn: l => applyApCq(l) }]; if (opts.mycallBits) apKinds.push({ ap: 2, fn: l => applyApMyCall(l, opts.mycallBits) });
      for (const kind of apKinds) for (const metric of metrics) {
        if (!allowed(metric)) continue;
        for (const pass of ['a', 'c']) {
          const l = kind.fn(flip(llr[metric][pass]));
          const a = attempt(l, { metric, pass, ap: kind.ap });
          if (a.ok) { result = result || a; if (stop) break outer; }
        }
      }
    }
  }
  return { cand, cd0, cd1, fineSync: fs, timeRefine: tr, ibest2, freq, dt, bins, syncQuality: sq, hardTones: hard, allowAmp, allowPow, llr, attempts, result, snrEstimate: snrEstimate(bins, result ? result.tones : hard) };
}

/** Rough SNR (dB in 2500 Hz) from tone vs off-tone power, like ft8b's xsig/xnoi path (not the baseline path wsjtr reports). */
export function snrEstimate(bins, tones) {
  let xsig = 0, xnoi = 0;
  for (let i = 0; i < 79; i++) { const t = tones[i], k = i * 8; const p = (tt) => bins.re[k + tt] ** 2 + bins.im[k + tt] ** 2; xsig += p(t); xnoi += p((t + 4) % 7); }
  const arg = xsig / Math.max(xnoi, 1e-12) - 1; return arg > 0.1 ? 10 * Math.log10(arg) - 27 : -30;
}
