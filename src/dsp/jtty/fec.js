// JTTY forward error correction: CRC-12, a tail-biting rate-1/2 K=10 convolutional code, and the
// list-Viterbi (WAVA) decoder with its L = 1, 2, 4 coherent ladder.
// Ports of WSJT-X 3.2 lib/jtty/tbcc.f90 (tbcc_encode, encode_crc12), jtty_tbcc_code_profile.f90
// (profile 1167/1545/80F), jtty_fec_mod.f90 (the sync sequence), jtty_tbcc_list_decoder.f90
// (jtty_tbcc_list_wava_optimized) and jtty_tbcc_decoder.f90 (the ladder and its acceptance rule).
//
// Bit arrays are 0-based: info[0..33] is the payload (index 32 the reserved bit, 33 EOM),
// info[34..45] the CRC.

export const SYNC13 = [0, 2, 2, 3, 0, 0, 3, 2, 1, 3, 1, 2, 0];   // is13
export const PAYLOAD_BITS = 34, CRC_BITS = 12, K = 46, NU = 9, NSTATES = 512;
export const G0 = 0o1167, G1 = 0o1545, CRC_POLY = 0x80f;
export const RESERVED_BIT = 32;          // 0-based (Fortran bit 33)
const REG_MASK = 0x3ff, STATE_MASK = 0x1ff;
export const COHERENT_LENGTHS = [1, 2, 4];
export const PER_STATE_WIDTH = 4, WRAPS = 2, MAX_HYPOTHESES = 4;

const parity = v => { v ^= v >> 8; v ^= v >> 4; v ^= v >> 2; v ^= v >> 1; return v & 1; };

/** jtty_tbcc_transition: next state and Gray-coded tone (b0 b1: 00 01 11 10 -> 0 1 2 3). */
export function transition(state, bit) {
  const reg = ((state << 1) | bit) & REG_MASK;
  const b0 = parity(reg & G0), b1 = parity(reg & G1);
  return { next: reg & STATE_MASK, tone: 2 * b0 + (b0 ^ b1), b0, b1, reg };
}
const NEXT = new Int32Array(NSTATES * 2), TONE = new Int32Array(NSTATES * 2);
for (let s = 0; s < NSTATES; s++) for (let b = 0; b < 2; b++) { const t = transition(s, b); NEXT[s * 2 + b] = t.next; TONE[s * 2 + b] = t.tone; }

/** CRC-12 remainder register over bits (poly 0x80F, MSB first). */
export function crc12(bits, n = bits.length) {
  let r = 0;
  for (let i = 0; i < n; i++) { r ^= bits[i] << 11; r = (r & 0x800) ? ((r << 1) ^ CRC_POLY) : (r << 1); r &= 0xfff; }
  return r;
}
/** encode_crc12: 34 payload bits -> 46 information bits. */
export function appendCrc12(payload) {
  const out = new Uint8Array(K); out.set(payload.subarray ? payload.subarray(0, PAYLOAD_BITS) : payload.slice(0, PAYLOAD_BITS));
  const r = crc12(out, PAYLOAD_BITS);
  for (let i = 0; i < CRC_BITS; i++) out[PAYLOAD_BITS + i] = (r >> (CRC_BITS - 1 - i)) & 1;
  return out;
}
export const crcValid = info => crc12(info, K) === 0;
/** Tail-biting start state: the last nu information bits. */
export function tailState(info) { let s = 0; for (let i = K - NU; i < K; i++) s = ((s << 1) | info[i]) & STATE_MASK; return s; }

/**
 * tbcc_encode: 34 payload bits -> { info (46 bits), tones (46), coded (92 bits), states (47) }.
 * The register is preloaded with the word's own last 9 bits, so the path ends where it began.
 */
