// JTTY source coding: text <-> 34-bit frame payloads.
// Port of WSJT-X 3.2 lib/jtty/jtty_source_codec.f90 (atoms, pack/unpack/render) and jtty_mod.f90
// (pack_jtty's minimum-frame dynamic program, normalize_jtty_message, unpack_jtty).
//
// A payload is 34 bits, index 0 = Fortran bit 1:
//   bits 0-29   the form (a call, a STRUCT30 body + family, or five 6-bit characters)
//   bits 30-31  i2, the message type
//   bit 32      reserved, always 0 (the decoder treats it as a 13th check bit)
//   bit 33      EOM: set only on the last frame of a message
import { pack28, unpack28, FIELD_DAY_SECTIONS } from '../pack77.js';

export const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ +-./?!"#$%,&*()_\'=[]{}<>|:;';
export const MAX_FRAMES = 16;
export const ATOM = { CALL: 0, EXCH_NUM: 1, EXCH_LOC: 2, EXCH_PAIR: 3, EXCH_NUM_TIME: 4, CONTROL: 5, GRID4: 6, TEXT5: 7 };
export const ATOM_NAMES = ['CALL', 'EXCH_NUM', 'EXCH_LOC', 'EXCH_PAIR', 'EXCH_NUM_TIME', 'CONTROL', 'GRID4', 'TEXT5'];
export const CALL_ACTIONS = ['CQ', 'CALL', 'TU_CQ', 'CALL_TU', 'CALL_AGN', 'TU_NOW'];
export const NUM_KINDS = ['SERIAL', 'CQ_ZONE', 'ITU_ZONE', 'AGE', 'POWER', 'CHECK', 'LICENSE_YEAR', 'GENERIC'];
export const LOC_KINDS = ['STATE_PROVINCE', 'SECTION', 'COUNTRY_PREFIX', 'QTH', 'ADMIN_CODE'];
export const FAMILY_NAMES = ['EXCH_NUM', 'EXCH_LOC', 'EXCH_PAIR', 'EXCH_NUM_TIME', 'MISC', 'PROFILED', 'VERSIONED', 'INVALID'];
const NUM = { SERIAL: 0, CQ_ZONE: 1, ITU_ZONE: 2, CHECK: 5, LICENSE_YEAR: 6, GENERIC: 7 };
const LOC = { STATE_PROVINCE: 0, QTH: 3 };
const ROLE_FIELD_ONLY = 0, ROLE_FULL = 1;
export const CONTROL_TEXT = ['AGN?', 'CALL?', 'AGN CALL', 'NR?', 'AGN NR', 'EXCH?', 'STATE?', 'SECTION?',
  'ZONE?', 'GRID?', 'RPRT?', 'QSL TU', 'TU', 'QRZ?', 'QSO B4', 'WAIT', 'NIL?', 'OK?'];
export const PROFILE = { UNKNOWN: 0, FIELD_DAY: 1, RTTY: 2 };
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NSEC = FIELD_DAY_SECTIONS.length;   // 86, PACK77_ARRL_SECTIONS

export const sourceIndex = c => ALPHABET.indexOf(c);
export const sourceChar = i => ALPHABET[i];
const atom = (kind, o = {}) => ({ kind, subtype: 0, role: ROLE_FIELD_ONLY, value: 0, value2: 0, text: '', ...o });
export const callAtom = (action, call) => atom(ATOM.CALL, { subtype: action, text: call });
export const numAtom = (role, kind, value) => atom(ATOM.EXCH_NUM, { role, subtype: kind, value });
export const locAtom = (role, kind, token) => atom(ATOM.EXCH_LOC, { role, subtype: kind, text: token });
export const classSectionAtom = (count, cls, sectionIndex) => atom(ATOM.EXCH_PAIR, { subtype: 1, value: count, value2: sectionIndex, text: cls });
export const controlAtom = id => atom(ATOM.CONTROL, { subtype: id });
export const grid4Atom = (role, grid) => atom(ATOM.GRID4, { role, text: grid });
/** jtty_text5_atom: up to five characters, blank-padded like a Fortran character(13). */
export const text5Atom = text => atom(ATOM.TEXT5, { text: text.slice(0, 5).padEnd(5) });

