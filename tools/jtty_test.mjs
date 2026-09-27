// JTTY port checks against WSJT-X 3.2's Fortran (lib/jtty on the jtty-receiver-defaults branch).
//   node tools/jtty_test.mjs          everything, including the ~10 s receiver run
//   node tools/jtty_test.mjs --quick  skip the receiver run
// Fixtures in tools/fixtures were produced by small Fortran drivers linked against that code:
// jtty_encode.json from pack_jtty + tbcc_encode, jtty_list.json from jtty_tbcc_list_wava and
// jtty_tbcc_decode on noisy correlation sets, data/260807_134110.jtty.json from rjtty.
import fs from 'node:fs';
import { packMessage, unpackAtom, renderAtom, packAtom, standardCall, PROFILE } from '../src/dsp/jtty/codec.js';
import { tbccEncode, listWava, tbccDecode, crc12, appendCrc12 } from '../src/dsp/jtty/fec.js';
import { parseWav } from '../src/dsp/wav.js';
import { Receiver } from '../src/dsp/jtty/receiver.js';

let fails = 0;
const check = (ok, what) => { if (!ok) { fails++; console.log('FAIL', what); } };
const bits = s => Uint8Array.from(s, c => +c);

// 1. jtty_source_encoding.txt's representative 34-bit vectors
const VECTORS = [
  ['CQ K1ABC CQ', '0000100110111101111000110101000001'],
  ['599 123', '1000000000000001111011000000001000', false],
  ['599 123', '1000000000000001111011000000001001'],
  ['599 CA', '1000000000000110111010000000011001'],
  ['599 05 NWT', '0000001011011110010000110100101001'],
  ['1D EMA', '0010000010110001011000000000101001'],
  ['599 156 1749', '1000000100111001000010110100111001'],
  ['AGN?', '0000000000000000000000000001001001'],
  ['FN42', '0001001010000110011000000001001001'],
  ['HELLO', '0100010011100101010101010110001101'],
];
for (const [text, v] of VECTORS) {
  const u = unpackAtom(bits(v)); const r = u && renderAtom(u.atom);
  check(r === text, `vector ${v} renders ${JSON.stringify(r)}, want ${text}`);
  const again = u && packAtom(u.atom, u.eom);
  check(again && Array.from(again).join('') === v, `vector ${text} repacks`);
}
console.log(`source vectors: ${VECTORS.length} checked`);

// 2. frame counts from jtty_design.md
const COUNTS = [['CQ K1ABC CQ', 1], ['CQ KA1ABC CQ', 1], ['WB9XYZ', 1], ['WB9XYZ TU CQ KA1ABC CQ', 2], ['WB9XYZ 599 123', 2], ['599 123', 1],
  ['599 MA', 1], ['599 FN42', 1], ['1D EMA', 1], ['599 001', 2], ['599 05', 2], ['599 BRUCE', 2],
  ['599 001', 1, PROFILE.RTTY], ['K1ABC 599 001', 2, PROFILE.RTTY], ['599 05', 1, PROFILE.RTTY], ['599 0123', 1, PROFILE.RTTY]];
for (const [m, n, prof] of COUNTS) { const r = packMessage(m, prof || 0); check(r.frames && r.frames.length === n, `${m} (profile ${prof || 0}): ${r.frames ? r.frames.length : r.error} frames, want ${n}`); }
check(packMessage('599 05', PROFILE.RTTY).text === '599 005', 'RTTY Roundup renders 599 05 as 599 005');
check(standardCall('KA1ABC') && !standardCall('PJ4/KA1ABC') && !standardCall('Q1ABC'), 'standard call filter');
console.log(`frame counts: ${COUNTS.length} checked`);