export function tbccEncode(payload) {
  const info = payload.length === K ? Uint8Array.from(payload) : appendCrc12(payload);
  return encodeInfo(info);
}
export function encodeInfo(info) {
  let s = tailState(info);
  const tones = new Uint8Array(K), coded = new Uint8Array(2 * K), states = new Int32Array(K + 1);
  states[0] = s;
  for (let t = 0; t < K; t++) { const x = transition(s, info[t]); tones[t] = x.tone; coded[2 * t] = x.b0; coded[2 * t + 1] = x.b1; s = x.next; states[t + 1] = s; }
  return { info, tones, coded, states };
}
/** genjtty_frames: one frame's 59 channel tones = 13 sync + 46 data. */
export function frameTones(payload) { const { tones } = tbccEncode(payload); const out = new Uint8Array(59); out.set(SYNC13); out.set(tones, 13); return out; }

// ---- the list-Viterbi decoder (jtty_tbcc_list_wava_optimized) ----
//
// Each state keeps up to `width` survivors. A survivor is its metric, the state it started from
// in this wrap (origin), and the information bits so far as a 46-bit "lexical" integer (bit 1 in
// the top position), so ordering by (metric desc, origin asc, lex asc) is the Fortran's packed-key
// ordering. After the last wrap only paths that end where they started are tail-biting codewords.

const plans = new Map();
function plan(L) {
  if (plans.has(L)) return plans.get(L);
  const nblk = Math.ceil(K / L), starts = [], lens = [], bcount = [], eoff = []; let ecount = 0;
  for (let b = 0; b < nblk; b++) { const st = b * L, len = Math.min(L, K - st); starts.push(st); lens.push(len); bcount.push(1 << len); eoff.push(ecount); ecount += 1 << (2 * len); }
  // branch tables: end state and tone-sequence index for each (state, word) per block
  const endSt = [], seqIdx = [], ident = [];
  for (let b = 0; b < nblk; b++) {
    const len = lens[b], nb = 1 << len, es = new Int32Array(NSTATES * nb), si = new Int32Array(NSTATES * nb), id = new Float64Array(nb);
    for (let w = 0; w < nb; w++) {
      let lex = 0; for (let o = 0; o < len; o++) if ((w >> (len - 1 - o)) & 1) lex += 2 ** (K - 1 - (starts[b] + o));
      id[w] = lex;
      for (let s = 0; s < NSTATES; s++) {
        let st = s, tw = 0;
        for (let o = 0; o < len; o++) { const bit = (w >> (len - 1 - o)) & 1; tw = 4 * tw + TONE[st * 2 + bit]; st = NEXT[st * 2 + bit]; }
        es[s * nb + w] = st; si[s * nb + w] = eoff[b] + tw;
      }
    }
    endSt.push(es); seqIdx.push(si); ident.push(id);
  }
  const p = { L, nblk, starts, lens, bcount, eoff, ecount, endSt, seqIdx, ident };
  plans.set(L, p); return p;
}

/** precompute_sequence_energies: |sum of the block's correlations along a tone sequence|^2 / len. */
function sequenceEnergies(p, zr, zi) {
  const e = new Float64Array(p.ecount);
  for (let b = 0; b < p.nblk; b++) {
    const st = p.starts[b], len = p.lens[b], n = 1 << (2 * len);
    for (let w = 0; w < n; w++) {
      let sr = 0, si = 0;
      for (let o = 0; o < len; o++) { const tone = (w >> (2 * (len - 1 - o))) & 3, k = (st + o) * 4 + tone; sr += zr[k]; si += zi[k]; }
      e[p.eoff[b] + w] = (sr * sr + si * si) / len;
    }
  }
  return e;
}

const lexToBits = lex => { const bits = new Uint8Array(K); for (let i = 0; i < K; i++) { const p = 2 ** (K - 1 - i); if (lex >= p) { bits[i] = 1; lex -= p; } } return bits; };
/** jtty_tbcc_candidate_identity: bit 1 is the least significant. */
const identityOf = bits => { let v = 0; for (let i = K - 1; i >= 0; i--) v = v * 2 + bits[i]; return v; };