// ---- callsigns (chkcall.f90, callok() in packjt77.f90, standard_call) ----
const isDig = c => c >= '0' && c <= '9', isLet = c => c >= 'A' && c <= 'Z';
function chkcall(w) {
  const n1 = w.length;
  if (n1 > 11 || /[.+\-?]/.test(w)) return false;
  if (n1 > 6 && !w.includes('/')) return false;
  const i0 = w.indexOf('/') + 1;                 // 1-based, 0 if none
  if (Math.max(i0 - 1, n1 - i0) > 6) return false;
  let bc = w.slice(0, 6);
  if (i0 >= 2 && i0 <= n1 - 1) bc = i0 - 1 <= n1 - i0 ? w.slice(i0) : w.slice(0, i0 - 1);
  bc = bc.trimEnd(); const nbc = bc.length;
  if (nbc > 6) return false;
  if (!isLet(bc[0]) && !isLet(bc[1] || ' ')) return false;
  if (bc[0] === 'Q' && bc.slice(0, 5) !== 'QU1RK') return false;
  let i1 = 0; if (isDig(bc[1] || ' ')) i1 = 2; if (isDig(bc[2] || ' ')) i1 = 3;
  if (i1 === 0 || i1 === nbc) return false;
  for (let i = i1; i < nbc; i++) if (!isLet(bc[i])) return false;
  const n = nbc - i1; return n >= 1 && n <= 3;
}
function callok(w) {
  const n = w.length; if (n < 3 || w[0] === 'Q') return false;
  let i0 = 0; for (let i = n; i >= 1; i--) if (isDig(w[i - 1])) { i0 = i; break; }
  if (i0 !== 2 && i0 !== 3) return false;
  const pfx = w.slice(0, i0 - 1); let nl = 0, nd = 0;
  for (const c of pfx) { if (isDig(c)) nd++; if (isLet(c)) nl++; }
  if (nl + nd !== pfx.length || nl === 0) return false;
  const ns = n - i0; if (ns < 1 || ns > 3) return false;
  for (let i = i0; i < n; i++) if (!isLet(w[i])) return false;
  return true;
}
/** unpack28 as the JTTY decoder sees it: only a standard call that passes callok() succeeds. */
function unpackCall(n28) { const c = unpack28(n28); return c && !c.startsWith('<') && !c.includes(' ') && callok(c) ? c : null; }
/** standard_call(): a token that survives the 28-bit callsign field unchanged. */
export function standardCall(call) {
  if (!call || !chkcall(call) || call.includes('/') || call[0] === 'Q' || !/^[A-Z0-9]+$/.test(call)) return false;
  const n28 = pack28(call); if (n28 == null) return false;
  return unpackCall(n28) === call;
}

// ---- small helpers ----
const pow2 = k => 2 ** k;
/** ibits(v, pos, len) for non-negative integers up to 2^53. */
const ibits = (v, pos, len) => Math.floor(v / pow2(pos)) % pow2(len);
function packBase36(token) {
  if (token.length !== 2 && token.length !== 3) return null;
  let v = 0; for (const c of token) { const d = B36.indexOf(c); if (d < 0) return null; v = 36 * v + d; }
  if (token.length === 3 && v < 36 * 36) return null;
  return v;
}
function unpackBase36(v, n) { let s = ''; for (let i = 0; i < n; i++) { s = B36[v % 36] + s; v = Math.floor(v / 36); } return s; }
function grid4Index(g) {
  if (g.length !== 4) return null;
  const a = g.charCodeAt(0) - 65, b = g.charCodeAt(1) - 65, c = g.charCodeAt(2) - 48, d = g.charCodeAt(3) - 48;
  if (!(a >= 0 && a < 18 && b >= 0 && b < 18 && c >= 0 && c < 10 && d >= 0 && d < 10)) return null;
  return ((a * 18 + b) * 10 + c) * 10 + d;
}
function indexGrid4(i) { const d = i % 10; i = Math.floor(i / 10); const c = i % 10; i = Math.floor(i / 10); const b = i % 18, a = Math.floor(i / 18); return String.fromCharCode(65 + a, 65 + b, 48 + c, 48 + d); }
function validNumber(kind, value) {
  if (!(kind >= 0 && kind <= 7 && value >= 0 && value <= 131071)) return false;
  if (kind === NUM.CQ_ZONE) return value >= 1 && value <= 40;
  if (kind === NUM.ITU_ZONE) return value >= 1 && value <= 90;
  if (kind === NUM.LICENSE_YEAR) return value <= 9999;
  return true;
}
const validRole = r => r === 0 || r === 1;
const struct = (body, family) => 4 * (8 * body + family) + 2;   // finish_struct

