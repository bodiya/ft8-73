// Ordered-statistics decoding (OSD) for the FT8 (174,91) code, plus BP-with-zsum and the BP→OSD hybrid.
// Port of wsjtr ft8core osd.rs / ldpc_decode.rs bp_decode_with_zsum_saves (WSJT-X osd174_91.f90, decode174_91.f90).
// Sign convention (same as ldpc.js): NEGATIVE LLR => bit 1.
import { graph, N, K, M, checkCrc, ldpcEncode, unsatisfiedChecks } from './ldpc.js';

/** OSD strategy parameters (mirrors OsdParams in osd.rs). */
export function osdParamsFromNdeep(ndeep) {
  switch (ndeep) {
    case 0: return { nord: 0, npre1: false, nt: 0, ntheta: 0, poolSize: 0 };
    case 1: return { nord: 1, npre1: false, nt: 40, ntheta: 12, poolSize: K };
    case 2: return { nord: 1, npre1: true, nt: 40, ntheta: 10, poolSize: K };
    case 3: return { nord: 1, npre1: true, nt: 40, ntheta: 12, poolSize: K };
    case 4: return { nord: 2, npre1: true, nt: 40, ntheta: 12, poolSize: K };
    case 5: return { nord: 3, npre1: true, nt: 40, ntheta: 12, poolSize: K };
    default: return { nord: 4, npre1: true, nt: 95, ntheta: 12, poolSize: K };
  }
}
/** wsjtr depth + mode -> OSD params. mode: 'default' | 'deep' | 'fast'. */
export function osdParamsFromDepth(depth, mode = 'default') {
  if (depth <= 1) return osdParamsFromNdeep(0);
  if (depth === 2) return osdParamsFromNdeep(1);
  if (mode === 'deep') return { nord: 2, npre1: true, nt: 40, ntheta: 10, poolSize: K };
  if (mode === 'fast') return osdParamsFromNdeep(2);
  return { nord: 2, npre1: false, nt: 0, ntheta: 0, poolSize: 36 };
}

// Systematic generator rows: row i = codeword for message e_i (identity in cols 0..K-1, parity K..N-1).
const GEN_ROWS = (() => {
  const rows = [];
  for (let i = 0; i < K; i++) { const m = new Uint8Array(K); m[i] = 1; rows.push(ldpcEncode(m)); }
  return rows;
})();

/**
 * BP with zsum snapshots (WSJT-X decode174_91). Returns { ok, bits77, codeword, saves, iterations(count), reason }.
 * saves[k] = accumulated zsum after iteration k+1 (k < maxSaves).
 */
export function bpWithZsum(llr, maxIter = 30, maxSaves = 2) {
  const g = graph, nE = g.nEdges;
  const tov = new Float64Array(nE), toc = new Float64Array(nE), sign = new Float64Array(nE), logAbs = new Float64Array(nE);
  const zn = new Float64Array(N), zsum = new Float64Array(N), hard = new Uint8Array(N);
  const saves = []; let nclast = 0, ncnt = 0;
  for (let iter = 0; iter <= maxIter; iter++) {
    for (let b = 0; b < N; b++) { let s = 0; for (const e of g.bitEdges[b]) s += tov[e]; zn[b] = llr[b] + s; }
    for (let i = 0; i < N; i++) zsum[i] += zn[i];
    if (iter > 0 && iter <= maxSaves && saves.length < maxSaves) saves.push(Float64Array.from(zsum));
    for (let i = 0; i < N; i++) hard[i] = zn[i] < 0 ? 1 : 0;
    const nUnsat = unsatisfiedChecks(hard).length;
    if (nUnsat === 0) {
      const msg91 = hard.slice(0, K);
      if (checkCrc(msg91)) return { ok: true, bits77: msg91.slice(0, 77), codeword: Uint8Array.from(hard), saves, iterations: iter, reason: 'parity + CRC ok' };
    }
    if (iter > 0) { if (nUnsat - nclast < 0) ncnt = 0; else ncnt++; if (ncnt >= 5 && iter >= 10 && nUnsat > 15) return { ok: false, saves, iterations: iter, reason: 'early stop' }; }
    nclast = nUnsat;
    if (iter >= maxIter) break;
    for (let e = 0; e < nE; e++) toc[e] = zn[g.edgeBit[e]] - tov[e];
    for (let e = 0; e < nE; e++) { let t = Math.tanh(toc[e] / 2); t = Math.max(-0.999999, Math.min(0.999999, t)); sign[e] = t >= 0 ? 1 : -1; logAbs[e] = Math.log(Math.max(Math.abs(t), 1e-30)); }
    for (let j = 0; j < M; j++) {
      const s = g.checkStart[j], en = g.checkEnd[j]; let ts = 1, tl = 0;
      for (let e = s; e < en; e++) { ts *= sign[e]; tl += logAbs[e]; }
      for (let e = s; e < en; e++) { let prod = ts * sign[e] * Math.exp(tl - logAbs[e]); prod = Math.max(-0.999999, Math.min(0.999999, prod)); tov[e] = 2 * Math.atanh(prod); }
    }
  }
  return { ok: false, saves, iterations: maxIter, reason: 'no convergence' };
}

