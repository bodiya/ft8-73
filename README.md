# Seven Threes

Interactive, browser-based visualizations of how an FT8 decoder works, one stage of the
DSP pipeline at a time. Every page runs the real algorithms in JavaScript on a recorded
15 s window of 20 m FT8, with the knobs that matter exposed so you can see how a change
in, say, the noise-floor percentile or the sync threshold changes what gets decoded.

The algorithms are ports of [wsjtr](https://github.com/bodiya/wsjtr) (Rust), which is in
turn a port of WSJT-X by K1JT and the WSJT Development Group. Both are GPLv3, and so is this.

## Run it

No build step. Serve the directory statically and open it:

```bash
npm start            # python3 -m http.server 8765
# then open http://localhost:8765/
```

## Host it

The whole thing is static files, so any static host works with no build and no configuration.
Every URL the app builds at runtime is resolved against `import.meta.url`, so it runs from a
domain root or from a project subpath (`https://user.github.io/ft8-73/`), with or
without a trailing slash. Nothing needs COOP/COEP headers: there is a module worker but no
`SharedArrayBuffer`. First load is about 420 KB (the 317 KB example WAV plus the code); the two
residual WAVs are fetched only when you open stage 4's recorded view.

- **GitHub Pages, no config**: Settings → Pages → Deploy from a branch → `main` / `/ (root)`.
  `.nojekyll` is committed, so Jekyll leaves the files alone.
- **GitHub Pages, via Actions**: `.github/workflows/pages.yml` publishes on every push to `main`
  and on demand. It copies only `index.html`, `src/`, `data/`, `README.md` and `LICENSE`, so
  `tools/` and the git history are not served.
- **Netlify / Cloudflare Pages**: connect the repo with no build command and the repo root as the
  publish directory, or drag the folder in. `_headers` caches `data/` forever and revalidates the
  code, so a redeploy is picked up without a hard refresh.
- **Vercel** works too, but it ignores `_headers`; add a `vercel.json` if you want the same cache
  policy.

The Actions workflow publishes from `main` only. To preview a branch, run it by hand from the
Actions tab (it has `workflow_dispatch`), or point a Netlify/Cloudflare preview at the branch.

Links carry the view: `#ldpc/heat`, `#sync/causal`, `#passes/recorded` all open on that view, so
you can send someone straight to the picture you meant.

Browser requirements: ES modules, module workers (Chrome 80, Firefox 114, Safari 15) and Canvas
2D. `requestIdleCallback` is used for warm-up but falls back to `setTimeout` where it is missing.

It works on a phone. Every plot is built at a size derived from the column it sits in and rebuilt
on rotation, the controls panel moves below the plots, a tap does what hovering does with a mouse,
and the transport bar is the one pinned to the top. Four plots are dense enough that shrinking them
past a floor would destroy the point (the 79-column tone grid, the Tanner graph, the one-check
view, the tone row), so those keep an intrinsic width in a panel that pans sideways. On a small or
low-memory device the app also takes the cheaper route through the expensive views: stage 4 opens
on the recorded residuals instead of starting a minute-long decode, stage 1's causal ladder is
coarser, and the render cache is smaller.

`npm test` runs the JS decoder on the bundled window from Node and compares against
wsjtr's decode list (single pass, depth 3: 30 messages, all 18 of wsjtr's pass-1 decodes).
Other Node checks: `tools/subtract_test.mjs`, `tools/osd_test.mjs`, `tools/pack77_test.mjs`,
`tools/baseline_test.mjs`, and `tools/cdp_check.mjs` (drives every page and tab in headless
Chrome and reports exceptions). `tools/cdp_shot.mjs <page> <out.png> [js]` screenshots a page
after running some JS in it. Both CDP tools take a phone viewport: `cdp_check.mjs --mobile`
re-runs the whole sweep at 390x844 with touch emulation, tapping with real touch events and
reporting horizontal overflow, unreachable taps and tap targets under 44 px, and
`cdp_shot.mjs ... --viewport=390x844 --full` captures a full-page phone screenshot.

The **open WAV** button loads your own recording of one slot (any sample rate, resampled to
12 kHz, truncated to 15 s). The JS decoder then runs three passes with subtraction in a
worker and its decodes become the reference overlay on every page.

## Stages

