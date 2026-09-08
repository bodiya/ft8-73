// Encode side: message -> 77 bits -> CRC -> LDPC -> Gray tones -> GFSK audio.
//
// Drawing is split into a background layer that depends only on the controls (message, audio
// frequency, SNR) and a transparent overlay that carries the playhead. The background holds the
// two expensive plots: a 337-frame spectrogram and a 192 000-point spectrum of the whole
// transmission. They are redrawn when you change a control, not 60 times a second.
import { pack77, describeBits77 } from '../dsp/pack77.js';
import { appendCrc, ldpcEncode, crc14 } from '../dsp/ldpc.js';
import { tonesFromBits77 } from '../dsp/pipeline.js';
import { GRAY_MAP, COSTAS, isSyncSymbol, FS } from '../dsp/constants.js';
import { powerSpectrum } from '../dsp/fft.js';
import { slider, select, checkbox, el, panel, canvas, layers, button } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, text, hline, vline, clear, linePlot } from '../ui/draw.js';

const st = { p: { msg: 'CQ KC1WIH FN42', f0: 1000, snrDb: 99, volume: 0.5 }, unsubs: [], audioCtx: null, src: null };
const FIELD_COLORS = ['#4ea1ff', '#ff8c42', '#3ddc97', '#ffd166', '#c792ea', '#8b93a3', '#4ea1ff', '#ff8c42'];
let synth = null; // { synthesizeFt8 } from subtract.js, loaded lazily

function stopAudio() { if (st.src) { try { st.src.stop(); } catch { } st.src = null; } }