/**
 * pack_jtty_atom: one atom -> 34 payload bits (Uint8Array, index 0 = bit 1), or null if the atom
 * is not representable. Also returns n32 and the field layout for display.
 */
export function packAtom(a, eom = false) {
  let n32 = null;
  switch (a.kind) {
    case ATOM.CALL: {
      if (a.subtype < 0 || a.subtype > 5 || !standardCall(a.text)) return null;
      const n28 = pack28(a.text);
      const [i2, n2] = a.subtype <= 3 ? [0, a.subtype] : [1, a.subtype - 4];
      n32 = n28 * 16 + 4 * n2 + i2; break;
    }
    case ATOM.EXCH_NUM:
      if (!validRole(a.role) || !validNumber(a.subtype, a.value)) return null;
      n32 = struct(a.role * pow2(26) + a.subtype * pow2(22) + a.value * 32, 0); break;
    case ATOM.EXCH_LOC: {
      if (!validRole(a.role) || a.subtype < 0 || a.subtype > 4) return null;
      const n = a.text.length, tok = packBase36(a.text); if (tok == null) return null;
      n32 = struct(a.role * pow2(26) + a.subtype * pow2(22) + (n - 2) * pow2(21) + tok * 32, 1); break;
    }
    case ATOM.EXCH_PAIR: {
      let pd;
      if (a.subtype === 0) {
        if (a.value < 1 || a.value > 40) return null;
        const n = a.text.length, tok = packBase36(a.text); if (tok == null) return null;
        pd = a.value * pow2(17) + (n - 2) * pow2(16) + tok;
      } else if (a.subtype === 1) {
        if (a.value < 1 || a.value > 32 || a.value2 < 1 || a.value2 > NSEC || a.text.length !== 1) return null;
        const ci = a.text.charCodeAt(0) - 65; if (ci < 0 || ci > 5) return null;
        pd = a.value * pow2(17) + ci * pow2(14) + a.value2 * pow2(7);
      } else return null;
      n32 = struct(a.subtype * pow2(24) + pd * 2, 2); break;
    }
    case ATOM.EXCH_NUM_TIME:
      if (!validRole(a.role) || a.value < 0 || a.value > 16383 || a.value2 < 0 || a.value2 > 1439) return null;
      n32 = struct(a.role * pow2(26) + a.value * pow2(12) + a.value2 * 2, 3); break;
    case ATOM.CONTROL:
      if (a.subtype < 0 || a.subtype > 17) return null;
      n32 = struct(a.subtype * pow2(16), 4); break;
    case ATOM.GRID4: {
      if (!validRole(a.role)) return null;
      const gi = grid4Index(a.text); if (gi == null) return null;
      n32 = struct(pow2(23) + a.role * pow2(22) + gi * pow2(7), 4); break;
    }
    case ATOM.TEXT5: {
      let top = 0; for (let i = 0; i < 5; i++) { const k = sourceIndex(a.text[i] ?? ' '); if (k < 0) return null; top = 64 * top + k; }
      n32 = 4 * top + 3; break;
    }
    default: return null;
  }
  const bits = new Uint8Array(34);
  for (let i = 0; i < 32; i++) bits[i] = ibits(n32, 31 - i, 1);
  bits[32] = 0; bits[33] = eom ? 1 : 0;
  return bits;
}

const bitsVal = (bits, a, b) => { let v = 0; for (let i = a; i < b; i++) v = v * 2 + bits[i]; return v; };