| Page | What it shows | Knobs |
|---|---|---|
| 0 · Signal | Waterfall of the raw 12 kHz audio, waveform and instantaneous spectrum at the playhead, audio playback at any speed, ground-truth decode boxes by pass | FFT size / hop (time vs frequency resolution), color range, which decoder's boxes |
| 1 · Coarse sync | The Costas-array sync surface (frequency × time offset), the collapsed sync spectrum, threshold, dedupe → candidate list. Three views (`#sync/lag`, `#sync/freq`, `#sync/causal`): slide the template through every lag at one frequency, slide it across frequency at one lag, or replay the window and re-run the search on the audio heard so far | noise-floor percentile, threshold, short-lag window, red2, max candidates, dedupe tolerances, search range |
| 2 · Candidate | 200 Hz baseband, the three fine-sync searches, and the 79 × 8 tone grid with Costas cells, hard decisions and the decoded tones | time / frequency nudge (deliberate misalignment), depth (sync gate), power vs amplitude |
| 3 · LDPC | 174 LLRs colored by message field, belief propagation animated per iteration in four views (`#ldpc/tanner`, `#ldpc/circle`, `#ldpc/heat`, `#ldpc/check`), convergence plot, decoded bits and message. Two more views for what happens when BP fails: the OSD fallback (reliability sort, information set, flip pool, winning pattern) and a-priori decoding (CQ / MyCall) | LLR set (a–e), amplitude vs power metric, iterations, early stop, LLR scale, added noise, OSD order and source, AP hypothesis |
| 4 · Subtraction | Two views: wsjtr's recorded per-pass input audio side by side (`#passes/recorded`), or this JS decoder's own three passes (depth 1 → 2 → 3 with subtraction between) run live in a worker (`#passes/live`) | frequency zoom |
| E · Encode | Message → 77 bits (annotated fields) → CRC-14 → 174 LDPC bits → 79 Gray-coded tones → GFSK waveform, spectrogram and spectrum; play it, add noise, hand it to the decoder pages | message, audio frequency, SNR |

The transport bar (play / stop / speed / loop / scrub, space toggles play) drives whatever
the current page animates: audio time on page 0, the template lag sweep on page 1, the
symbol cursor on page 2, the BP iteration on page 3. Each page with alternative views says
under its tabs what the clock means there and what to look at.

## Where the time goes

Playback is deliberately cheap: everything that does not move with the clock is computed once
and cached, and each plot is split into a background canvas plus a transparent overlay that
holds only the playhead. Measured per-tick cost of the whole subscriber fan-out, headless Chrome
on one core, before and after that split:

| Page / view | before | after |
|---|---|---|
| E · Encode | 407 ms (2 fps: a full spectrogram and a 192 000-point FFT every frame) | 0.1 ms |
| 1 · Coarse sync, causal reveal | 12.3 ms mean, 41 ms p95 | 0.9 ms mean, 7.7 ms p95 |
| 0 · Signal | 7.9 ms | 1.0 ms |
| 1 · Coarse sync, frequency sweep | 5.3 ms | 1.7 ms |
| 4 · Subtraction | 4.5 ms | 0.1 ms |
| 1 · Coarse sync, lag sweep | 3.9 ms | 0.1 ms |
| 3 · LDPC, OSD view | 3.3 ms | 0.03 ms |
| 2 · Candidate | 0.9 ms | 0.1 ms |

Control handlers had the same problem in a different shape: `input` fires once per pixel of a
drag and once per keystroke, and each event ran the whole chain behind it synchronously. They are
now coalesced to at most one run per frame and memoized on the values they depend on. Time the
main thread is blocked by the burst itself (25 slider steps, or typing a 14-character message):

| Interaction | before | after |
|---|---|---|
| E · Encode, typing a message | 12.6 s | 0 ms |
| 2 · Candidate, dragging the time nudge | 523 ms | 1 ms |
| 3 · LDPC, dragging the noise sigma | 312 ms | 0 ms |
| 0 · Signal, dragging the hop slider | 120 ms | 0 ms |
| E · Encode, returning to the page | 865 ms | 19 ms |

The work moved to load time, tab-entry time or an idle callback: the 192k-point `DecodeContext`
and the SNR baseline are built during the first idle moment after load, and stage 1's causal view
precomputes its 84 sync surfaces in about two seconds with a progress readout (freed when you
leave the page). `src/ui/draw.js` caches rendered heatmaps, so a redraw is one `drawImage`.

