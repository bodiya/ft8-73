# Pending decisions and where to pick up

Status as of 2026-09-09: every page runs end to end on a desktop and on a phone;
`node tools/cdp_check.mjs` and `node tools/cdp_check.mjs --mobile` both pass clean. Sections 1 to 3 were open choices and are now decided (keep every view, and integrate
them properly); the rest are loose ends noticed while building. Nothing here blocks use of the
app.

## 1. Stage-1 template animations: all three kept

Decision (2026-09-08): keep all three, and treat "more than one view of the same step" as a
feature rather than an undecided experiment.

| View | Link | What the clock does |
|---|---|---|
| lag sweep | `#sync/lag` | slides the 21-cell template through all 125 lags at one frequency |
| frequency sweep | `#sync/freq` | slides it across the zoom span at one lag; score trace along the sweep |
| causal reveal | `#sync/causal` | re-runs the whole search on only the audio heard so far |

What changed to make that work:

- The view id is part of the hash, so a link opens on the view you meant, and the last view you
  used on a page is remembered when the hash names none.
- Each view has a caption under the tabs saying what the transport clock means there and what to
  look at, because the clock means something different in each.
- The letter prefixes (A / B / C) are gone; they only made sense while one was going to win.
- The causal view had a "candidate rings are clutter at mid-window" problem. There is now a
  "draw candidate rings" checkbox, and the note next to it says why turning it off helps.
- The causal view used to recompute a sync surface inside the frame that needed it. It now
  precomputes the whole 84-step ladder in the background when you open it (about two seconds,
  with a progress readout) and frees it when you leave the page.

## 2. Stage-3 belief-propagation views: all six kept, in two groups

Decision (2026-09-08): keep all four BP renderings plus OSD and AP, but stop presenting them as
one flat list of alternatives. The tab bar is now two labelled groups:

- **belief propagation**: `#ldpc/tanner`, `#ldpc/circle`, `#ldpc/heat`, `#ldpc/check`. Four
  pictures of the same run. The clock is the iteration index in all four.
- **when BP fails**: `#ldpc/osd`, `#ldpc/ap`. Different algorithms, not renderings, and neither
  depends on the iteration; their captions say so.

Impressions from building them still stand and are now in the captions: the heatmap is clearest
for "does it converge and where are the wrong bits", the check-node view is the only one that
shows the arithmetic, and the Tanner and circular views are the pretty ones.

Still open: the strongest candidate decodes at iteration 0, so the default demo is dull. Options:
default stage 3 to a weak candidate (the first that needs > 5 iterations), or preset noise
sigma ~ 2.

## 3. Stage-4: both views kept

Decision (2026-09-08): keep both. `#passes/recorded` (wsjtr's recorded per-outer-pass input
audio) only applies to the bundled window and its tab is disabled for a loaded WAV;
`#passes/live` runs this decoder and works on anything. Live is still the default.

The FFT question from this section is resolved differently than proposed: rather than replacing
`src/dsp/fft.js` with a split-radix implementation, the existing mixed-radix one was tuned in
place (per-level twiddle tables, a redundant modulo removed from the inner loop, buffer reuse)
for 1.3x to 1.6x with bit-identical output. A split-radix rewrite is still the way to get the
rest, and subtraction is still 8 FFTs of 180 000 points per decode.

Related fact, unchanged: wsjtr's `passN.wav` is the input to the N-th *outer* pass, and each
outer pass has up to four internal decode/subtract rounds. The `pass` field in
`data/260726_190930.decodes.json` was inferred from output bursts and does not correspond to
subtraction rounds. If exact per-round residuals matter, add a debug dump to wsjtr.

## 4. Scope not ported

- A7 cross-sequence decoding (needs callsigns from previous windows) and AP types 3–6
  (need QSO context). Both could be demonstrated with a second recorded window.
- `--rx-frequency` two-pass candidate selection and `--refine-top`.
- wsjtr's internal multi-round scheduling within an outer pass (JS does one subtraction
  round per pass, then escalates depth 1 → 2 → 3).
- Hashed callsigns unpack as `<...>` (no call-hash table).

## 5. Smaller loose ends

- Stage 0 audio playback below 0.5x drops pitch with speed (plain `playbackRate`). A
  phase-vocoder or granular stretch would keep pitch; probably not worth it.
- Stage 2 could show the tone grid built from the coarse 3.125 Hz spectrogram next to the
  fine-sync one, to make the point of the baseband/fine-sync step.
- Encode page: Field Day / RTTY / EU VHF packing is ported but has no examples in the UI;
  the "try:" list only shows standard and free-text messages.