/** unpack_jtty_atom: 34 bits -> { atom, eom } or null when the word is not valid source. */
export function unpackAtom(bits) {
  if (bits[32] !== 0) return null;
  let any = false; for (let i = 0; i < 32; i++) if (bits[i]) { any = true; break; }
  if (!any) return null;
  const top30 = bitsVal(bits, 0, 30), i2 = bitsVal(bits, 30, 32);
  let a;
  if (i2 === 0 || i2 === 1) {
    const n28 = bitsVal(bits, 0, 28), n2 = bitsVal(bits, 28, 30);
    if (i2 === 1 && n2 > 1) return null;
    const c = unpackCall(n28); if (!c || !standardCall(c)) return null;
    a = callAtom(i2 === 0 ? n2 : n2 + 4, c);
  } else if (i2 === 2) {
    const family = top30 % 8, body = Math.floor(top30 / 8);
    if (family === 0) {
      a = numAtom(ibits(body, 26, 1), ibits(body, 22, 4), ibits(body, 5, 17));
      if (ibits(body, 0, 5) !== 0 || !validNumber(a.subtype, a.value)) return null;
    } else if (family === 1) {
      const n = ibits(body, 21, 1) + 2, tok = ibits(body, 5, 16), sub = ibits(body, 22, 4);
      if (ibits(body, 0, 5) !== 0 || sub > 4 || tok >= 36 ** n || (n === 3 && tok < 36 * 36)) return null;
      a = locAtom(ibits(body, 26, 1), sub, unpackBase36(tok, n));
    } else if (family === 2) {
      const sub = ibits(body, 24, 3), pd = ibits(body, 1, 23);
      if (ibits(body, 0, 1) !== 0) return null;
      if (sub === 0) {
        const z = ibits(pd, 17, 6), n = ibits(pd, 16, 1) + 2, tok = ibits(pd, 0, 16);
        if (z < 1 || z > 40 || tok >= 36 ** n || (n === 3 && tok < 36 * 36)) return null;
        a = atom(ATOM.EXCH_PAIR, { subtype: 0, value: z, text: unpackBase36(tok, n) });
      } else if (sub === 1) {
        const cnt = ibits(pd, 17, 6), ci = ibits(pd, 14, 3), sec = ibits(pd, 7, 7);
        if (cnt < 1 || cnt > 32 || ci > 5 || sec < 1 || sec > NSEC || ibits(pd, 0, 7) !== 0) return null;
        a = classSectionAtom(cnt, String.fromCharCode(65 + ci), sec);
      } else return null;
    } else if (family === 3) {
      a = atom(ATOM.EXCH_NUM_TIME, { role: ibits(body, 26, 1), value: ibits(body, 12, 14), value2: ibits(body, 1, 11) });
      if (ibits(body, 0, 1) !== 0 || a.value2 > 1439) return null;
    } else if (family === 4) {
      const i = ibits(body, 23, 4), data = ibits(body, 0, 23);
      if (i === 0) {
        const sub = ibits(data, 16, 7);
        if (ibits(data, 0, 16) !== 0 || sub > 17) return null;
        a = controlAtom(sub);
      } else if (i === 1) {
        const gi = ibits(data, 7, 15);
        if (ibits(data, 0, 7) !== 0 || gi >= 32400) return null;
        a = grid4Atom(ibits(data, 22, 1), indexGrid4(gi));
      } else return null;
    } else return null;
  } else {
    let t = ''; for (let i = 0; i < 5; i++) t += sourceChar(ibits(top30, 6 * (4 - i), 6));
    a = text5Atom(t);
  }
  return { atom: a, eom: bits[33] === 1 };
}