The three-pass JS decode is about 15 s of CPU, so when there is already a reference decode list it
does not run until something needs it: opening stage 4's live view, or asking stage 0 for the
"this JS decoder" boxes. A visitor who only reads the pages never pays for it. For a WAV you load
yourself there is no reference list, so it starts immediately.

The landing page is painted before the 317 KB window is fetched and before the front-end DSP runs,
since it reads neither.

Two DSP kernels were made faster without changing a single output bit (verified by an A/B run
against the previous implementation over the full sync surface and the FFT sizes in use):
`syncSurface` precomputes the 7-tone sums each lag would otherwise recompute (2.5x to 4.3x), and
`fft.js` tabulates its per-level twiddles, drops a redundant modulo from the inner loop and
reuses its buffers (1.3x to 1.6x).

## Layout

```
index.html            app shell
src/dsp/              the decoder, ported from wsjtr
  fft.js              mixed-radix FFT (3840, 192000, 3200, 32 points)
  sync.js             spectrogram, Costas sync surface, percentile floor, hits, dedupe   (sync.rs, candidates.rs)
  downsample.js       192k-point FFT → 62 Hz slice → 200 Hz complex baseband           (wsjt_ft8.rs Ft8Downsampler)
  finesync.js         coherent Costas matched filter, time/freq refine, 79×8 bins, nsync (wsjt_ft8.rs)
  llr.js              the five soft-metric sets a–e, amplitude and power                (wsjt_ft8.rs llr_passes_from_bins)
  ldpc.js             (174,91) graph, belief propagation with per-iteration trace, encoder, CRC-14
  unpack77.js         77-bit message unpacking (no hash table: hashed calls show as <...>)
  pack77.js           message packing (all wsjtr types) + describeBits77() field annotation   (pack77.rs)
  osd.js              ordered-statistics decoding on BP soft sums, with a visualization trace  (osd.rs)
  ap.js               a-priori LLR overrides for CQ / MyCall                                  (wsjt_ft8.rs)
  subtract.js         GFSK synthesis and signal subtraction                                    (subtract_ft8.rs, gen_ft8wave.rs)
  baseline.js         spectrum baseline + SNR                                                  (snr.rs)
  resample.js         Kaiser-windowed sinc resampler for user WAVs
  worker.js           Web Worker: multi-pass decode with subtraction
  pipeline.js         decodeCandidate(): everything above, returning a full trace
src/ui/               app shell, transport clock, drawing helpers, control builders
  app.js              state, #page/view routing, data loading, worker wiring, idle warm-up
  draw.js             colormaps, cached heatmap renderer, axes, line plots
  controls.js         sliders/selects/canvases, layers() for background+overlay plots, tab bars
src/vis/              one module per page
data/                 the example window (raw + wsjtr's pass-2/pass-3 residuals) and its decode lists
tools/                Node test harness and a CDP smoke test
.github/workflows/    GitHub Pages deploy
.nojekyll, _headers   static-hosting bits (see "Host it")
```

The example window is 2026-07-26 19:09:30 UTC on 14.074 MHz, the busiest window of the
HamX capture run (wsjtr 51 decodes in 3 passes with `-p 3 -d 1,1,3 --my-call KC1WIH`,
WSJT-X 52). Passes in the decode list are inferred from arrival-time bursts.

## Faithfulness notes

- Coarse sync, downsampling, fine sync, symbol extraction, LLR generation, BP, OSD, AP,
  subtraction, the baseline SNR and message packing are ports of the wsjtr code and were
  checked against it: same decodes on this window (JS 3-pass run: 40 messages, all in
  wsjtr's list), SNR within 2 dB of wsjtr's, subtraction residual band powers matching
  wsjtr's recorded residual to 0.0 dB in bands where the same signals were removed, tone
  sequences identical to `ft8coder`.
- Not ported: A7 cross-sequence decoding, AP types 3–6, `--rx-frequency` two-pass candidate
  selection, `--refine-top`, and wsjtr's internal multi-round scheduling inside each outer
  pass (the JS run does one subtraction round per pass).
- The `pass` field in the bundled decode list is inferred from wsjtr's output bursts; each
  outer pass there contains several internal decode/subtract rounds.

## The name

FT8 syncs on a 7-tone Costas array sent three times, at symbols 0, 36 and 72. Seven,
three. That is also how a ham signs off, so the sync pattern and "best regards" are the
same number. Stage 1 is where it clicks; the site does not spoil it.