function combinations(pool, choose, visit) {
  const cur = [];
  const rec = (start) => { if (cur.length === choose) { visit(cur); return; } for (let i = start; i < pool.length; i++) { cur.push(pool[i]); rec(i + 1); cur.pop(); } };
  rec(0);
}

/**
 * OSD decode of one LLR vector.
 * order: max flip weight (overrides params.nord if given as a number); opts: partial params override { npre1, nt, ntheta, poolSize, keepBest }.
 * Returns { ok, bits77, codeword, trace }.
 */
export function osdDecode(llr, order = 2, opts = {}) {
  const params = { ...osdParamsFromDepth(3, 'default'), ...opts };
  if (typeof order === 'number') params.nord = order;
  const keepBest = opts.keepBest ?? 5;
  const trace = { nord: params.nord, poolSize: Math.min(params.poolSize, K), npre1: params.npre1, nt: params.nt, ntheta: params.ntheta, reason: null };
  if (params.nord === 0) { trace.reason = 'order 0: OSD disabled'; return { ok: false, trace }; }
  const hard = new Uint8Array(N), absrx = new Float64Array(N); let maxAbs = 0;
  for (let i = 0; i < N; i++) { hard[i] = llr[i] < 0 ? 1 : 0; absrx[i] = Math.abs(llr[i]); if (absrx[i] > maxAbs) maxAbs = absrx[i]; }
  if (maxAbs <= 1e-6) { trace.reason = 'all LLRs ~0'; return { ok: false, trace }; }
  // Permutation by decreasing reliability (stable, like the Rust sort_by).
  const perm = Array.from({ length: N }, (_, i) => i).sort((a, b) => absrx[b] - absrx[a] || a - b);
  trace.reliabilityOrder = perm.slice();
  const rows = GEN_ROWS.map(r => { const o = new Uint8Array(N); for (let np = 0; np < N; np++) o[np] = r[perm[np]]; return o; });
  const hardPerm = new Uint8Array(N), absPerm = new Float64Array(N);
  for (let i = 0; i < N; i++) { hardPerm[i] = hard[perm[i]]; absPerm[i] = absrx[perm[i]]; }
  // Gaussian elimination with column swaps (search limit K+20, as WSJT-X).
  const swaps = [];
  const limit = Math.min(K + 20, N);
  for (let col = 0; col < K; col++) {
    let pr = -1, pc = -1;
    for (let c = col; c < limit && pr < 0; c++) for (let r = col; r < K; r++) if (rows[r][c]) { pr = r; pc = c; break; }
    if (pr < 0) { trace.reason = `Gaussian elimination failed at column ${col}`; return { ok: false, trace }; }
    if (pc !== col) {
      for (let r = 0; r < K; r++) { const a = rows[r][col], b = rows[r][pc]; if (a !== b) { rows[r][col] = b; rows[r][pc] = a; } }
      [perm[col], perm[pc]] = [perm[pc], perm[col]]; [hardPerm[col], hardPerm[pc]] = [hardPerm[pc], hardPerm[col]]; [absPerm[col], absPerm[pc]] = [absPerm[pc], absPerm[col]];
      swaps.push({ col, from: pc, bit: perm[col] });
    }
    if (pr !== col) { const t = rows[pr]; rows[pr] = rows[col]; rows[col] = t; }
    const piv = rows[col];
    for (let r = 0; r < K; r++) if (r !== col && rows[r][col]) { const rr = rows[r]; for (let i = 0; i < N; i++) rr[i] ^= piv[i]; }
  }
  const invPerm = new Int32Array(N); for (let np = 0; np < N; np++) invPerm[perm[np]] = np;
  trace.perm = perm.slice(); trace.mrb = perm.slice(0, K); trace.swappedIn = swaps;
  // Order-0: hard decisions on the MRB, re-encoded.
  const m0 = hardPerm.slice(0, K);
  const c0 = new Uint8Array(N); for (let i = 0; i < K; i++) if (m0[i]) { const r = rows[i]; for (let j = 0; j < N; j++) c0[j] ^= r[j]; }
  const dist = (c) => { let d = 0; for (let i = 0; i < N; i++) if (c[i] !== hardPerm[i]) d += absPerm[i]; return d; };
  const toOrig = (cPerm) => { const o = new Uint8Array(N); for (let orig = 0; orig < N; orig++) o[orig] = cPerm[invPerm[orig]]; return o; };
  const dist0 = dist(c0);
  trace.order0 = { codeword: toOrig(c0), dist: dist0, hardErrorsVsReceived: c0.reduce((s, b, i) => s + (b !== hardPerm[i]), 0) };
  // Flip pool: least reliable MRB positions.
  const mrb = Array.from({ length: K }, (_, i) => i).sort((a, b) => absPerm[a] - absPerm[b] || a - b);
  const pool = mrb.slice(0, Math.min(params.poolSize, K));
  trace.flipPool = pool.map(p => perm[p]);
  let bestDist = dist0, bestCw = c0, bestFlips = [];
  const best = [{ dist: dist0, flips: [] }];
  let nTried = 0, nPruned = 0;
  const c = new Uint8Array(N);
  for (let w = 1; w <= params.nord; w++) {
    combinations(pool, w, (subset) => {
      if (params.npre1) {
        const nt = Math.min(params.nt, N - K); let errors = 0;
        for (let p = K; p < K + nt; p++) { let fb = 0; for (const pos of subset) fb ^= rows[pos][p]; if ((c0[p] ^ fb ^ hardPerm[p]) !== 0) errors++; }
        if (errors + w > params.ntheta) { nPruned++; return; }
      }
      nTried++;
      c.set(c0); for (const pos of subset) { const r = rows[pos]; for (let i = 0; i < N; i++) c[i] ^= r[i]; }
      const d = dist(c);
      if (d < bestDist) { bestDist = d; bestCw = Uint8Array.from(c); bestFlips = subset.slice(); }
      if (best.length < keepBest || d < best[best.length - 1].dist) { best.push({ dist: d, flips: subset.slice() }); best.sort((a, b) => a.dist - b.dist); if (best.length > keepBest) best.pop(); }
    });
  }
  trace.patternsTried = nTried; trace.patternsPruned = nPruned;
  trace.best = best.map(b => ({ dist: b.dist, flipsSorted: b.flips, flipsCodeword: b.flips.map(p => perm[p]) }));
  trace.winner = { dist: bestDist, flipsSorted: bestFlips, flipsCodeword: bestFlips.map(p => perm[p]) };
  const codeword = toOrig(bestCw);
  const msg91 = codeword.slice(0, K);
  if (!checkCrc(msg91)) { trace.reason = 'minimum-distance codeword fails CRC-14'; return { ok: false, codeword, trace }; }
  trace.reason = 'CRC ok';
  return { ok: true, bits77: msg91.slice(0, 77), codeword, trace };
}