function renderNumber(kind, v) {
  if (kind === NUM.SERIAL) return v < 1000 ? String(v).padStart(3, '0') : String(v);
  if (kind === NUM.CQ_ZONE || kind === NUM.ITU_ZONE || kind === NUM.CHECK) return v < 100 ? String(v).padStart(2, '0') : String(v);
  if (kind === NUM.LICENSE_YEAR) return String(v).padStart(4, '0');
  return String(v);
}
const role = (r, f) => r === ROLE_FULL ? '599 ' + f : f;
/** render_jtty_atom: canonical text, or null. */
export function renderAtom(a) {
  switch (a.kind) {
    case ATOM.CALL: return ['CQ ' + a.text + ' CQ', a.text, 'TU ' + a.text + ' CQ', a.text + ' TU', a.text + ' AGN?', 'TU NOW ' + a.text][a.subtype] ?? null;
    case ATOM.EXCH_NUM: return validRole(a.role) && validNumber(a.subtype, a.value) ? role(a.role, renderNumber(a.subtype, a.value)) : null;
    case ATOM.EXCH_LOC: return a.subtype >= 0 && a.subtype <= 4 ? role(a.role, a.text) : null;
    case ATOM.EXCH_PAIR:
      if (a.subtype === 0) return '599 ' + String(a.value).padStart(2, '0') + ' ' + a.text;
      if (a.subtype === 1) return a.value2 >= 1 && a.value2 <= NSEC ? `${a.value}${a.text} ${FIELD_DAY_SECTIONS[a.value2 - 1]}` : null;
      return null;
    case ATOM.EXCH_NUM_TIME: return role(a.role, renderNumber(NUM.SERIAL, a.value) + ' ' + String(Math.floor(a.value2 / 60)).padStart(2, '0') + String(a.value2 % 60).padStart(2, '0'));
    case ATOM.CONTROL: return CONTROL_TEXT[a.subtype] ?? null;
    case ATOM.GRID4: return role(a.role, a.text.slice(0, 4));
    case ATOM.TEXT5: return a.text.slice(0, 5);
    default: return null;
  }
}

/** A short human label for an atom, for the packing table. */
export function describeAtom(a) {
  switch (a.kind) {
    case ATOM.CALL: return `CALL ${CALL_ACTIONS[a.subtype]}`;
    case ATOM.EXCH_NUM: return `EXCH_NUM ${a.role ? 'full ' : ''}${NUM_KINDS[a.subtype]}`;
    case ATOM.EXCH_LOC: return `EXCH_LOC ${a.role ? 'full ' : ''}${LOC_KINDS[a.subtype]}`;
    case ATOM.EXCH_PAIR: return a.subtype === 0 ? 'ZONE_LOC3' : 'CLASS_SECTION';
    case ATOM.EXCH_NUM_TIME: return `EXCH_NUM_TIME${a.role ? ' full' : ''}`;
    case ATOM.CONTROL: return 'CONTROL';
    case ATOM.GRID4: return `GRID4${a.role ? ' full' : ''}`;
    case ATOM.TEXT5: return 'TEXT5';
  }
  return '?';
}

/**
 * The bit fields of a 34-bit payload, for colouring: [{ name, start, len, value, text }].
 * Indices are 0-based into the payload.
 */
export function payloadFields(bits) {
  const i2 = bitsVal(bits, 30, 32), F = [];
  const f = (name, start, len, text) => F.push({ name, start, len, value: bitsVal(bits, start, start + len), text });
  if (i2 <= 1) { const n28 = bitsVal(bits, 0, 28); f('call28', 0, 28, unpackCall(n28) || '?'); f('n2', 28, 2, CALL_ACTIONS[(i2 ? 4 : 0) + bitsVal(bits, 28, 30)] || 'reserved'); }
  else if (i2 === 2) {
    const fam = bitsVal(bits, 27, 30);
    // body27 is bits 0-26, fields from its high end (bit 0) down
    if (fam === 0) { f('role', 0, 1); f('kind', 1, 4, NUM_KINDS[bitsVal(bits, 1, 5)]); f('value17', 5, 17); f('zero5', 22, 5); }
    else if (fam === 1) { f('role', 0, 1); f('kind', 1, 4, LOC_KINDS[bitsVal(bits, 1, 5)]); f('len', 5, 1); f('token16', 6, 16); f('zero5', 22, 5); }
    else if (fam === 2) { f('schema', 0, 3, ['ZONE_LOC3', 'CLASS_SECTION'][bitsVal(bits, 0, 3)]); f('pair23', 3, 23); f('zero1', 26, 1); }
    else if (fam === 3) { f('role', 0, 1); f('serial14', 1, 14); f('minute11', 15, 11); f('zero1', 26, 1); }
    else if (fam === 4) { const sub = bitsVal(bits, 0, 4); f('subtype', 0, 4, ['CONTROL', 'GRID4'][sub]); f(sub === 1 ? 'role+grid' : 'phrase', 4, sub === 1 ? 16 : 7); f('zero', sub === 1 ? 20 : 11, sub === 1 ? 7 : 16); }
    else f('body27', 0, 27);
    f('family', 27, 3, FAMILY_NAMES[fam]);
  } else { for (let i = 0; i < 5; i++) f('char' + (i + 1), 6 * i, 6, JSON.stringify(sourceChar(bitsVal(bits, 6 * i, 6 * i + 6)))); }
  f('i2', 30, 2, ['call', 'call', 'STRUCT30', 'TEXT5'][i2]);
  f('reserved', 32, 1); f('EOM', 33, 1);
  return F;
}