/** Score a complete word with single-frame coherent blocks of length L (score_planned_identity). */
export function cleanMetric(bits, zr, zi, L) {
  const p = plan(L), e = sequenceEnergies(p, zr, zi);
  let s = tailState(bits); const s0 = s; let m = 0;
  for (let b = 0; b < p.nblk; b++) {
    let w = 0; for (let o = 0; o < p.lens[b]; o++) w = 2 * w + bits[p.starts[b] + o];
    const nb = p.bcount[b]; m += e[p.seqIdx[b][s * nb + w]]; s = p.endSt[b][s * nb + w];
  }
  return { metric: m, closed: s === s0 };
}

/**
 * One list-WAVA run at coherent length L.
 * z: { re, im } Float64Array(46*4), z[k*4+tone] = correlation of data symbol k with that tone.
 * opts: width (1-4 survivors per state), wraps (1-2), hypotheses (1-4), trace (collect per-block
 * best metrics per state for display).
 * Returns { candidates: [{ bits, identity, clean, wava, start, crc }], pool, trace }.
 */
export function listWava(z, L, opts = {}) {
  const width = opts.width || PER_STATE_WIDTH, wraps = opts.wraps || WRAPS, H = opts.hypotheses || MAX_HYPOTHESES;
  const p = plan(L), E = sequenceEnergies(p, z.re, z.im);
  let ordered = true; for (let i = 0; i < E.length; i++) if (!Number.isFinite(E[i])) { ordered = false; break; }
  const NS = NSTATES, W = width;
  let pm = new Float64Array(NS * W).fill(-Infinity), po = new Int32Array(NS * W), pl = new Float64Array(NS * W), pv = new Uint8Array(NS * W);
  let cm = new Float64Array(NS * W), co = new Int32Array(NS * W), cl = new Float64Array(NS * W), cv = new Uint8Array(NS * W);
  for (let s = 0; s < NS; s++) { pv[s * W] = 1; pm[s * W] = 0; po[s * W] = s; pl[s * W] = 0; }
  const trace = opts.trace ? { best: [], L, nblk: p.nblk, wraps } : null;
  // selected(1..W) for one end state
  const sm = new Float64Array(W), so = new Int32Array(W), sl = new Float64Array(W), sv = new Uint8Array(W);
  const precedes = (m, o, l, k) => m > sm[k] || (m === sm[k] && (o < so[k] || (o === so[k] && l < sl[k])));
  for (let wrap = 0; wrap < wraps; wrap++) {
    // reset_packed_frame_identity: a new wrap forgets where its paths came from, keeps their metrics
    for (let i = 0; i < NS * W; i++) if (pv[i]) { po[i] = Math.floor(i / W); pl[i] = 0; }
    for (let b = 0; b < p.nblk; b++) {
      const nb = p.bcount[b], stride = NS / nb, es = p.seqIdx[b], id = p.ident[b], dedupe = b === 0;
      for (let end = 0; end < NS; end++) {
        sv.fill(0);
        const w = end & (nb - 1), bid = id[w];
        for (let s = Math.floor(end / nb); s < NS; s += stride) {
          const bm = E[es[s * nb + w]];
          for (let r = 0; r < W; r++) {
            const i = s * W + r; if (!pv[i]) continue;
            const m = pm[i] + bm;
            if (sv[W - 1] && m < sm[W - 1]) { if (ordered) break; continue; }
            const o = po[i], l = pl[i] + bid;
            // insert_packed_survivor
            if (dedupe) {
              let skip = false;
              for (let k = 0; k < W; k++) {
                if (!sv[k] || so[k] !== o || sl[k] !== l) continue;
                if (m <= sm[k]) { skip = true; break; }
                for (let q = k; q < W - 1; q++) { sm[q] = sm[q + 1]; so[q] = so[q + 1]; sl[q] = sl[q + 1]; sv[q] = sv[q + 1]; }
                sv[W - 1] = 0; break;
              }
              if (skip) continue;
            }
            let ins = W;
            for (let k = 0; k < W; k++) if (!sv[k] || precedes(m, o, l, k)) { ins = k; break; }
            if (ins >= W) continue;
            for (let k = W - 1; k > ins; k--) { sm[k] = sm[k - 1]; so[k] = so[k - 1]; sl[k] = sl[k - 1]; sv[k] = sv[k - 1]; }
            sm[ins] = m; so[ins] = o; sl[ins] = l; sv[ins] = 1;
          }
        }
        for (let k = 0; k < W; k++) { const j = end * W + k; cm[j] = sm[k]; co[j] = so[k]; cl[j] = sl[k]; cv[j] = sv[k]; }
      }
      [pm, cm] = [cm, pm]; [po, co] = [co, po]; [pl, cl] = [cl, pl]; [pv, cv] = [cv, pv];
      if (trace) { const best = new Float32Array(NS); for (let s = 0; s < NS; s++) best[s] = pv[s * W] ? pm[s * W] : -Infinity; trace.best.push(best); }
    }
  }
  // the pool: closed paths, one entry per distinct word, scored with a clean single-frame metric
  const pool = [], seen = new Map();
  for (let s = 0; s < NS; s++) for (let r = 0; r < W; r++) {
    const i = s * W + r; if (!pv[i] || po[i] !== s) continue;
    const lex = pl[i];
    if (seen.has(lex)) {
      const c = pool[seen.get(lex)];
      if (pm[i] > c.wava || (!(pm[i] < c.wava) && s < c.start)) { c.wava = pm[i]; c.start = s; }
      continue;
    }
    const bits = lexToBits(lex);
    const cmx = cleanMetric(bits, z.re, z.im, L);
    seen.set(lex, pool.length);
    pool.push({ bits, identity: identityOf(bits), start: s, wava: pm[i], clean: cmx.metric, crc: crcValid(bits) });
  }
  pool.sort((a, b) => (b.clean - a.clean) || (a.identity - b.identity) || (a.start - b.start) || (b.wava - a.wava));
  return { candidates: pool.slice(0, H), pool: pool.length, trace };
}

