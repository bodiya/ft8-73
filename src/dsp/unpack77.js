// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
// Derived from WSJT-X (https://wsjt.sourceforge.io/). Copyright 2001 - 2026 by Joe Taylor, K1JT,
// and the WSJT Development Team. Licensed under GPLv3.
//
// 77-bit message unpacking. Port of wsjtr ft8core unpack77.rs (WSJT-X packjt77.f90). No hash table (hashed calls -> <...>).
const NTOKENS = 2063592, MAX22 = 4194304, MAXGRID4 = 32400;
const A1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', A2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', A3 = '0123456789', A4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE38 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/', FT_CHARS = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
const FIELD_DAY_SECTIONS = 'AB AK AL AR AZ BC CO CT DE EB EMA ENY EPA EWA GA GH IA ID IL IN KS KY LA LAX NS MB MDC ME MI MN MO MS MT NC ND NE NFL NH NL NLI NM NNJ NNY TER NTX NV OH OK ONE ONN ONS OR ORG PAC PR QC RI SB SC SCV SD SDG SF SFL SJV SK SNJ STX SV TN UT VA VI VT WCF WI WMA WNY WPA WTX WV WWA WY DX PE NB'.split(' ');
const RTTY_MULTS = ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY NB NS QC ON MB SK AB BC NWT NF LB NU YT PEI DC DR FR GD GR OV ZH ZL').split(' ').concat(Array.from({ length: 99 }, (_, i) => 'X' + String(i + 1).padStart(2, '0')));

const bi = (bits, a, b) => { let n = 0; for (let i = a; i < b; i++) n = n * 2 + bits[i]; return n; };

function callsignOk(call) {
  const n = call.length; if (n < 3 || call[0] === 'Q') return false;
  let i0 = 0; for (let i = n - 1; i >= 0; i--) if (/[0-9]/.test(call[i])) { i0 = i + 1; break; }
  if (i0 !== 2 && i0 !== 3) return false;
  if (!/[A-Z]/.test(call.slice(0, i0 - 1))) return false;
  return /^[A-Z]*$/.test(call.slice(i0));
}
function unpack28(n28) {
  if (n28 === 0) return 'DE'; if (n28 === 1) return 'QRZ'; if (n28 === 2) return 'CQ';
  if (n28 < 1003) return 'CQ ' + String(n28 - 3).padStart(3, '0');
  if (n28 < NTOKENS) { let m = n28 - 1003, s = ''; for (let k = 0; k < 4; k++) { const j = m % 27; m = Math.floor(m / 27); if (j > 0) s = String.fromCharCode(64 + j) + s; } return s ? 'CQ ' + s : 'CQ'; }
  if (n28 < NTOKENS + MAX22) return '<...>';
  let n = n28 - NTOKENS - MAX22;
  const i6 = n % 27; n = Math.floor(n / 27); const i5 = n % 27; n = Math.floor(n / 27); const i4 = n % 27; n = Math.floor(n / 27);
  const i3 = n % 10; n = Math.floor(n / 10); const i2 = n % 36; n = Math.floor(n / 36); const i1 = n % 37;
  const call = (A1[i1] + A2[i2] + A3[i3] + A4[i4] + A4[i5] + A4[i6]).trim();
  if (call.includes(' ') || !callsignOk(call)) return null;
  return call;
}
function gridReport(igrid4, ir) {
  if (igrid4 < MAXGRID4) {
    const j4 = igrid4 % 10, j3 = Math.floor(igrid4 / 10) % 10, j2 = Math.floor(igrid4 / 100) % 18, j1 = Math.floor(igrid4 / 1800);
    const g = String.fromCharCode(65 + j1, 65 + j2, 48 + j3, 48 + j4); return ir ? 'R ' + g : g;
  }
  const irpt = igrid4 - MAXGRID4;
  if (irpt === 1) return ''; if (irpt === 2) return 'RRR'; if (irpt === 3) return 'RR73'; if (irpt === 4) return '73';
  let snr = irpt - 35; if (snr > 50) snr -= 101;
  const c = (snr < 0 ? '-' : '+') + String(Math.abs(snr)).padStart(2, '0'); return ir ? 'R' + c : c;
}
function type1(bits, i3) {
  const c1 = unpack28(bi(bits, 0, 28)), c2 = unpack28(bi(bits, 29, 57)); if (c1 == null || c2 == null) return null;
  const sfx = i3 === 2 ? '/P' : '/R';
  const a = c1 + (bits[28] ? sfx : ''), b = c2 + (bits[57] ? sfx : '');
  const rep = gridReport(bi(bits, 59, 74), bits[58]);
  return rep ? `${a} ${b} ${rep}` : `${a} ${b}`;
}
function freeText(bits) {
  let n = 0n; for (let i = 0; i < 71; i++) n = (n << 1n) | BigInt(bits[i]);
  let s = ''; for (let k = 0; k < 13; k++) { s = FT_CHARS[Number(n % 42n)] + s; n /= 42n; } return s.trim();
}
function type4(bits) {
  let n58 = 0n; for (let i = 12; i < 70; i++) n58 = (n58 << 1n) | BigInt(bits[i]);
  let c11 = ''; for (let k = 0; k < 11; k++) { c11 = BASE38[Number(n58 % 38n)] + c11; n58 /= 38n; } c11 = c11.trimStart();
  const iflip = bits[70], nrpt = bi(bits, 71, 73), icq = bits[73];
  const [call1, call2] = iflip === 0 ? ['<...>', c11] : [c11, '<...>'];
  if (icq) return 'CQ ' + call2;
  return `${call1} ${call2}${['', ' RRR', ' RR73', ' 73'][nrpt] || ''}`;
}
function fieldDay(bits, n3) {
  const c1 = unpack28(bi(bits, 0, 28)), c2 = unpack28(bi(bits, 28, 56)); if (c1 == null || c2 == null) return null;
  const ir = bits[56], intx = bi(bits, 57, 61), ncls = bi(bits, 61, 64), isec = bi(bits, 64, 71);
  if (isec === 0 || isec > FIELD_DAY_SECTIONS.length) return null;
  const ntx = intx + 1 + (n3 === 4 ? 16 : 0);
  return `${c1} ${c2} ${ir ? 'R ' : ''}${ntx}${String.fromCharCode(65 + ncls)} ${FIELD_DAY_SECTIONS[isec - 1]}`;
}
function type3(bits) {
  const itu = bits[0], c1 = unpack28(bi(bits, 1, 29)), c2 = unpack28(bi(bits, 29, 57)); if (c1 == null || c2 == null) return null;
  const ir = bits[57], irpt = bi(bits, 58, 61), nexch = bi(bits, 61, 74);
  let exch; if (nexch >= 8000) { const im = nexch - 8000; if (im === 0 || im > RTTY_MULTS.length) return null; exch = RTTY_MULTS[im - 1]; } else if (nexch >= 1) exch = String(nexch).padStart(4, '0'); else return null;
  return [itu ? 'TU;' : null, c1, c2, ir ? 'R' : null, `5${irpt + 2}9`, exch].filter(Boolean).join(' ');
}
function type5(bits) {
  const ir = bits[34], irpt = bi(bits, 35, 38), iserial = bi(bits, 38, 49); let n = bi(bits, 49, 74);
  if (n > 18 * 18 * 10 * 10 * 24 * 24 - 1) return null;
  const j6 = n % 24; n = Math.floor(n / 24); const j5 = n % 24; n = Math.floor(n / 24); const j4 = n % 10; n = Math.floor(n / 10); const j3 = n % 10; n = Math.floor(n / 10); const j2 = n % 18; n = Math.floor(n / 18);
  const grid6 = String.fromCharCode(65 + n, 65 + j2, 48 + j3, 48 + j4, 65 + j5, 65 + j6);
  return `<...> <...> ${ir ? 'R ' : ''}${52 + irpt}${String(iserial).padStart(4, '0')} ${grid6}`;
}

