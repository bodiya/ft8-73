// Message packing: text -> 77 bits. Port of wsjtr ft8core pack77.rs + call_hash.rs (WSJT-X packjt77.f90).
// Also describeBits77(): a field-by-field annotation of any 77-bit payload, for visualization.
import { unpack77 } from './unpack77.js';

const NTOKENS = 2063592, MAX22 = 4194304, MAXGRID4 = 32400;
const A1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', A2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', A3 = '0123456789', A4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE38 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/', FT_CHARS = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
const FIELD_DAY_SECTIONS = 'AB AK AL AR AZ BC CO CT DE EB EMA ENY EPA EWA GA GH IA ID IL IN KS KY LA LAX NS MB MDC ME MI MN MO MS MT NC ND NE NFL NH NL NLI NM NNJ NNY TER NTX NV OH OK ONE ONN ONS OR ORG PAC PR QC RI SB SC SCV SD SDG SF SFL SJV SK SNJ STX SV TN UT VA VI VT WCF WI WMA WNY WPA WTX WV WWA WY DX PE NB'.split(' ');
const RTTY_MULTS = ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY NB NS QC ON MB SK AB BC NWT NF LB NU YT PEI DC DR FR GD GR OV ZH ZL').split(' ').concat(Array.from({ length: 99 }, (_, i) => 'X' + String(i + 1).padStart(2, '0')));

const isDigit = c => c >= '0' && c <= '9', isAlpha = c => c >= 'A' && c <= 'Z';
function writeBits(bits, start, len, value) { let v = BigInt(value); for (let i = 0; i < len; i++) bits[start + len - 1 - i] = Number(v & 1n), v >>= 1n; }
const bi = (bits, a, b) => { let n = 0; for (let i = a; i < b; i++) n = n * 2 + bits[i]; return n; };
const bibig = (bits, a, b) => { let n = 0n; for (let i = a; i < b; i++) n = (n << 1n) | BigInt(bits[i]); return n; };

/** call_hash.rs hash_call(): 11-char base-38 number times a magic, top `nbits` bits. */
export function hashCall(call, nbits) {
  let n8 = 0n; const c = call.toUpperCase();
  for (let i = 0; i < 11; i++) { const idx = BASE38.indexOf(c[i] ?? ' '); n8 = (n8 * 38n + BigInt(idx < 0 ? 0 : idx)) & 0xffffffffffffffffn; }
  return Number(((n8 * 47055833459n) & 0xffffffffffffffffn) >> BigInt(64 - nbits));
}

/** pack28(): standard callsign / token -> 28-bit integer (null if it can't be encoded). Port of pack77.rs pack28. */
export function pack28(callsign) {
  const c = callsign.trim().toUpperCase();
  const c13 = c.padEnd(13);
  if (c13.startsWith('DE ')) return 0;
  if (c13.startsWith('QRZ ')) return 1;
  if (c13.startsWith('CQ ')) return 2;
  if (c13.startsWith('CQ_')) {
    const t = c13.trimEnd(); const n = t.length;
    if (n >= 4 && n <= 7) { const s = t.slice(3); const nlet = [...s].filter(isAlpha).length, nnum = [...s].filter(isDigit).length;
      if (nnum === 3 && nlet === 0) return 3 + parseInt(s, 10);
      if (nlet >= 1 && nlet <= 4 && nnum === 0) return 3 + 1000 + cqSuffixValue(s); }
  }
  if (c13.startsWith('<')) { const end = c13.indexOf('>'); if (end < 0) return null; return NTOKENS + hashCall(c13.slice(1, end).trim(), 22); }
  const call = c13.trimEnd(), n = call.length;
  let iarea = -1; for (let i = n - 1; i >= 1; i--) if (isDigit(call[i])) { iarea = i + 1; break; }
  if (iarea < 0) return null;
  const prefix = call.slice(0, iarea - 1), suffix = call.slice(iarea);
  const npdig = [...prefix].filter(isDigit).length, nplet = [...prefix].filter(isAlpha).length, nslet = [...suffix].filter(isAlpha).length;
  if (iarea < 2 || iarea > 3 || nplet === 0 || npdig >= iarea - 1 || nslet > 3) return NTOKENS + hashCall(call.trim(), 22);
  const c6 = iarea === 2 ? ' ' + call.slice(0, 5).padEnd(5) : call.slice(0, 6).padEnd(6);
  const idx = (set, ch) => { const k = set.indexOf(ch); return k; };
  const i1 = idx(A1, c6[0]), i2 = idx(A2, c6[1]), i3 = idx(A3, c6[2]), i4 = idx(A4, c6[3]), i5 = idx(A4, c6[4]), i6 = idx(A4, c6[5]);
  if ([i1, i2, i3, i4, i5, i6].some(v => v < 0)) return null;
  let n28 = 36 * 10 * 27 * 27 * 27 * i1 + 10 * 27 * 27 * 27 * i2 + 27 * 27 * 27 * i3 + 27 * 27 * i4 + 27 * i5 + i6;
  n28 += NTOKENS + MAX22;
  return n28 % (1 << 28);
}
function cqSuffixValue(s) { let m = 0; for (const ch of s.padStart(4)) m = 27 * m + (isAlpha(ch) ? ch.charCodeAt(0) - 64 : 0); return m; }