- "Open WAV" accepts any length >= 12.64 s and truncates to 15 s; there is no UI for
  choosing which 15 s of a longer file.
- Narrow screens scroll the panels sideways rather than reflowing. The canvases are fixed-width
  pixel plots (1000-1060 px); a real mobile layout would mean parameterising every plot's size.
- The stage-1 causal ladder holds about 60 MB of sync surfaces while that view is open. Freed on
  leaving the page. If that ever matters, the cheap parts (hits, candidates) are ~2 MB and only
  the surfaces would need an LRU plus a prefetch-ahead loop.
- The heatmap render cache in `src/ui/draw.js` is keyed on array identity, so a caller that
  rebuilds its array every frame misses every time. Stage 1's template view passes an explicit
  `version` instead; anything new that animates a freshly built array should do the same.

## 6. Resolved: hosting

The app is static and hosts anywhere with no build. Runtime URLs resolve against
`import.meta.url` (previously they were document-relative, which would have broken the worker on
a subpath without a trailing slash). `.nojekyll`, `_headers` and `.github/workflows/pages.yml`
are committed; see "Host it" in the README. Verified in headless Chrome from `/ft8-73/`,
`/ft8-73` and `/ft8-73/index.html#ldpc/heat`, including the module worker.

## 7. Performance work not taken, with numbers

An audit of every page and both kernel modules turned these up after the optimization pass. They
are recorded with the measurements that were taken so nobody has to re-derive them. **The numbers
below came from the audit's own prototypes and have not been independently re-verified here**, so
treat "bit-identical" as a claim to check, not a fact, before merging any of them.

Decode time (the worker path, not playback), measured on the bundled window in Node 22: front end
310 ms (spectrogram 193, toneSums 14, syncSurface 23, hits+dedupe 9, DecodeContext 71), then
2632 ms to decode 200 candidates at depth 3, of which OSD is 1175, llrPasses 448, downsample 199,
BP 132, extractSymbolBins 58, fine sync 38. One subtraction is 382-501 ms.

- **OSD's Gaussian elimination works one byte per bit.** Bit-packing the GF(2) matrix into Uint32
  words was measured at 5.65x on the largest single item in the decode. Claimed bit-identical
  against 120 real LLR vectors.
- **Both LLR sets are built for every candidate before the sync gate that 70% of them fail**, and
  `llrPasses` is called twice per candidate. Making `llr` lazy in `pipeline.js` would skip most of
  the 448 ms. Careful: stage 3 needs both sets even for a gated candidate, so only the worker's
  `lite: true` path can skip them.
- **fft.js still uses the generic r x r combine**, which is 16 complex multiplies per radix-4
  butterfly. Unrolling radix 2/3/4/5 and dropping the scratch copy-back was measured at a further
  large win, and `fft()` still allocates two output arrays per call (68% of the 32-point call cost;
  an `fftInto(out)` variant would remove it).
- **Stage 1's causal ladder recomputes all 84 sync surfaces from scratch** (about 2 s of chunked
  background work). Six running accumulators over R would make it roughly 85x less work and stay
  bit-identical, because for a fixed (bin, lag) the terms arrive in the same order either way. It
  would not reduce the ~60 MB the ladder holds.
- **Subtraction recomputes the filtered amplitude it already had** for the winning offset: 2 of
  the 8 FFTs of 180 000 points are avoidable.
- **A real-input FFT is worth another 1.87x on `powerSpectrum` but is NOT bit-identical.** That is
  a deliberate decision about faithfulness, not a free win, so it was left alone.
- **Do not swap `Math.hypot` for `sqrt` in `llrPasses`.** It is 10.6x faster and changes 38% of
  the LLR inputs.

On the UI side:

- `heatmap()` puts `colRange` in its cache key, so every step of a frequency-zoom drag re-renders
  the visible cells instead of cropping a cached full-width image with a 9-argument `drawImage`.
  Stage 4 drops to about 30 fps during such a drag (three panels); every other page holds 60. The
  crop only works for the non-pooled callers, since pooling depends on the visible range, and it
  would make color-slider drags render the full width instead of the zoomed slice. Precomputing
  the dB transform per spectrogram (58% of the pixel loop for the `log: true` callers) helps both
  drags but costs about 2.6 MB per pass.
- The clock emits to every subscriber on every animation frame. Pages now guard themselves, so
  this is only wasted dispatch, but a 120 Hz display does twice the work for nothing.

## 8. Guided experiments ("Try this")

Every stage has a strip of one-click experiments above its plots, built by `tryThis()` in
`controls.js`. Each one starts from that page's defaults and changes a single knob, so the outcome
quoted under the row holds whichever button you press first.