export default {
  mount(root, app) {
    const p = st.p;
    root.append(el('h1', null, 'E · The encode side: from a message to 79 tones'));
    root.append(el('p', 'blurb', 'Type a message and watch it become a transmission. Standard messages pack two callsigns into 28 bits each (base-37 arithmetic over the allowed characters), a grid or report into 15 bits, and a 3-bit type. A 14-bit CRC is appended, the (174,91) LDPC code adds 83 parity bits, the 174 bits are cut into 58 three-bit symbols, Gray-mapped to tones 0–7, and the three Costas arrays are inserted at symbols 0, 36 and 72. Each tone lasts 160 ms; the frequency ramps smoothly between tones (Gaussian-filtered FSK, BT = 2) so the signal stays only ~50 Hz wide. Press play to hear it and to step through the symbols.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div'); main.style.flex = '1'; row.append(main);
    const msgW = el('div', 'ctl'); msgW.innerHTML = '<div class="lab">message</div>'; const msgIn = el('input'); msgIn.type = 'text'; msgIn.value = p.msg; msgIn.style.fontFamily = 'monospace'; msgIn.oninput = () => { p.msg = msgIn.value.toUpperCase(); encode(); }; msgW.append(msgIn); ctl.append(msgW);
    const ex = el('div', 'note'); ex.innerHTML = 'try: '; for (const m of ['CQ KC1WIH FN42', 'CQ POTA WA9TT EN54', 'KC1WIH K1ABC -12', 'K1ABC KC1WIH R-08', 'KC1WIH K1ABC RR73', 'TNX BOB 73', 'CQ DX KC1WIH/P']) { const a = el('a', null, m); a.href = '#'; a.style.cssText = 'color:var(--accent);margin-right:8px;font-family:monospace'; a.onclick = e => { e.preventDefault(); p.msg = m; msgIn.value = m; encode(); }; ex.append(a); } ctl.append(ex);
    slider(ctl, { label: 'audio frequency', min: 200, max: 3000, step: 25, value: p.f0, fmt: v => v + ' Hz', oninput: v => { p.f0 = v; encode(); } });
    slider(ctl, { label: 'add noise: SNR', min: -26, max: 30, step: 1, value: p.snrDb > 50 ? 30 : p.snrDb, fmt: v => v >= 30 ? 'none' : v + ' dB (2500 Hz)', oninput: v => { p.snrDb = v >= 30 ? 99 : v; encode(); } });
    slider(ctl, { label: 'volume', min: 0, max: 1, step: 0.05, value: p.volume, fmt: v => Math.round(v * 100) + '%', oninput: v => { p.volume = v; if (st.gain) st.gain.gain.value = v; } });
    const useBtn = button(ctl, 'decode this as the loaded window →', () => { if (st.audio) { app.setAudio(st.audio, 'synth ' + p.msg, null); location.hash = '#sync'; } }); useBtn.style.marginTop = '6px';
    ctl.append(el('div', 'note', 'That button replaces the loaded audio with this synthetic transmission (plus noise) so every other page decodes it. "example" in the top bar restores the recorded window.'));

    const fieldsP = panel(main, 'Packing: the 77 payload bits'); const fields = el('div', 'stats'); fieldsP.append(fields); const bitsDiv = el('div', 'bits'); fieldsP.append(bitsDiv);
    const cwP = panel(main, '77 + 14 CRC + 83 parity = 174 bits → 58 data symbols (Gray code) + 21 Costas symbols = 79 tones'); const [cvT, cvTo] = layers(cwP, 1000, 190);
    const wfP = panel(main, 'The waveform: instantaneous frequency (GFSK) and the resulting spectrogram'); const [cvF, cvFo] = layers(wfP, 1000, 120); const [cvS, cvSo] = layers(wfP, 1000, 200);
    const spP = panel(main, 'Spectrum of the whole transmission'); const cvP = canvas(spP, 1000, 140);

    let enc = null;
    function encode() {
      const packed = pack77(p.msg); if (!packed) { fields.innerHTML = '<b>cannot pack this message</b>'; enc = null; return; }
      const bits91 = appendCrc(packed.bits); const cw = ldpcEncode(bits91); const { tones } = tonesFromBits77(packed.bits);
      enc = { packed, bits91, cw, tones, crc: crc14(packed.bits) };
      const desc = describeBits77(packed.bits);
      fields.innerHTML = `type <b>${packed.type}</b>${desc.text !== p.msg.trim() ? ` — unpacks as <b>${desc.text}</b>` : ''}<br>` + (desc.fields || packed.fields || []).map((f, i) => `<span class="pill" style="border-left:4px solid ${FIELD_COLORS[i % FIELD_COLORS.length]}">${f.name}: bits ${f.start}–${f.start + f.len - 1} = ${f.value}${f.text ? ' → ' + f.text : ''}</span>`).join(' ');
      let html = ''; const fl = desc.fields || packed.fields || []; for (let i = 0; i < 77; i++) { const fi = fl.findIndex(f => i >= f.start && i < f.start + f.len); html += `<span style="color:${fi >= 0 ? FIELD_COLORS[fi % FIELD_COLORS.length] : '#8b93a3'}" title="bit ${i}${fi >= 0 ? ': ' + fl[fi].name : ''}">${packed.bits[i]}</span>`; if (fi >= 0 && i === fl[fi].start + fl[fi].len - 1) html += ' '; }
      html += ` <span class="f4">${Array.from(bits91.slice(77)).join('')}</span> <span class="note">← CRC-14 = 0x${enc.crc.toString(16).toUpperCase()}</span>`;
      bitsDiv.innerHTML = html;
      drawTonesBg(); drawOverlays();
      synthesize();
    }
    async function synthesize() {
      if (!synth) { try { synth = await import('../dsp/subtract.js'); } catch (e) { synth = null; wfP.querySelector('h3').textContent = 'Waveform synthesis (GFSK) not available yet: ' + e.message; return; } }
      const wave = synth.synthesizeFt8(enc.tones, p.f0, { leadIn: 0 }); // Float array at 12 kHz, 79 symbols, no lead-in (we place it at 0.5 s ourselves)
      const total = 180000; const audio = new Float32Array(total); const start = Math.round(0.5 * FS);
      let amp = 3000; let sig = 0; for (const v of wave) sig += v * v; sig = Math.sqrt(sig / wave.length) || 1;
      if (p.snrDb < 50) { // noise σ so that signal power / (noise power in 2500 Hz) = 10^(snr/10); white noise at 12 kHz has 6000 Hz bandwidth
        const sigma = amp * sig / Math.sqrt(Math.pow(10, p.snrDb / 10)) * Math.sqrt(2500 / 6000);
        let s1 = 12345; const rnd = () => { s1 = (s1 * 1664525 + 1013904223) >>> 0; return s1 / 4294967296; };
        for (let i = 0; i < total; i++) { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); audio[i] = sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
      }
      for (let i = 0; i < wave.length && start + i < total; i++) audio[start + i] += amp * wave[i];
      st.audio = audio; st.wave = wave; st.buf = null;
      drawWaveBg(); drawOverlays();
    }
    const L = 44, T = 6;
    const curSym = () => Math.max(0, Math.min(78, Math.floor((app.clock.t - 0.5) / 0.16)));

    // ---- background layers: everything that depends only on the controls ----
    function drawTonesBg() {
      const g = cvT.g; clear(cvT); if (!enc) return; const W = cvT.w - L - 8, H = cvT.h - T - 46; const cw = W / 79, ch = H / 8;
      for (let s = 0; s < 79; s++) { const t = enc.tones[s]; const sync = isSyncSymbol(s); g.fillStyle = sync ? '#ff8c42' : '#4ea1ff'; g.fillRect(L + s * cw + 1, T + (7 - t) * ch + 1, cw - 2, ch - 2); }
      let k = 0; for (let s = 0; s < 79; s++) { if (isSyncSymbol(s)) { text(g, 'C', L + s * cw + cw / 2, T + H + 3, { align: 'center', color: '#ff8c42', font: '8px monospace' }); continue; } const b = `${enc.cw[k]}${enc.cw[k + 1]}${enc.cw[k + 2]}`; k += 3; text(g, b, L + s * cw + cw / 2, T + H + 3, { align: 'center', color: k <= 77 * 1 ? '#e6e9ef' : k <= 91 ? '#c792ea' : '#8b93a3', font: '7px monospace' }); }
      axisY(g, { x: L, y: T, h: H, min: -0.5, max: 7.5, ticks: [0, 1, 2, 3, 4, 5, 6, 7], fmt: v => 'tone ' + v });
      text(g, 'orange = Costas sync [3 1 4 0 6 5 2]; blue = data. Under each column: its 3 bits (Gray code: 000→0 001→1 011→2 010→3 101→4 110→5 100→6 111→7)', L, T + H + 16, { color: '#8b93a3' });
    }
    function drawWaveBg() {
      if (!st.wave) return;
      // instantaneous frequency of the GFSK modulator
      const g = cvF.g; clear(cvF); const W = cvF.w - L - 8, H = cvF.h - T - 24;
      const dphi = synth.instantaneousPhaseIncrement(enc.tones, p.f0); const xs = [], ys = []; const step = 24;
      for (let i = 0; i < 79 * 1920; i += step) { xs.push(i / FS); ys.push(dphi[i + 1920] * FS / (2 * Math.PI)); } // the waveform uses dphi[NSPS..NSPS+NFRAME)
      linePlot(g, { xs, ys, x: L, y: T, w: W, h: H, xmin: 0, xmax: 79 * 0.16, ymin: p.f0 - 10, ymax: p.f0 + 55, color: '#ffd166', width: 1 });
      for (let s = 0; s <= 79; s++) vline(g, L + s * 0.16 / (79 * 0.16) * W, T, H, s % 36 === 0 || s === 7 || s === 43 || s === 79 ? 'rgba(255,140,66,0.5)' : 'rgba(255,255,255,0.08)');
      axisY(g, { x: L, y: T, h: H, min: p.f0 - 10, max: p.f0 + 55, ticks: [p.f0, p.f0 + 25, p.f0 + 50], fmt: v => v }); axisX(g, { x: L, y: T + H, w: W, min: 0, max: 12.64, ticks: [0, 2, 4, 6, 8, 10, 12], fmt: v => v + ' s' });
      text(g, 'instantaneous frequency of the modulator: Gaussian-smoothed steps between tones (BT = 2), 240-sample amplitude ramps at both ends', L + W, T, { align: 'right', bg: 'rgba(0,0,0,0.6)' });

      // spectrogram of the noisy audio around f0 (337 frames of a 3840-point FFT)
      const g2 = cvS.g; clear(cvS); const a = st.audio; const nfft = 3840, hop = 480, rows = Math.floor((a.length - 1920) / hop) + 1; const b0 = Math.max(0, Math.floor((p.f0 - 40) / 3.125)), b1 = Math.min(1920, Math.ceil((p.f0 + 90) / 3.125)); const nb = b1 - b0;
      const data = new Float32Array(rows * nb); const fr = new Float64Array(1920); let mx = -1e9;
      for (let r = 0; r < rows; r++) { for (let i = 0; i < 1920; i++) fr[i] = a[r * hop + i]; const ps = powerSpectrum(fr, nfft); for (let b = b0; b < b1; b++) { const v = 10 * Math.log10(ps[b] + 1e-3); data[r * nb + b - b0] = v; if (v > mx) mx = v; } }
      const W2 = cvS.w - L - 8, H2 = cvS.h - T - 24;
      heatmap(g2, { data, rows, cols: nb, x: L, y: T, w: W2, h: H2, vmin: mx - 50, vmax: mx, cmap: 'viridis', nearest: true });
      // note: transposed display (time on x) would need a different draw; keep time on y like the other pages
      axisX(g2, { x: L, y: T + H2, w: W2, min: b0 * 3.125, max: b1 * 3.125, ticks: ticks(b0 * 3.125, b1 * 3.125, 6), fmt: v => v.toFixed(0) + ' Hz' }); axisY(g2, { x: L, y: T, h: H2, min: 0, max: a.length / FS, ticks: [0, 3, 6, 9, 12, 15], fmt: v => v + ' s', flip: true });

      // spectrum of the whole transmission (one 192 000-point FFT)
      const g3 = cvP.g; clear(cvP); const W3 = cvP.w - L - 8, H3 = cvP.h - T - 24; const big = new Float64Array(a.length); big.set(a); const ps = powerSpectrum(big, 192000); const xs3 = [], ys3 = []; let mm = -1e9;
      for (let k = Math.floor((p.f0 - 60) / 0.0625); k < Math.ceil((p.f0 + 110) / 0.0625); k += 4) { let acc = 0; for (let q = 0; q < 4; q++) acc += ps[k + q]; const v = 10 * Math.log10(acc + 1e-3); xs3.push(k * 0.0625); ys3.push(v); if (v > mm) mm = v; }
      linePlot(g3, { xs: xs3, ys: ys3, x: L, y: T, w: W3, h: H3, xmin: p.f0 - 60, xmax: p.f0 + 110, ymin: mm - 60, ymax: mm + 3, color: '#4ea1ff', width: 1 });
      for (let t = 0; t < 8; t++) vline(g3, L + (p.f0 + t * 6.25 - (p.f0 - 60)) / 170 * W3, T, H3, 'rgba(255,140,66,0.4)', [2, 3]);
      axisX(g3, { x: L, y: T + H3, w: W3, min: p.f0 - 60, max: p.f0 + 110, ticks: ticks(p.f0 - 60, p.f0 + 110, 8), fmt: v => v.toFixed(0) + ' Hz' });
      text(g3, 'dashed: the 8 tone frequencies f0 + n × 6.25 Hz. The occupied bandwidth is ≈ 50 Hz', L + W3, T, { align: 'right', bg: 'rgba(0,0,0,0.6)' });
    }

    // ---- overlays: the only thing the transport clock moves ----
    function drawOverlays() {
      const s = curSym();
      const g = cvTo.g; clear(cvTo);
      if (enc) {
        const W = cvT.w - L - 8, H = cvT.h - T - 46, cw = W / 79;
        g.strokeStyle = '#ff5c5c'; g.lineWidth = 1.5; g.strokeRect(L + s * cw, T, cw, H);
        text(g, `symbol ${s}: tone ${enc.tones[s]}${isSyncSymbol(s) ? ' (Costas)' : ` = ${(enc.tones[s]).toString(2).padStart(3, '0')} → bits ${GRAY_MAP.indexOf(enc.tones[s]).toString(2).padStart(3, '0')}`}, ${(p.f0 + enc.tones[s] * 6.25).toFixed(2)} Hz`, L + W, T + 2, { align: 'right', bg: 'rgba(0,0,0,0.6)' });
      }
      const gf = cvFo.g; clear(cvFo);
      if (st.wave) { const W = cvF.w - L - 8, H = cvF.h - T - 24; vline(gf, L + (s + 0.5) * 0.16 / (79 * 0.16) * W, T, H, '#ff5c5c'); }
      const gs = cvSo.g; clear(cvSo);
      if (st.audio) { const W2 = cvS.w - L - 8, H2 = cvS.h - T - 24; hline(gs, L, W2, T + app.clock.t / (st.audio.length / FS) * H2, '#ff5c5c'); }
    }
    function syncAudio() {
      const c = app.clock; stopAudio(); if (!c.playing || !st.audio) return;
      if (!st.audioCtx) { st.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); st.gain = st.audioCtx.createGain(); st.gain.connect(st.audioCtx.destination); }
      if (st.audioCtx.state === 'suspended') st.audioCtx.resume();
      if (!st.buf) { const buf = st.audioCtx.createBuffer(1, st.audio.length, FS); const ch = buf.getChannelData(0); let m = 1; for (const v of st.audio) m = Math.max(m, Math.abs(v)); for (let i = 0; i < st.audio.length; i++) ch[i] = st.audio[i] / m * 0.8; st.buf = buf; }
      st.gain.gain.value = p.volume; const s = st.audioCtx.createBufferSource(); s.buffer = st.buf; s.loop = c.loop; s.playbackRate.value = c.speed; s.connect(st.gain); s.start(0, Math.min(c.t, st.buf.duration - 0.01)); st.src = s;
    }
    app.clock.setDuration(15);
    st.unsubs.push(app.clock.subscribe((c, kind) => { drawOverlays(); if (['play', 'pause', 'seek', 'speed'].includes(kind)) syncAudio(); }));
    encode();
  },
  unmount() { stopAudio(); for (const u of st.unsubs) u(); st.unsubs = []; },
};