/** unpack28 (mirror of unpack77.js, needed here for field annotation). */
function unpack28(n28) {
  if (n28 === 0) return 'DE'; if (n28 === 1) return 'QRZ'; if (n28 === 2) return 'CQ';
  if (n28 < 1003) return 'CQ ' + String(n28 - 3).padStart(3, '0');
  if (n28 < NTOKENS) { let m = n28 - 1003, s = ''; for (let k = 0; k < 4; k++) { const j = m % 27; m = Math.floor(m / 27); if (j > 0) s = String.fromCharCode(64 + j) + s; } return s ? 'CQ ' + s : 'CQ'; }
  if (n28 < NTOKENS + MAX22) return `<hash22 ${n28 - NTOKENS}>`;
  let n = n28 - NTOKENS - MAX22;
  const i6 = n % 27; n = Math.floor(n / 27); const i5 = n % 27; n = Math.floor(n / 27); const i4 = n % 27; n = Math.floor(n / 27);
  const i3 = n % 10; n = Math.floor(n / 10); const i2 = n % 36; n = Math.floor(n / 36); const i1 = n % 37;
  return (A1[i1] + A2[i2] + A3[i3] + A4[i4] + A4[i5] + A4[i6]).trim();
}
function gridReportText(igrid4, ir) {
  if (igrid4 < MAXGRID4) { const g = String.fromCharCode(65 + Math.floor(igrid4 / 1800), 65 + Math.floor(igrid4 / 100) % 18, 48 + Math.floor(igrid4 / 10) % 10, 48 + igrid4 % 10); return (ir ? 'R ' : '') + g + ' (grid)'; }
  const irpt = igrid4 - MAXGRID4;
  if (irpt === 1) return '(none)'; if (irpt === 2) return 'RRR'; if (irpt === 3) return 'RR73'; if (irpt === 4) return '73';
  let snr = irpt - 35; if (snr > 50) snr -= 101;
  return (ir ? 'R' : '') + (snr < 0 ? '-' : '+') + String(Math.abs(snr)).padStart(2, '0') + ' (report)';
}

