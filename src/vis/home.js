// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.

import { el } from '../ui/controls.js';

let off = null;
export default {
  mount(root, app) {
    root.innerHTML = `
<div class="home">
<h1>Seven Threes</h1>
<p class="sub">Seven tones, three times, and everything after.</p>
<p class="blurb">Every page runs the real algorithms (ported from the <b>wsjtr</b> Rust decoder, itself a port of WSJT-X) in your browser on one recorded 15 s window of 20 m FT8. Knobs change the algorithm live; the transport bar at the top slows down, speeds up, scrubs and loops whatever the current page animates. Space toggles play.</p>
<h2>Take the tour</h2>
<p class="blurb">Every stage has a <b>Try this</b> row above its plots: one click sets the knobs for a specific experiment and tells you what changed. The fastest way through the whole decoder is to follow these eight, in order. Ten minutes, no reading required.</p>
<ol class="tour">
<li><a href="#signal">0 · Signal</a>, click <b>zoom to one signal</b>. One FT8 transmission: 50 Hz wide, 12.6 s long, tones stepping down the page. Then <b>trade frequency for time</b> to see why 6.25 Hz bins and 160 ms frames are the only sensible choice.</li>
<li><a href="#sync/lag">1 · Coarse sync</a>, press play. The 7-tone template slides through all 125 lags at one frequency; the score spikes when it lines up. That spike, divided by the noise floor, is the whole candidate test.</li>
<li>Same page, click <b>cap the list at 30</b>. Pass-1 decodes with a candidate fall from 18/18 to 11/18. The candidate budget, not the threshold, is what limits how much of the band you can read.</li>
<li><a href="#sync/causal">1 · causal reveal</a>, press play. The search re-runs on the audio heard so far. Real signals only clear the threshold at 7.4 s, when the second Costas array lands, which is how a decoder can start before the slot ends.</li>
<li><a href="#candidate">2 · One candidate</a>, click <b>time off by 70 ms</b>. nsync drops to 13 of 21 and 14 of the 174 bits come out wrong, and the message still decodes. Then <b>time off by 80 ms</b>: the sync gate blocks it and no LDPC work is attempted at all.</li>
<li><a href="#ldpc/heat">3 · LDPC</a>, click <b>noise σ 3</b>, then <b>σ 3.5</b>. Six iterations to a clean decode, then no convergence at all. LDPC gives you the message or nothing, which is why FT8 never prints garbled text.</li>
<li><a href="#passes/recorded">4 · Subtraction</a>, click <b>the KY9L footprint</b>. A −6 dB signal at 1551 Hz is decoded and subtracted, and three messages between −13 and −17 dB appear underneath it on pass 3.</li>
<li><a href="#encode">E · Encode</a>, click <b>SNR −21 dB</b>, then <b>decode this as the loaded window</b>. You have just made a signal you cannot see, and stage 1 finds it anyway. Every page is now running on your transmission instead of the recording; <b>example</b> in the top bar puts the recording back.</li>
</ol>

<h2>The pipeline</h2>
<div class="card"><a href="#signal">0 · Signal</a> — what the sound card hands the decoder: 12 kHz audio, a spectrogram, and where the 51 signals in this window actually are. Listen to it at any speed.</div>
<div class="card"><a href="#sync">1 · Coarse sync</a> — slide the 7×7 Costas template over a 3.125 Hz × 40 ms spectrogram to build the frequency × time-offset sync surface, normalize it by a noise-floor percentile, threshold, dedupe → candidate list. Tweak the percentile, the threshold, the lag window, the dedupe tolerances.</div>
<div class="card"><a href="#candidate">2 · One candidate</a> — mix one candidate down to 200 Hz baseband, refine time (±50 ms) and frequency (±2.5 Hz) with a coherent matched filter, then read the 79 × 8 tone grid. Nudge the alignment off and watch the grid smear.</div>
<div class="card"><a href="#ldpc">3 · Soft bits → LDPC</a> — turn tone magnitudes into 174 log-likelihood ratios (five different metrics), then watch belief propagation pass messages around the (174,91) Tanner graph until all 83 parity checks are satisfied and the CRC-14 clicks. Add noise to the LLRs and see where it breaks.</div>
<div class="card"><a href="#passes">4 · Subtraction &amp; passes</a> — what the band looks like after the decoded signals are synthesized and subtracted, and which signals only appear on pass 2 and 3, either from wsjtr's recorded residual audio or from this decoder running live.</div>
<div class="card"><a href="#jtty">J · JTTY</a>: not FT8 at all, but the RTTY-style mode new in WSJT-X 3.2, built from the same parts. No time slots: 1.888 s frames of 34 bits, a CRC-12, a tail-biting convolutional code decoded by a list Viterbi, and a receiver that re-examines the last 2.36 s every 0.47 s. Four views: <a href="#jtty/signal">the signal</a> with the text arriving, <a href="#jtty/encode">the encoder</a>, <a href="#jtty/sync">finding frames</a> without a clock, and <a href="#jtty/trellis">the trellis</a>.</div>
<div class="card"><a href="#encode">E · Encode</a> — type a message and watch it become 77 bits, a CRC, 174 LDPC bits, 79 Gray-coded tones and a GFSK waveform; play it, add noise, and hand it to the decoder pages.</div>

<h2>Alternative views</h2>
<p class="blurb">Three of the pages show the same step more than one way, because no single picture makes all of it obvious. Each view says what the transport clock means in it and what to look at, and each has its own link, so you can send someone straight to the one that makes the point.</p>
<div class="card"><b>1 · Coarse sync</b> — the same template search, animated three ways:
<a href="#sync/lag">lag sweep</a> (one frequency, all 125 lags),
<a href="#sync/freq">frequency sweep</a> (one lag, across the band),
<a href="#sync/causal">causal reveal</a> (re-run on the audio heard so far, which is how early decoding works).</div>
<div class="card"><b>3 · LDPC</b> — four renderings of one belief-propagation run:
<a href="#ldpc/tanner">Tanner graph</a>,
<a href="#ldpc/circle">circular</a>,
<a href="#ldpc/heat">reliability heatmap</a> (the whole run at once, clearest for "did it converge"),
<a href="#ldpc/check">one check node</a> (the only one that shows the arithmetic).
Then two views of what happens when BP fails:
<a href="#ldpc/osd">OSD fallback</a> and
<a href="#ldpc/ap">a-priori</a>.</div>
<div class="card"><b>4 · Subtraction</b> —
<a href="#passes/recorded">wsjtr's recorded residuals</a> for the bundled window, or
<a href="#passes/live">this decoder, live</a>, which works on any window you load.</div>

<h2>The example window</h2>
<p class="blurb"><span id="ex-window"></span>Recorded at HamX, a ham radio conference; wsjtr decoded 51 messages here in 3 passes (WSJT-X: 52). The ground-truth decode lists are overlaid throughout so you can see which knobs find or lose real signals. The 13.5 s recording starts at the top of the 15 s slot minus 0.5 s, so a signal with DT = 0 begins 0.5 s into the file.</p>
<p class="blurb">The "open WAV" button in the top bar loads your own recording of one FT8 slot (any sample rate; it is resampled to 12 kHz). The JS decoder then runs three passes in the background and its decodes become the reference overlay.</p>
<h2>Not ported</h2>
<ul class="note">
<li>A7 cross-sequence decoding (needs callsigns from previous windows) and AP types 3–6 (need QSO context).</li>
<li>Field Day / RTTY / EU VHF message packing is ported but not exercised in the UI.</li>
</ul>
</div>`;
    // The page now paints before the decode list has arrived, so fill this line in when it does.
    const fill = () => { const e = root.querySelector('#ex-window'); if (e && app.truth && app.truth.window) e.textContent = app.truth.window + ', ' + app.truth.band + '. '; };
    fill();
    off = app.on(k => { if (k === 'truth' || k === 'ready') fill(); });
  },
  unmount() { if (off) { off(); off = null; } },
};