// 3. frames and tones against pack_jtty + tbcc_encode
const enc = JSON.parse(fs.readFileSync('tools/fixtures/jtty_encode.json'));
let nf = 0;
for (const e of enc) {
  const r = packMessage(e.input, e.profile);
  check(!r.error && r.frames.length === e.nframes, `${e.input}: ${r.error || r.frames.length} frames, Fortran ${e.nframes}`);
  if (r.error) continue;
  check(r.text === e.normalized, `${e.input}: normalized ${JSON.stringify(r.text)}, Fortran ${JSON.stringify(e.normalized)}`);
  r.frames.forEach((f, i) => { nf++; check(Array.from(f).join('') === e.frames[i], `${e.input} frame ${i + 1} bits`); check(Array.from(tbccEncode(f).tones).join('') === e.tones[i], `${e.input} frame ${i + 1} tones`); });
}
const info = appendCrc12(bits(enc[0].frames[0])); check(crc12(info) === 0, 'CRC-12 of an encoded word is zero');
console.log(`encoder: ${enc.length} messages, ${nf} frames compared`);

// 4. the list-Viterbi decoder against jtty_tbcc_list_wava and the ladder against jtty_tbcc_decode
const lf = JSON.parse(fs.readFileSync('tools/fixtures/jtty_list.json'));
let nc = 0;
for (const [ci, c] of lf.entries()) {
  const z = { re: Float64Array.from(c.re, Math.fround), im: Float64Array.from(c.im, Math.fround) };
  for (const rg of c.rungs) {
    const r = listWava(z, rg.L);
    check(r.pool === rg.pool, `case ${ci} L=${rg.L}: pool ${r.pool}, Fortran ${rg.pool}`);
    rg.cands.forEach((fc, k) => { nc++; const j = r.candidates[k];
      check(j && Array.from(j.bits).join('') === fc.bits && j.crc === fc.crc && j.start === fc.start, `case ${ci} L=${rg.L} hypothesis ${k + 1}`);
      check(j && Math.abs(j.clean - fc.clean) <= 1e-4 * Math.abs(fc.clean), `case ${ci} L=${rg.L} hypothesis ${k + 1} metric ${j && j.clean} vs ${fc.clean}`); });
  }
  const d = tbccDecode(z);
  check(d.ok === !!c.decoded && (!d.ok || Array.from(d.payload).join('') === c.decoded), `case ${ci}: ladder decode agrees`);
}
console.log(`list decoder: ${lf.length} correlation sets, ${nc} hypotheses compared, ${lf.filter(c => c.decoded).length} decode`);

// 5. the receiver on the WSJT-X sample against rjtty's output
if (!process.argv.includes('--quick')) {
  const ref = JSON.parse(fs.readFileSync('data/260807_134110.jtty.json'));
  const { samples } = parseWav(fs.readFileSync('data/260807_134110.wav').buffer);
  const t = Date.now(); const rx = new Receiver().decodeAll(samples);
  check(rx.events.length === ref.frames.length, `receiver: ${rx.events.length} frame decodes, rjtty ${ref.frames.length}`);
  ref.frames.forEach((f, i) => { const e = rx.events[i]; if (!e) return;
    check(e.message === f.message && Math.abs(e.f1 - f.f1) <= 0.051 && Math.abs(e.xdt - f.xdt) <= 0.0006 && Math.abs(e.tsync - f.tsync) <= 0.0006 && e.snr === f.snr && e.nsync === f.nsync && e.nsymerrs === f.nsymerrs,
      `frame ${i + 1}: ${e.f1.toFixed(1)} ${e.tsync.toFixed(3)} ${e.snr} ${e.nsync} ${e.nsymerrs} ${e.message} | rjtty ${f.f1} ${f.tsync} ${f.snr} ${f.nsync} ${f.nsymerrs} ${f.message}`); });
  const msgs = [...rx.messages.values()];
  console.log(`receiver: ${rx.events.length} frames in ${Date.now() - t} ms -> ${msgs.map(m => JSON.stringify(m.text) + (m.complete ? ' (EOM)' : '')).join(', ')}`);
}
console.log(fails ? `${fails} FAILED` : 'all JTTY checks pass');
process.exit(fails ? 1 : 0);