/** normalize_jtty_message: upper case, single spaces, unsupported characters to '#', '~' is a space. */
export function normalizeMessage(raw) {
  let out = '', lastSpace = true;
  for (let c of raw.slice(0, 80)) {
    if (c === '\0' || c === '~') c = ' ';
    if (c >= 'a' && c <= 'z') c = c.toUpperCase();
    if (sourceIndex(c) < 0) c = '#';
    if (c === ' ') { if (lastSpace) continue; out += ' '; lastSpace = true; }
    else { out += c; lastSpace = false; }
  }
  return out.trimEnd();
}

function decimalValue(text) {
  if (text.length < 1 || text.length > 6 || !/^[0-9]+$/.test(text)) return null;
  const v = parseInt(text, 10); return v <= 131071 ? v : null;
}
// pack77_arrl_section_index() returns -1 for a string shorter than 3 characters, and pack_jtty
// passes it trim(word), so two-letter sections (CT, DX, AB...) never pack as CLASS_SECTION from
// text. Ported as is; the native Field Day macro path is not affected.
const sectionIndex = s => s.length < 3 ? -1 : FIELD_DAY_SECTIONS.indexOf(s) + 1;

/**
 * pack_jtty: the fewest frames that reproduce the normalized text exactly.
 * dp[i] = minimum frames for msg[i:]; each position considers a TEXT5 frame and, at a token
 * boundary, every compact atom whose rendering matches the text there. Ties prefer a structured
 * atom, then the longer span, then the lower kind/subtype/role key.
 * Returns { text, atoms, frames, spans } or { error }.
 */
