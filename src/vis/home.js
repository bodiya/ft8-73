import { el } from '../ui/controls.js';
export default {
  mount(root, app) {
    root.innerHTML = `
<div class="home">
<h1>FT8 for Dummies — the decoder, one stage at a time</h1>
<p class="blurb">Every page runs the real algorithms (ported from the <b>wsjtr</b> Rust decoder, itself a port of WSJT-X) in your browser on one recorded 15 s window of 20 m FT8. Knobs change the algorithm live; the transport bar at the top slows down, speeds up, scrubs and loops whatever the current page animates. Space toggles play.</p>
<h2>The pipeline</h2>
<div class="card"><a href="#signal">0 · Signal</a> — what the sound card hands the decoder: 12 kHz audio, a spectrogram, and where the 51 signals in this window actually are. Listen to it at any speed.</div>
<div class="card"><a href="#sync">1 · Coarse sync</a> — slide the 7×7 Costas template over a 3.125 Hz × 40 ms spectrogram to build the frequency × time-offset sync surface, normalize it by a noise-floor percentile, threshold, dedupe → candidate list. Tweak the percentile, the threshold, the lag window, the dedupe tolerances.</div>
<div class="card"><a href="#candidate">2 · One candidate</a> — mix one candidate down to 200 Hz baseband, refine time (±50 ms) and frequency (±2.5 Hz) with a coherent matched filter, then read the 79 × 8 tone grid. Nudge the alignment off and watch the grid smear.</div>
<div class="card"><a href="#ldpc">3 · Soft bits → LDPC</a> — turn tone magnitudes into 174 log-likelihood ratios (five different metrics), then watch belief propagation pass messages around the (174,91) Tanner graph until all 83 parity checks are satisfied and the CRC-14 clicks. Add noise to the LLRs and see where it breaks.</div>
<div class="card"><a href="#passes">4 · Subtraction &amp; passes</a> — what the band looks like after the decoded signals are synthesized and subtracted, and which signals only appear on pass 2 and 3. Tab A is wsjtr's recorded residual audio; tab B runs this JS decoder's own three passes live.</div>
<div class="card"><a href="#encode">E · Encode</a> — type a message and watch it become 77 bits, a CRC, 174 LDPC bits, 79 Gray-coded tones and a GFSK waveform; play it, add noise, and hand it to the decoder pages.</div>
<p class="blurb">Some pages have tabs with alternative views of the same step (stage 1: three animations of the template search; stage 3: four views of belief propagation plus the OSD and a-priori fallbacks). The "open WAV" button in the top bar loads your own recording of one FT8 slot (any sample rate; it is resampled to 12 kHz); the JS decoder then runs three passes in the background and its decodes become the reference overlay.</p>
<h2>The example window</h2>
<p class="blurb">${app.truth ? app.truth.window + ', ' + app.truth.band : ''}. Recorded during the HamX captures; wsjtr decoded 51 messages here in 3 passes (WSJT-X: 52). The ground-truth decode lists are overlaid throughout so you can see which knobs find or lose real signals. The 13.5 s recording starts at the top of the 15 s slot minus 0.5 s, so a signal with DT = 0 begins 0.5 s into the file.</p>
<h2>Not ported</h2>
<ul class="note">
<li>A7 cross-sequence decoding (needs callsigns from previous windows) and AP types 3–6 (need QSO context).</li>
<li>Field Day / RTTY / EU VHF message packing is ported but not exercised in the UI.</li>
</ul>
</div>`;
  },
  unmount() {},
};