const isGrid4 = v => v.length === 4 && v[0] >= 'A' && v[0] <= 'R' && v[1] >= 'A' && v[1] <= 'R' && isDigit(v[2]) && isDigit(v[3]);
const isGrid6 = v => v.length === 6 && isGrid4(v.slice(0, 4)) && v[4] >= 'A' && v[4] <= 'X' && v[5] >= 'A' && v[5] <= 'X';
export function packGrid4(g) { return (g.charCodeAt(0) - 65) * 1800 + (g.charCodeAt(1) - 65) * 100 + (g.charCodeAt(2) - 48) * 10 + (g.charCodeAt(3) - 48); }
function packGrid6(g) { return (g.charCodeAt(0) - 65) * 18 * 10 * 10 * 24 * 24 + (g.charCodeAt(1) - 65) * 10 * 10 * 24 * 24 + (g.charCodeAt(2) - 48) * 10 * 24 * 24 + (g.charCodeAt(3) - 48) * 24 * 24 + (g.charCodeAt(4) - 65) * 24 + (g.charCodeAt(5) - 65); }
/** Report value (dB) -> irpt offset above MAXGRID4, or null. */
export function encodeReport(value) { let v = value; if (v >= -50 && v <= -31) v += 101; if (v < -30 || v > 70) return null; const irpt = v + 35; return irpt < 0 ? null : irpt; }
function parseReport(v) { let ir = 0, rest = v; if (rest.startsWith('R')) { ir = 1; rest = rest.slice(1); } if (!rest) return null; let sign = 1; if (rest[0] === '+') rest = rest.slice(1); else if (rest[0] === '-') { sign = -1; rest = rest.slice(1); } if (!rest || rest.length > 2 || ![...rest].every(isDigit)) return null; return [ir, sign * parseInt(rest, 10)]; }
function stripCallSuffix(call) { if (call.startsWith('<')) return [call, 0, false]; let base = call.trim(); const u = base.toUpperCase(); if (u.endsWith('/R')) return [base.slice(0, -2), 1, false]; if (u.endsWith('/P')) return [base.slice(0, -2), 1, true]; return [base, 0, false]; }
function isType4Nonstandard(call) { if (call.startsWith('<')) return false; return stripCallSuffix(call)[0].includes('/'); }
function encodeBase38_11(call) { const u = call.trim().toUpperCase(); if (!u || u.length > 11) return null; let n = 0n; for (const ch of u.padStart(11)) { const i = BASE38.indexOf(ch); if (i < 0) return null; n = n * 38n + BigInt(i); } return n >= (1n << 58n) ? null : n; }