export function packMessage(message, profile = PROFILE.UNKNOWN) {
  let msg = normalizeMessage(message);
  if (profile === PROFILE.RTTY) { msg = normalizeSerials(msg); if (msg == null) return { error: 'serial normalization made the message longer than 80 characters' }; }
  const n = msg.length;
  if (!n) return { text: '', atoms: [], frames: [], spans: [] };
  const INF = 999;
  const dp = new Array(n + 2).fill(INF), succ = new Array(n + 2).fill(0), choice = new Array(n + 2).fill(null);
  dp[n + 1] = 0;
  const kindKey = a => 100 * a.kind + 2 * a.subtype + a.role;
  let ipos = 0;   // 1-based, as in the Fortran
  const consider = (a, next) => {
    const cost = 1 + dp[next];
    if (cost > MAX_FRAMES || cost > dp[ipos]) return;
    if (cost === dp[ipos] && choice[ipos]) {
      const rank = a.kind === ATOM.TEXT5 ? 1 : 0, best = choice[ipos].kind === ATOM.TEXT5 ? 1 : 0;
      if (rank > best) return;
      if (rank === best) { if (next < succ[ipos]) return; if (next === succ[ipos] && kindKey(a) >= kindKey(choice[ipos])) return; }
    }
    dp[ipos] = cost; succ[ipos] = next; choice[ipos] = a;
  };
  const offer = a => {
    const bits = packAtom(a); if (!bits) return;
    const u = unpackAtom(bits); if (!u) return;
    const r = renderAtom(u.atom); if (!r) return;
    const len = r.trimEnd().length; if (!len) return;
    const last = ipos + len - 1; if (last > n) return;
    if (msg.slice(ipos - 1, last) !== r.slice(0, len)) return;
    let next = n + 1;
    if (last < n) { if (msg[last] !== ' ') return; next = last + 2; }   // structured frames supply one separator
    consider(a, next);
  };
  const tryCompact = () => {
    const words = []; let first = ipos;
    for (let j = 0; j < 3 && first <= n; j++) {
      let sp = msg.indexOf(' ', first - 1); const last = sp < 0 ? n : sp;   // 1-based last = sp (0-based index of space)
      words.push(msg.slice(first - 1, last)); first = last + 2;
    }
    for (const w of words) { if (w.length > 13) continue; for (let act = 0; act <= 5; act++) offer(callAtom(act, w)); }
    for (let j = 0; j < CONTROL_TEXT.length; j++) offer(controlAtom(j));
    for (let rl = ROLE_FIELD_ONLY; rl <= ROLE_FULL; rl++) {
      let fi = 0;
      if (rl === ROLE_FULL) { if (words[0] !== '599' || words.length < 2) continue; fi = 1; }
      const w = words[fi], v = decimalValue(w);
      if (v != null) offer(numAtom(rl, NUM.GENERIC, v));
      if (v != null && rl === ROLE_FULL && profile === PROFILE.RTTY) offer(numAtom(rl, NUM.SERIAL, v));
      if (w.length === 4) offer(grid4Atom(rl, w));
      if (rl !== ROLE_FULL || w.length < 2 || w.length > 3) continue;
      if (!/[A-Z]/.test(w)) continue;
      offer(locAtom(rl, LOC.QTH, w));
      if (profile === PROFILE.RTTY) offer(locAtom(rl, LOC.STATE_PROVINCE, w));
    }
    const w0 = words[0];
    if (words.length < 2 || w0.length < 2 || w0.length > 3) return;
    const cnt = decimalValue(w0.slice(0, -1)); if (cnt == null) return;
    offer(classSectionAtom(cnt, w0.slice(-1), sectionIndex(words[1])));
  };
  for (ipos = n; ipos >= 1; ipos--) {
    const inext = Math.min(n + 1, ipos + 5);
    consider(text5Atom(msg.slice(ipos - 1, inext - 1)), inext);
    if (ipos > 1 && msg[ipos - 2] !== ' ') continue;
    tryCompact();
  }
  if (dp[1] > MAX_FRAMES) return { error: `needs more than ${MAX_FRAMES} frames` };
  const atoms = [], spans = [];
  for (let p = 1; p <= n; p = succ[p]) { atoms.push(choice[p]); spans.push([p - 1, Math.min(n, succ[p] - 1)]); }
  const frames = atoms.map((a, i) => packAtom(a, i === atoms.length - 1));
  if (frames.some(f => !f)) return { error: 'an atom failed to pack' };
  return { text: msg, atoms, frames, spans };

  function normalizeSerials(m) {
    const toks = m.split(' '), out = [];
    for (let i = 0; i < toks.length; i++) {
      out.push(toks[i]);
      if (toks[i] === '599' && i + 1 < toks.length) {
        const v = decimalValue(toks[i + 1]);
        if (v != null) { out.push(renderNumber(NUM.SERIAL, v)); i++; }
      }
      if (out.join(' ').length > 80) return null;
    }
    return out.join(' ');
  }
}

/**
 * unpack_jtty for a single frame, as the receiver calls it: the rendered text with TEXT5 blanks
 * shown as '~', whether it ends with the implicit separator, its EOM flag, and validity.
 */
export function unpackFrame(bits) {
  const u = unpackAtom(bits); if (!u) return { valid: false };
  const r = renderAtom(u.atom); if (r == null) return { valid: false };
  if (u.atom.kind === ATOM.TEXT5) return { valid: true, text: r.replace(/ /g, '~'), trailingSep: false, eom: u.eom, atom: u.atom };
  return { valid: true, text: r.trimEnd(), trailingSep: true, eom: u.eom, atom: u.atom };
}

/** unpack_jtty over a whole message's frames, with display spacing (for the encode page). */
export function unpackMessage(frames) {
  let msg = '';
  for (const b of frames) {
    const f = unpackFrame(b); if (!f.valid) continue;
    msg += f.text + (f.trailingSep ? ' ' : '');
  }
  return msg.replace(/~/g, ' ').trim();
}