- Every number in those lines was read off the running page on the bundled window, not estimated.
  Stage 0's claims are the only ones that hold for any audio, since they follow from FS/nfft.
- Because of that they carry a caveat line when a different WAV is loaded, evaluated at click time
  (`app.name` can change while a page stays mounted). If the defaults or the bundled window ever
  change, these strings need re-measuring: click each button and read the Counts, Readout or
  Result panel.
- Stage 4's three ad-hoc zoom buttons were folded into its strip, so the zooms now come with a
  reason to look.
- `cdp_check.mjs` clicks every experiment on every page, so a broken one fails the check.

Still open: the tour on the home page hard-codes the same numbers in prose, so it has the same
re-measuring cost, and nothing enforces that the two agree.

## 9. Mobile: one responsive app, not a second build

Decision (2026-09-09): the same page serves a phone. The alternative, a separate mobile version,
was rejected because every drawing function here already derives its plot box from `cv.w` / `cv.h`,
so a canvas built at 344 px instead of 1060 px adapts on its own; a second build would have
duplicated 1200 lines of visualization to change one number.

What that cost, concretely:

- `fitW(panel, pref, min)` in `controls.js` returns the panel's content width clamped to the old
  hard-coded literal. Pages pass the literal they used to hard-code, so a wide screen is unchanged.
  It only works because `.row > * { min-width: 0 }` now lets a plot column shrink below the
  min-content width of the canvases inside it; without that a flex item's automatic minimum size
  pinned every stage page at 1026-1102 px inside a 390 px screen, and `main { overflow-x: hidden }`
  (now gone) threw the rest away with no way to scroll to it.
- Pages expose `resize()` next to `setTab`. `app.js` watches a quantized width plus the device
  pixel ratio, which is what makes it safe: iOS fires `resize` continuously while its URL bar
  collapses during a scroll, and Android fires one whenever the keyboard opens over a text field.
  Neither changes the width, so both expire into a no-op.
- `onPlot()` is the one pointer path. A touch screen has no hover, so a press-and-drag stands in
  for one and a tap both fills the readout and picks. It also handles a synthesized `click`, which
  is what `cdp_check.mjs` and assistive technology dispatch.

Three plots refuse to shrink and keep an intrinsic width inside a panel that pans sideways, because
below a floor they stop teaching anything: stage 2's 79-column tone grid (520 px, under which the
green mismatch box is half a pixel), stage 3's Tanner graph (700 px) and one-check view (810 px),
and stage 5's tone row (1080 px, where the clock now drives `scrollLeft` so the cursor stays in
view). Everything else shrinks.

Stage 4 stacks its three waterfalls on a narrow screen rather than shrinking them to 107 px each.
Stacked they share one x mapping, so 1551 Hz is the same column in all three, which reads better
for "is it gone?" than side by side did.

Two behaviour changes a phone forced, both of which also help a laptop:

- Stage 4 opens on **wsjtr's recorded residuals**, not the live decoder. Merely navigating there
  used to start a 3-pass worker decode: 19 s of one core on a desktop, closer to a minute on a
  phone. "Live" is one tap away and starts it then.
- On a constrained device (coarse pointer, narrow screen, <= 4 GB or <= 4 cores) a window with no
  reference decode list gets a single depth-3 pass instead of three passes with subtraction, the
  heatmap cache ceiling drops from 32 MB to 8 MB, and stage 1's causal ladder steps 12 spectrogram
  rows instead of 4 (28 surfaces, ~20 MB, against a measured 61.2 MB before).

Fixed on the way through, and it was a real bug at every size: `heatmap()`'s max-pooling mapped
source rows with `floor(r / n * pr)`, which is not the identity when `pr === n` because
`49 / 165 * 165` is `48.99999999999999`. 13 of 165 rows were never written and painted as the
colormap floor. It only showed once pooling became automatic, since the one previous caller always
pooled to a smaller grid.

Still open: the desktop plot column now fills its row rather than hugging its canvases, so a plot
panel can be ~70 px wider than the canvas inside it. Measuring the column is what makes `fitW`
work, and a shrink-to-fit column makes that measurement circular. The alternative is a per-page
measure-then-pin, which stage 1 briefly had; it was removed so that all six pages behave the same.

## How to resume

```bash
npm start                       # serve on :8765
npm test                        # Node decode check vs wsjtr's list
node tools/cdp_check.mjs        # drives every page/tab in headless Chrome
node tools/cdp_check.mjs --mobile   # the same sweep at 390x844 with touch; exits 1 on a finding
node tools/cdp_shot.mjs <page> out.png "<js to run first>"
node tools/cdp_shot.mjs <page> out.png --viewport=390x844 --full
```
See CLAUDE.md for the layout and conventions.