function assembleType1(n28a, n28b, igrid, i3, ipa, ipb, ir) {
  const bits = new Uint8Array(77); writeBits(bits, 0, 28, n28a); bits[28] = ipa & 1; writeBits(bits, 29, 28, n28b); bits[57] = ipb & 1; bits[58] = ir & 1; writeBits(bits, 59, 15, igrid); writeBits(bits, 74, 3, i3); return bits;
}
function tryType4(parts) {
  if (!parts.length) return null;
  let icq = 0, idx = 0; if (parts[0] === 'CQ') { icq = 1; idx = 1; }
  const callA = parts[idx]; if (callA == null) return null; idx++;
  let callB = null; if (!icq) { callB = parts[idx]; if (callB == null) return null; idx++; }
  let nrpt = 0;
  if (idx < parts.length) { if (callB == null) return null; nrpt = { RRR: 1, RR73: 2, '73': 3 }[parts[idx]]; if (nrpt == null) return null; idx++; }
  if (idx !== parts.length) return null;
  const aN = isType4Nonstandard(callA), bN = callB ? isType4Nonstandard(callB) : false;
  if (icq) { if (!aN) return null; } else if (aN === bN) return null;
  const [nonStd, stdCall, iflip] = icq ? [callA, null, 0] : aN ? [callA, callB, 1] : [callB, callA, 0];
  const n58 = encodeBase38_11(nonStd); if (n58 == null) return null;
  // packjt77.f90 pack77_4: with no standard call to hash (a CQ), WSJT-X puts the hash of the
  // nonstandard call itself here, which is how a receiver learns to resolve that <...> later.
  // <CALL> marks the call that travels as a hash; the brackets are syntax, not part of the call.
  const n12 = stdCall ? hashCall(stdCall.trim().replace(/^<|>$/g, ''), 12) : hashCall(nonStd.trim(), 12);
  const bits = new Uint8Array(77); writeBits(bits, 0, 12, n12); writeBits(bits, 12, 58, n58); bits[70] = iflip; writeBits(bits, 71, 2, nrpt); bits[73] = icq; writeBits(bits, 74, 3, 4); return bits;
}
function tryCq(parts) {
  if (parts.length < 2) return null;
  let n28a = { DE: 0, QRZ: 1, CQ: 2 }[parts[0]]; if (n28a == null) return null;
  let idx = 1;
  if (parts[0] === 'CQ' && parts.length > 2) {
    const m = parts[1];
    if (m.length === 3 && [...m].every(isDigit)) { n28a = 3 + parseInt(m, 10); idx = 2; }
    else if (m.length >= 1 && m.length <= 4 && [...m].every(isAlpha)) { n28a = 3 + 1000 + cqSuffixValue(m); idx = 2; }
  }
  if (idx >= parts.length) return null;
  const n28b = pack28(parts[idx]); if (n28b == null) return null;
  const grid = parts[idx + 1];
  if (grid != null) { if (isGrid4(grid)) return assembleType1(n28a, n28b, packGrid4(grid), 1, 0, 0, 0); return null; }
  return assembleType1(n28a, n28b, MAXGRID4 + 1, 1, 0, 0, 0);
}
function tryStandard(parts) {
  if (parts.length < 2) return null;
  const [c1, ipa, p1] = stripCallSuffix(parts[0]), [c2, ipb, p2] = stripCallSuffix(parts[1]); const i3 = p1 || p2 ? 2 : 1;
  const n28a = pack28(c1), n28b = pack28(c2); if (n28a == null || n28b == null) return null;
  if (parts.length === 2) return assembleType1(n28a, n28b, MAXGRID4 + 1, i3, ipa, ipb, 0);
  let idx = 2, irTok = 0; if (parts[idx] === 'R') { irTok = 1; idx++; if (idx >= parts.length) return null; }
  if (idx + 1 !== parts.length) return null;
  const rep = parts[idx];
  if (isGrid4(rep)) return assembleType1(n28a, n28b, packGrid4(rep), i3, ipa, ipb, irTok);
  const fixed = { RRR: 2, RR73: 3, '73': 4 }[rep]; if (fixed) { if (irTok) return null; return assembleType1(n28a, n28b, MAXGRID4 + fixed, i3, ipa, ipb, 0); }
  const pr = parseReport(rep); if (pr) { const irpt = encodeReport(pr[1]); if (irpt != null) { if (irTok && pr[0]) return null; return assembleType1(n28a, n28b, MAXGRID4 + irpt, i3, ipa, ipb, irTok ? 1 : pr[0]); } }
  return null;
}
function tryFieldDay(parts) {
  if (parts.length < 4 || parts.length > 5) return null;
  let idx = 2, ir = 0; if (parts.length === 5) { if (parts[2] !== 'R') return null; ir = 1; idx = 3; }
  const tok = parts[idx]; if (tok.length < 2) return null; const ntx = parseInt(tok.slice(0, -1), 10), ch = tok.slice(-1); if (!(ntx >= 1 && ntx <= 32) || !/^\d+$/.test(tok.slice(0, -1)) || ch < 'A' || ch > 'H') return null;
  const isec = FIELD_DAY_SECTIONS.indexOf(parts[idx + 1]) + 1; if (!isec) return null;
  const n3 = ntx <= 16 ? 3 : 4, intx = ntx <= 16 ? ntx - 1 : ntx - 17;
  const n28a = pack28(parts[0]), n28b = pack28(parts[1]); if (n28a == null || n28b == null) return null;
  const bits = new Uint8Array(77); writeBits(bits, 0, 28, n28a); writeBits(bits, 28, 28, n28b); bits[56] = ir; writeBits(bits, 57, 4, intx); writeBits(bits, 61, 3, ch.charCodeAt(0) - 65); writeBits(bits, 64, 7, isec); writeBits(bits, 71, 3, n3); return bits;
}
function tryRtty(parts) {
  if (parts.length < 4 || parts.length > 6) return null;
  let idx = 0, itu = 0; if (parts[0] === 'TU;') { itu = 1; idx = 1; } if (idx + 3 >= parts.length) return null;
  const c1 = parts[idx], c2 = parts[idx + 1]; idx += 2;
  let ir = 0; if (parts[idx] === 'R') { ir = 1; idx++; if (idx >= parts.length) return null; }
  if (idx + 2 !== parts.length) return null;
  const rep = parts[idx], exch = parts[idx + 1];
  if (!/^5\d9$/.test(rep)) return null;
  let irpt = Math.floor((parseInt(rep, 10) - 509) / 10) - 2; irpt = Math.max(0, Math.min(7, irpt));
  let nexch; const mi = RTTY_MULTS.indexOf(exch) + 1; if (mi) nexch = 8000 + mi; else if (/^\d+$/.test(exch)) { nexch = parseInt(exch, 10); if (nexch < 1 || nexch > 7999) return null; } else return null;
  const n28a = pack28(c1), n28b = pack28(c2); if (n28a == null || n28b == null) return null;
  const bits = new Uint8Array(77); bits[0] = itu; writeBits(bits, 1, 28, n28a); writeBits(bits, 29, 28, n28b); bits[57] = ir; writeBits(bits, 58, 3, irpt); writeBits(bits, 61, 13, nexch); writeBits(bits, 74, 3, 3); return bits;
}
function tryEuVhf(parts) {
  if (parts.length < 4 || parts.length > 5 || !parts[0].startsWith('<') || !parts[1].startsWith('<')) return null;
  let idx = 2, ir = 0; if (parts[idx] === 'R') { ir = 1; idx++; if (idx >= parts.length) return null; } if (idx + 2 !== parts.length) return null;
  const nx = parseInt(parts[idx], 10), grid = parts[idx + 1]; if (!/^\d+$/.test(parts[idx]) || nx < 520001 || nx > 594095 || !isGrid6(grid)) return null;
  const strip = c => { const e = c.indexOf('>'); return e < 0 ? null : c.slice(1, e).toUpperCase(); };
  const c1 = strip(parts[0]), c2 = strip(parts[1]); if (c1 == null || c2 == null) return null;
  const irpt = Math.max(0, Math.floor(nx / 10000) - 52), iserial = Math.min(2047, nx % 10000);
  const bits = new Uint8Array(77); writeBits(bits, 0, 12, hashCall(c1, 12)); writeBits(bits, 12, 22, hashCall(c2, 22)); bits[34] = ir; writeBits(bits, 35, 3, irpt); writeBits(bits, 38, 11, iserial); writeBits(bits, 49, 25, packGrid6(grid)); writeBits(bits, 74, 3, 5); return bits;
}
export function packFreeText(msg) {
  let text = msg.toUpperCase().slice(0, 13).padStart(13);
  let n = 0n; for (const ch of text) { const i = FT_CHARS.indexOf(ch); n = n * 42n + BigInt(i < 0 ? 0 : i); }
  const bits = new Uint8Array(77); writeBits(bits, 0, 71, n); return bits;
}