/** Returns { text, i3, n3, type } or null. */
export function unpack77(bits) {
  const n3 = bi(bits, 71, 74), i3 = bi(bits, 74, 77);
  let text = null, type = `i3=${i3}`;
  if (i3 === 0) {
    type = `0.${n3}`;
    if (n3 === 0) text = freeText(bits); else if (n3 === 3 || n3 === 4) text = fieldDay(bits, n3);
    else if (n3 === 5) text = [bi(bits, 0, 23), bi(bits, 23, 47), bi(bits, 47, 71)].map(v => v.toString(16).toUpperCase().padStart(6, '0')).join('');
  } else if (i3 === 1 || i3 === 2) { type = i3 === 1 ? '1 (standard)' : '2 (EU VHF /P)'; text = type1(bits, i3); }
  else if (i3 === 3) { type = '3 (RTTY RU)'; text = type3(bits); }
  else if (i3 === 4) { type = '4 (nonstandard call)'; text = type4(bits); }
  else if (i3 === 5) { type = '5 (EU VHF)'; text = type5(bits); }
  if (text == null) return null;
  return { text: text.trim(), i3, n3, type };
}

/** Mirror of wsjt_ft8.rs wsjtx_message_ok sanity gate. */
export function messageOk(bits, text) {
  const n3 = bi(bits, 71, 74), i3 = bi(bits, 74, 77);
  if (i3 > 5 || (i3 === 0 && n3 > 6)) return false;
  if (i3 === 0 && n3 === 2) return false;
  if (text.includes('?')) return false;
  if (i3 >= 1 && i3 <= 3 && (text.includes('/R') || text.startsWith('TU; '))) return false;
  return true;
}
