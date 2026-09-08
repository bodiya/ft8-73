// A-priori (AP) decoding helpers. Port of apply_ap_cq / apply_ap_mycall (wsjtr wsjt_ft8.rs, WSJT-X ft8b.f90)
// and callsign_to_ap_bits (ft8core pack77.rs, WSJT-X ft8apset.f90).
// LLR convention here: NEGATIVE => bit 1 (jt9r convention, as in ldpc.js / pipeline.js).
import { pack28 } from './pack77.js';

const NTOKENS = 2063592, MAX22 = 4194304;
// WSJT-X MCQ pattern (bits 1..29 of a "CQ ..." standard message), +1 => bit 1, -1 => bit 0.
const MCQ = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, -1, -1];
/** The 29 constrained bits of a CQ message as 0/1 (28-bit pack28("CQ") = 2, then ipa = 0). */
export const AP_CQ_BITS = MCQ.map(v => (v > 0 ? 1 : 0));

function apmag(llr) { let m = 0; for (const v of llr) m = Math.max(m, Math.abs(v)); return m * 1.1; }

/** Force bits 0..28 to the CQ pattern and bits 74..76 to i3 = 1, at 1.1× the largest |LLR|. Returns a new array. */
export function applyApCq(llr) {
  const out = Float64Array.from(llr), a = apmag(llr);
  for (let i = 0; i < 29; i++) out[i] = -a * MCQ[i];
  out[74] = a; out[75] = a; out[76] = -a;           // i3 = 0b001
  return out;
}

/** Same as applyApCq but bits 0..28 come from the operator's callsign (mycallBits29 in WSJT-X ±1 convention). */
export function applyApMyCall(llr, mycallBits29) {
  const out = Float64Array.from(llr), a = apmag(llr);
  for (let i = 0; i < 29; i++) out[i] = -a * mycallBits29[i];
  out[74] = a; out[75] = a; out[76] = -a;
  return out;
}

/** 29 AP bits (±1, +1 => bit 1) for a standard callsign, or null for CQ/DE/QRZ/hashed/nonstandard calls. */
export function callsignToApBits(callsign) {
  const n28 = pack28(callsign);
  if (n28 == null || n28 < NTOKENS + MAX22) return null;
  const bits = new Float64Array(29);
  for (let i = 0; i < 28; i++) bits[i] = ((n28 >>> (27 - i)) & 1) ? 1 : -1;
  bits[28] = -1; // ipa = 0
  return bits;
}

/** Which codeword bit indices an AP pass constrains (for display). */
export const AP_CONSTRAINED_BITS = [...Array.from({ length: 29 }, (_, i) => i), 74, 75, 76];
