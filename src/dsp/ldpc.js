// LDPC(174,91) belief-propagation decoder + encoder + CRC-14. Port of wsjtr ft8core (decode174_91.f90).
import { MN, GENERATOR_HEX } from './ldpc_tables.js';

export const N = 174, K = 91, M = 83;

// Tanner graph
export const graph = (() => {
  const checkBits = Array.from({ length: M }, () => []);
  MN.forEach((checks, bit) => checks.forEach(c => checkBits[c - 1].push(bit)));
  const edgeBit = [], checkStart = new Int32Array(M), checkEnd = new Int32Array(M);
  let idx = 0;
  checkBits.forEach((bits, j) => { checkStart[j] = idx; for (const b of bits) { edgeBit.push(b); idx++; } checkEnd[j] = idx; });
  const bitEdges = Array.from({ length: N }, () => []);
  edgeBit.forEach((b, e) => bitEdges[b].push(e));
  const edgeCheck = new Int32Array(edgeBit.length);
  for (let j = 0; j < M; j++) for (let e = checkStart[j]; e < checkEnd[j]; e++) edgeCheck[e] = j;
  return { checkBits, edgeBit, edgeCheck, checkStart, checkEnd, bitEdges, nEdges: edgeBit.length };
})();

export function crc14(bits77) {
  const bytes = new Uint8Array(10);
  for (let i = 0; i < 77; i++) if (bits77[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  let crc = 0;
  for (const byte of [...bytes, 0, 0]) for (let b = 7; b >= 0; b--) { crc = ((crc << 1) | ((byte >> b) & 1)) & 0xffff; if (crc & 0x4000) crc ^= 0x2757; }
  return crc & 0x3fff;
}
export function appendCrc(bits77) {
  const out = new Uint8Array(91); out.set(bits77.subarray ? bits77.subarray(0, 77) : bits77.slice(0, 77));
  const c = crc14(bits77); for (let i = 0; i < 14; i++) out[77 + i] = (c >> (13 - i)) & 1;
  return out;
}
export function checkCrc(msg91) {
  const c = crc14(msg91); for (let i = 0; i < 14; i++) if (msg91[77 + i] !== ((c >> (13 - i)) & 1)) return false; return true;
}

const GEN = GENERATOR_HEX.map(h => { const bits = []; for (const ch of h) { const v = parseInt(ch, 16); for (let s = 3; s >= 0; s--) bits.push((v >> s) & 1); } return bits.slice(0, K); });
export function ldpcEncode(msg91) {
  const cw = new Uint8Array(N); cw.set(msg91);
  for (let r = 0; r < M; r++) { let p = 0; for (let j = 0; j < K; j++) p ^= (GEN[r][j] & msg91[j]); cw[K + r] = p; }
  return cw;
}

export function unsatisfiedChecks(hard) {
  const bad = [];
  graph.checkBits.forEach((bits, j) => { let p = 0; for (const b of bits) p ^= hard[b]; if (p) bad.push(j); });
  return bad;
}

/**
 * Belief propagation with full per-iteration trace (for visualization).
 * llr: Float64Array(174), convention: NEGATIVE => bit 1 (i.e. WSJT-X llr already sign-flipped, as in jt9r).
 * opts: { maxIter (30), earlyStop (true) }
 * Returns { ok, bits77, iterations:[{iter, zn, hard, unsat:[checkIdx], nUnsat, tov(copy)}], reason }
 */
export function bpDecodeTrace(llr, opts = {}) {
  const maxIter = opts.maxIter ?? 30, earlyStop = opts.earlyStop ?? true;
  const g = graph, nE = g.nEdges;
  const tov = new Float64Array(nE), toc = new Float64Array(nE), sign = new Float64Array(nE), logAbs = new Float64Array(nE);
  const zn = new Float64Array(N), hard = new Uint8Array(N);
  const iterations = [];
  let nclast = 0, ncnt = 0;
  for (let iter = 0; iter <= maxIter; iter++) {
    for (let b = 0; b < N; b++) { let s = 0; for (const e of g.bitEdges[b]) s += tov[e]; zn[b] = llr[b] + s; }
    for (let i = 0; i < N; i++) hard[i] = zn[i] < 0 ? 1 : 0;
    const unsat = unsatisfiedChecks(hard);
    iterations.push({ iter, zn: Float64Array.from(zn), hard: Uint8Array.from(hard), unsat, nUnsat: unsat.length, tov: Float64Array.from(tov) });
    if (unsat.length === 0) {
      const msg91 = hard.slice(0, K);
      if (checkCrc(msg91)) return { ok: true, bits77: msg91.slice(0, 77), codeword: Uint8Array.from(hard), iterations, reason: 'parity + CRC ok' };
      return { ok: false, iterations, reason: 'all parity checks satisfied but CRC-14 failed (wrong codeword)' };
    }
    if (iter > 0) {
      if (unsat.length - nclast < 0) ncnt = 0; else ncnt++;
      if (earlyStop && ncnt >= 5 && iter >= 10 && unsat.length > 15) return { ok: false, iterations, reason: `early stop at iteration ${iter}: no improvement for 5 iterations with ${unsat.length} > 15 unsatisfied checks` };
    }
    nclast = unsat.length;
    if (iter >= maxIter) break;
    for (let e = 0; e < nE; e++) toc[e] = zn[g.edgeBit[e]] - tov[e];
    for (let e = 0; e < nE; e++) { let t = Math.tanh(toc[e] / 2); t = Math.max(-0.999999, Math.min(0.999999, t)); sign[e] = t >= 0 ? 1 : -1; logAbs[e] = Math.log(Math.max(Math.abs(t), 1e-30)); }
    for (let j = 0; j < M; j++) {
      const s = g.checkStart[j], en = g.checkEnd[j];
      let ts = 1, tl = 0; for (let e = s; e < en; e++) { ts *= sign[e]; tl += logAbs[e]; }
      for (let e = s; e < en; e++) { let prod = ts * sign[e] * Math.exp(tl - logAbs[e]); prod = Math.max(-0.999999, Math.min(0.999999, prod)); tov[e] = 2 * Math.atanh(prod); }
    }
  }
  return { ok: false, iterations, reason: `no convergence in ${maxIter} iterations` };
}