/**
 * Hybrid: BP (saving zsum snapshots) then OSD on each snapshot, then OSD on the raw LLRs.
 * Returns { ok, bits77, codeword, how: 'bp'|'osd'|null, bp, osdAttempts:[{source, ok, trace}], osdTrace }.
 */
export function decodeBpThenOsd(llr, bpIterations = 30, depth = 3, osdMode = 'default') {
  const params = osdParamsFromDepth(depth, osdMode);
  const bp = bpWithZsum(llr, bpIterations, params.nord === 0 ? 0 : 2);
  if (bp.ok) return { ok: true, bits77: bp.bits77, codeword: bp.codeword, how: 'bp', bp, osdAttempts: [], osdTrace: null };
  if (params.nord === 0) return { ok: false, how: null, bp, osdAttempts: [], osdTrace: null };
  const osdAttempts = [];
  const sources = bp.saves.map((s, i) => ({ name: `zsum after iteration ${i + 1}`, llr: s })).concat([{ name: 'channel LLRs', llr }]);
  for (const src of sources) {
    const r = osdDecode(src.llr, params.nord, params);
    osdAttempts.push({ source: src.name, ok: r.ok, trace: r.trace });
    if (r.ok) return { ok: true, bits77: r.bits77, codeword: r.codeword, how: 'osd', bp, osdAttempts, osdTrace: r.trace, osdSource: src.name };
  }
  return { ok: false, how: null, bp, osdAttempts, osdTrace: osdAttempts[0]?.trace ?? null };
}