/**
 * Pack a message. Returns { bits: Uint8Array(77), type, text, fields } or null when even free text fails (never, in practice).
 * Dispatch order mirrors pack77.rs: type 4 → CQ/DE/QRZ → Field Day → standard → RTTY RU → EU VHF → free text.
 */
export function pack77(message) {
  const msg = message.trim().toUpperCase(); const parts = msg.split(/\s+/).filter(Boolean);
  let bits = tryType4(parts);
  if (!bits && (msg.startsWith('CQ ') || msg.startsWith('DE ') || msg.startsWith('QRZ '))) bits = tryCq(parts);
  if (!bits) bits = tryFieldDay(parts);
  if (!bits) bits = tryStandard(parts);
  if (!bits) bits = tryRtty(parts);
  if (!bits) bits = tryEuVhf(parts);
  if (!bits) bits = packFreeText(msg);
  const d = describeBits77(bits);
  return { bits, type: d.type, text: d.text, fields: d.fields };
}

/** Annotate 77 bits: { type, text, fields: [{ name, start, len, value, text }] }. Works on decoded bits too. */
export function describeBits77(bits) {
  const n3 = bi(bits, 71, 74), i3 = bi(bits, 74, 77); const u = unpack77(bits);
  const f = (name, start, len, value, text) => ({ name, start, len, value, text });
  const i3f = f('i3 message type', 74, 3, i3, `type ${i3}`);
  let fields = [], type = u ? u.type : `i3=${i3} n3=${n3}`;
  if (i3 === 1 || i3 === 2) {
    const n28a = bi(bits, 0, 28), n28b = bi(bits, 29, 57), ir = bits[58], ig = bi(bits, 59, 74); const sfx = i3 === 2 ? '/P' : '/R';
    fields = [f('call 1 (28-bit)', 0, 28, n28a, unpack28(n28a)), f('ipa: call 1 has ' + sfx, 28, 1, bits[28], bits[28] ? sfx : 'no'), f('call 2 (28-bit)', 29, 28, n28b, unpack28(n28b)), f('ipb: call 2 has ' + sfx, 57, 1, bits[57], bits[57] ? sfx : 'no'), f('ir: R (roger) flag', 58, 1, ir, ir ? 'R' : 'no'), f('grid / report (15-bit)', 59, 15, ig, gridReportText(ig, ir)), i3f];
  } else if (i3 === 0 && n3 === 0) {
    fields = [f('free text (13 chars, base 42)', 0, 71, bibig(bits, 0, 71).toString(), u ? u.text : '?'), f('n3 subtype', 71, 3, n3, 'free text'), i3f];
  } else if (i3 === 0 && n3 === 5) {
    fields = [f('telemetry 71 bits (hex)', 0, 71, bibig(bits, 0, 71).toString(16).toUpperCase(), u ? u.text : '?'), f('n3 subtype', 71, 3, n3, 'telemetry'), i3f];
  } else if (i3 === 0 && (n3 === 3 || n3 === 4)) {
    const a = bi(bits, 0, 28), b = bi(bits, 28, 56), intx = bi(bits, 57, 61), ncl = bi(bits, 61, 64), isec = bi(bits, 64, 71);
    fields = [f('call 1', 0, 28, a, unpack28(a)), f('call 2', 28, 28, b, unpack28(b)), f('R flag', 56, 1, bits[56], bits[56] ? 'R' : 'no'), f('transmitters − 1', 57, 4, intx, String(intx + 1 + (n3 === 4 ? 16 : 0))), f('class', 61, 3, ncl, String.fromCharCode(65 + ncl)), f('ARRL section', 64, 7, isec, FIELD_DAY_SECTIONS[isec - 1] || '?'), f('n3 subtype', 71, 3, n3, 'Field Day' + (n3 === 4 ? ' (17+ tx)' : '')), i3f];
  } else if (i3 === 3) {
    const a = bi(bits, 1, 29), b = bi(bits, 29, 57), irpt = bi(bits, 58, 61), nexch = bi(bits, 61, 74);
    fields = [f('TU; flag', 0, 1, bits[0], bits[0] ? 'TU;' : 'no'), f('call 1', 1, 28, a, unpack28(a)), f('call 2', 29, 28, b, unpack28(b)), f('R flag', 57, 1, bits[57], bits[57] ? 'R' : 'no'), f('RST', 58, 3, irpt, `5${irpt + 2}9`), f('exchange (serial or mult)', 61, 13, nexch, nexch >= 8000 ? (RTTY_MULTS[nexch - 8001] || '?') : String(nexch).padStart(4, '0')), i3f];
  } else if (i3 === 4) {
    const n12 = bi(bits, 0, 12), n58 = bibig(bits, 12, 70); let c11 = ''; let m = n58; for (let k = 0; k < 11; k++) { c11 = BASE38[Number(m % 38n)] + c11; m /= 38n; }
    fields = [f('12-bit hash of the standard call', 0, 12, n12, `<hash12 ${n12}>`), f('non-standard call (11 chars, base 38)', 12, 58, n58.toString(), c11.trim()), f('iflip: which side is non-standard', 70, 1, bits[70], bits[70] ? 'call 1' : 'call 2'), f('nrpt', 71, 2, bi(bits, 71, 73), ['(none)', 'RRR', 'RR73', '73'][bi(bits, 71, 73)]), f('icq: CQ message', 73, 1, bits[73], bits[73] ? 'CQ' : 'no'), i3f];
  } else if (i3 === 5) {
    fields = [f('12-bit hash, call 1', 0, 12, bi(bits, 0, 12), `<hash12>`), f('22-bit hash, call 2', 12, 22, bi(bits, 12, 34), `<hash22>`), f('R flag', 34, 1, bits[34], bits[34] ? 'R' : 'no'), f('report − 52', 35, 3, bi(bits, 35, 38), String(52 + bi(bits, 35, 38))), f('serial', 38, 11, bi(bits, 38, 49), String(bi(bits, 38, 49)).padStart(4, '0')), f('6-char grid', 49, 25, bi(bits, 49, 74), u ? u.text.split(' ').pop() : '?'), i3f];
  } else {
    fields = [f('payload', 0, 71, bibig(bits, 0, 71).toString(), '?'), f('n3', 71, 3, n3, String(n3)), i3f];
  }
  return { type, text: u ? u.text : null, fields };
}

/** pack77.rs callsign_to_ap_bits(): 29 values ±1 (WSJT-X sign convention, +1 = bit 1), or null for non-standard calls. */
export function callsignToApBits(callsign) {
  const n28 = pack28(callsign); if (n28 == null || n28 < NTOKENS + MAX22) return null;
  const out = new Float32Array(29); for (let i = 0; i < 28; i++) out[i] = (n28 >> (27 - i)) & 1 ? 1 : -1; out[28] = -1; return out;
}
