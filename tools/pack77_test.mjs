// Round-trip pack77 -> unpack77 on the bundled decode lists and fixed cases; check the tone chain; compare with ft8coder if present.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pack77, pack28, describeBits77, callsignToApBits } from '../src/dsp/pack77.js';
import { unpack77 } from '../src/dsp/unpack77.js';
import { appendCrc, ldpcEncode, checkCrc } from '../src/dsp/ldpc.js';
import { tonesFromBits77 } from '../src/dsp/pipeline.js';

let fail = 0, n = 0;
const check = (cond, msg) => { n++; if (!cond) { fail++; console.log('FAIL', msg); } };
const truth = JSON.parse(fs.readFileSync('data/260726_190930.decodes.json'));
const msgs = new Set([...truth.wsjtr, ...truth.wsjtx].map(d => d.message).filter(m => !m.includes('<')));
for (const m of ['CQ K1ABC FN42', 'TNX BOB 73', 'K1ABC W9XYZ RR73', 'CQ POTA WA9TT EN54', 'KN1OBI OK1PVT R-14', 'CQ DX K1ABC', 'CQ 123 K1ABC', 'K1ABC W9XYZ +05', 'K1ABC W9XYZ R-12', 'K1ABC/P W9XYZ FN42', 'K1ABC/R W9XYZ RRR', 'QRZ K1ABC', 'DE K1ABC FN42', 'CQ KC1WIH/QRP', 'WA9XYZ KA1ABC R 16A EMA', 'TU; W9XYZ K1ABC R 579 MA', 'HELLO WORLD', 'CQ TEST K1ABC', 'K1ABC W9XYZ']) msgs.add(m);
for (const m of msgs) {
  const p = pack77(m); const u = unpack77(p.bits);
  const expect = m === 'CQ KC1WIH/QRP' ? m : m; // type 4 CQ round-trips exactly (no hash side)
  check(u && u.text === expect, `roundtrip "${m}" -> "${u && u.text}" (type ${p.type})`);
  const cw = ldpcEncode(appendCrc(p.bits)); check(cw.length === 174 && checkCrc(cw.slice(0, 91)), `crc/ldpc ${m}`);
  const { tones } = tonesFromBits77(p.bits); check(tones.length === 79 && [3, 1, 4, 0, 6, 5, 2].every((t, i) => tones[i] === t && tones[36 + i] === t && tones[72 + i] === t), `costas ${m}`);
}
// type 4 with a hashed side: text shows <...> for the hash
{ const p = pack77('KC1WIH/QRP K1ABC RR73'); const u = unpack77(p.bits); check(u && u.text === 'KC1WIH/QRP <...> RR73' && p.type.startsWith('4'), `type4 hashed side -> ${u && u.text}`); }
// field annotation
{ const p = pack77('KN1OBI OK1PVT R-14'); const f = Object.fromEntries(p.fields.map(x => [x.name, x])); check(f['call 1 (28-bit)'].text === 'KN1OBI' && f['call 2 (28-bit)'].text === 'OK1PVT' && f['grid / report (15-bit)'].text === 'R-14 (report)' && f['ir: R (roger) flag'].value === 1, 'fields R-14'); }
{ const p = pack77('CQ POTA WA9TT EN54'); const f = p.fields[0]; check(f.text === 'CQ POTA' && p.fields[5].text === 'EN54 (grid)', 'fields CQ POTA'); }
{ const d = describeBits77(pack77('HELLO WORLD').bits); check(d.type === '0.0' && d.text === 'HELLO WORLD', 'describe free text'); }
check(pack28('CQ') === 2 && pack28('DE') === 0 && pack28('QRZ') === 1, 'pack28 tokens');
check(callsignToApBits('K1ABC') && callsignToApBits('K1ABC').length === 29 && callsignToApBits('CQ') === null, 'ap bits');

// Reference comparisons (the strongest check). wsjtr's ft8coder is the port target, but for the
// h12 hash in type-4 messages it disagrees with WSJT-X itself, so those cases are checked against
// WSJT-X's own ft8code and listed here rather than silently matched to the divergence:
//   CQ <nonstandard call>   wsjtr writes h12 = 0; WSJT-X writes the hash of the nonstandard call,
//                           which is how a receiver learns to resolve that <...> later.
//   <CALL> in either slot   wsjtr hashes the call with its angle brackets attached.
// A wsjtr transmission of those messages is a different codeword from WSJT-X's, and re-encoding
// one for subtraction would not match the received signal.
const WSJTR_DIVERGES = new Set(['CQ KC1WIH/QRP', 'CQ W9XYZ/MM', '<K1ABC> KC1WIH/QRP RR73', 'KC1WIH/QRP <K1ABC> 73']);
const CASES = ['CQ K1ABC FN42', 'KN1OBI OK1PVT R-14', 'K1ABC W9XYZ RR73', 'CQ POTA WA9TT EN54', 'TNX BOB 73', 'K1ABC/P W9XYZ FN42', 'CQ KC1WIH/QRP', 'CQ W9XYZ/MM', '<K1ABC> KC1WIH/QRP RR73', 'KC1WIH/QRP <K1ABC> 73', 'KC1WIH TNX 73', 'WA9XYZ KA1ABC R 16A EMA', 'TU; W9XYZ K1ABC R 579 MA', 'CQ DX K1ABC', 'CQ 123 K1ABC', 'C6AVD N4MC +01', 'CQ 9A2L JN83'];
const coder = '/home/brian/repos/wsjtr-public/target/release/ft8coder';
const ft8code = '/usr/bin/ft8code';
const haveCoder = fs.existsSync(coder), haveFt8code = fs.existsSync(ft8code);
let cmp = 0, skipped = 0;
for (const m of CASES) {
  const useWsjtx = WSJTR_DIVERGES.has(m);
  if (useWsjtx ? !haveFt8code : !haveCoder) { skipped++; continue; }
  const { tones } = tonesFromBits77(pack77(m).bits);
  let ref;
  if (useWsjtx) {
    const out = execFileSync(ft8code, [m], { encoding: 'utf8' });
    const bits = out.split('\n')[out.split('\n').findIndex(l => l.includes('77 bits')) + 1].trim();
    ref = tonesFromBits77(Uint8Array.from(bits, c => +c)).tones;
  } else {
    let out; try { out = execFileSync(coder, [m], { encoding: 'utf8' }); } catch (e) { console.log('ft8coder failed on', m, e.message.split('\n')[0]); continue; }
    ref = out.trim().split(/\s+/).map(Number);
  }
  check(ref.length === 79 && ref.every((t, i) => t === tones[i]), `${useWsjtx ? 'ft8code (WSJT-X)' : 'ft8coder'} tones "${m}"`); cmp++;
}
console.log(`compared ${cmp} messages against reference encoders${skipped ? `, skipped ${skipped} (binary missing)` : ''}`);
console.log(`${n - fail}/${n} checks passed over ${msgs.size} messages`);
process.exit(fail ? 1 : 0);
