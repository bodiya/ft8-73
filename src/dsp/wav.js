// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Minimal WAV reader: 16-bit PCM (mono or first channel) -> Float32Array samples in [-32768, 32767] range
// (kept as integer-scale floats, matching what wsjtr/WSJT-X feed into the decoder).
export function parseWav(buf) {
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= dv.byteLength) {
    const id = tag(off), size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === 'data') data = { off: off + 8, size };
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('bad WAV');
  const bytes = fmt.bits / 8, frames = Math.floor(data.size / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = data.off + i * bytes * fmt.channels;
    if (fmt.bits === 16) out[i] = dv.getInt16(o, true);
    else if (fmt.bits === 32 && fmt.format === 3) out[i] = dv.getFloat32(o, true) * 32767;
    else if (fmt.bits === 32) out[i] = dv.getInt32(o, true) / 65536;
    else if (fmt.bits === 8) out[i] = (dv.getUint8(o) - 128) * 256;
  }
  return { samples: out, rate: fmt.rate };
}

export async function loadWav(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url + ': ' + r.status);
  return parseWav(await r.arrayBuffer());
}