/**
 * decode_rung's acceptance walk: the first CRC-valid hypothesis, stopping at an all-zero payload
 * and skipping (not stopping at) a word with the reserved bit set.
 */
export function acceptRung(cands) {
  for (let r = 0; r < cands.length; r++) {
    const c = cands[r];
    c.verdict = !c.crc ? 'CRC fail' : null;
    if (!c.crc) continue;
    let zero = true; for (let i = 0; i < PAYLOAD_BITS; i++) if (c.bits[i]) { zero = false; break; }
    if (zero) { c.verdict = 'all-zero: stop'; return -1; }
    if (c.bits[RESERVED_BIT]) { c.verdict = 'reserved bit set'; continue; }
    c.verdict = 'accepted'; return r;
  }
  return -1;
}

/**
 * jtty_tbcc_decode: L=1, then L=2, then L=4; the first rung that accepts wins.
 * Returns { ok, payload (34 bits), info (46), L, rank, rungs: [{ L, candidates, pool, accepted }] }.
 * opts.lengths overrides the ladder (for the trellis page); opts.* also go to listWava.
 */
export function tbccDecode(z, opts = {}) {
  const rungs = [];
  for (const L of opts.lengths || COHERENT_LENGTHS) {
    const r = listWava(z, L, opts); const acc = acceptRung(r.candidates);
    rungs.push({ L, candidates: r.candidates, pool: r.pool, accepted: acc, trace: r.trace });
    if (acc >= 0) { const info = r.candidates[acc].bits; return { ok: true, payload: info.slice(0, PAYLOAD_BITS), info, L, rank: acc + 1, rungs }; }
  }
  return { ok: false, rungs };
}
