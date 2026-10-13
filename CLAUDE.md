# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A no-build, static web app of interactive visualizations that teach how an FT8 decoder
works, one page per DSP stage, with live-tweakable parameters and a shared transport clock.
Every algorithm is a JavaScript port of Brian's Rust decoder **wsjtr**
(https://github.com/bodiya/wsjtr, usually checked out next to this repo as `../wsjtr-public`;
itself a port of WSJT-X). Faithfulness to wsjtr is the rule: when adding or changing DSP, port
from the Rust rather than inventing, and cite the Rust/Fortran origin in a comment. License is
GPL-3.0-only (WSJT-X is GPLv3).

## Run and test

```bash
npm start                       # python3 -m http.server 8765 ; open http://localhost:8765/
npm stop                        # kill a server left on 8765 (npm stop && npm start to restart)
npm test                        # tools/decode_test.mjs [wav] [depth]: JS decoder vs wsjtr's decode list
node tools/osd_test.mjs         # OSD / AP port checks
node tools/subtract_test.mjs    # subtraction + baseline SNR checks vs wsjtr's residual WAV
node tools/pack77_test.mjs      # message packing round-trips (+ ft8coder comparison if built)
node tools/baseline_test.mjs
node tools/jtty_test.mjs        # JTTY: codec, encoder, list decoder and receiver vs WSJT-X's Fortran
node tools/cdp_check.mjs        # drives every page and tab in headless Chrome; must end "no console errors or exceptions"
node tools/cdp_check.mjs --mobile          # the same sweep at 390x844 with touch: real taps, and it
                                           # reports horizontal overflow, unreachable taps and tap
                                           # targets under 44 px. --mobile=844x390@2 for landscape.
node tools/cdp_shot.mjs <page> <out.png> ["<js expression run before the shot>"]
node tools/cdp_shot.mjs <page> <out.png> --viewport=390x844 [--full]
```

The page must be served over HTTP (ES modules + fetch); `file://` shows an explanatory
message instead. `google-chrome` is used headless by the CDP tools. After any UI change,
run `cdp_check.mjs` **and `cdp_check.mjs --mobile`**, and look at a screenshot from
`cdp_shot.mjs` at both sizes; after any DSP change, run `npm test` and the relevant
`tools/*_test.mjs`. The mobile run exits non-zero when it finds a layout or tap-target
problem, so it can gate a commit; the desktop run always exits 0. Expected `npm test` result on the bundled
window at depth 3: 30 unique messages, all 18 of wsjtr's pass-1 decodes, nothing outside
wsjtr's list.

## Layout

```
index.html              shell: top bar (nav, open WAV, example), transport bar, #stage
src/ui/app.js           app state, routing (#page or #page/view), data loading, worker wiring, clock, idle warm-up
src/ui/clock.js         transport clock (t, duration, speed, loop); each page sets its own duration
src/ui/controls.js      slider/select/checkbox/button/panel/canvas builders, layers(), tabbar(), caption()
src/ui/draw.js          colormaps, cached heatmap renderer, axes, line plots
src/ui/styles.css
src/dsp/                the decoder (see README for the file → Rust module map)
src/dsp/jtty/           JTTY (WSJT-X 3.2 lib/jtty): codec, fec, wave, receiver, worker
src/vis/                one module per page: home, stage0_signal … stage4_passes, stage5_encode, jtty
data/                   bundled window (raw + wsjtr's pass-2/3 residual WAVs) and decode lists
tools/                  Node tests and the CDP drivers
.github/workflows/      GitHub Pages deploy; .nojekyll and _headers are the other hosting bits
DECISIONS.md            pending choices and loose ends; update it when they change
```

## Conventions

- Every source file starts with the copyright header: `Copyright (c) 2026 Brian Bodiya (KC1WIH)`
  and `Licensed under the GNU GPL, version 3 only. See LICENSE.` A file that ports WSJT-X code
  (directly or through wsjtr) adds the two-line WSJT-X notice; copy it from any `src/dsp` port.
- Plain ES modules, no dependencies, no bundler. Keep it that way so it hosts anywhere.
- Page module shape: `export default { mount(root, app), unmount() }`. Guard on
  `app.ready`; subscribe to `app.clock` and `app.on(...)` and push the unsubscribers into a
  module-level list that `unmount()` drains.
- Shared state lives on `app` (`audio`, `spec`, `surf`, `hits`, `candidates`, `selected`,
  `truth`, `syncParams`, `trace`). `app.ref()` is the reference decode list (wsjtr's for the
  bundled window, the JS decoder's `truth.js` otherwise); `app.truthFor(cand)` matches a
  candidate to it. `app.getCtx()` lazily builds the 192k-point FFT context;
  `app.getBaseline()` the SNR baseline.
- Clock semantics are per page (audio time, lag sweep, symbol index, BP iteration);
  call `app.clock.setDuration()` in `mount`.
- LLR sign convention inside `src/dsp`: after `pipeline.js` flips WSJT-X's metrics,
  **negative = bit 1** (jt9r's convention). `llr.js` output is the WSJT-X sign; `ldpc.js`,
  `osd.js`, `ap.js` expect the flipped one.
- Sample indexing: the recording starts 0.5 s before the nominal slot start, so a signal
  with DT = 0 begins at sample 6000; subtraction takes `dt + 0.5`.
- Heavy work (multi-pass decode with subtraction) runs in `src/dsp/worker.js`; the main
  thread computes a single candidate trace synchronously (~5 ms) and the sync surface
  (~40 ms).
- Text style in the UI: no em-dashes; short blurbs; numbers in tables or readouts.
- The same app serves phones; there is no separate mobile build. A page sizes every canvas with
  `fitW(panel, <the desktop width>, <a floor>)` from `controls.js` and exposes `resize()` next to
  `setTab` (assigned in `mount`, nulled in `unmount`) so `app.js` can rebuild it on a rotation.
  All the drawing code already derives its plot box from `cv.w` / `cv.h`, so a smaller canvas is
  usually the only change needed. Pointer input goes through `onPlot()`, which makes a touch drag
  stand in for hover. Below 760 px `styles.css` stacks every `.row` and moves the controls panel
  after the plots; below 1100 px it does the latter alone.

## Performance rules

The transport clock fires on every animation frame, so the per-tick path is the budget. Follow
these or the app gets slow again:

- **Nothing expensive in a clock subscriber.** Split each plot with `layers(parent, w, h, 2)`
  from `controls.js`: index 0 is the background (heatmaps, axes, annotations, anything that
  depends only on the controls), the last index is a transparent overlay that carries the
  playhead and takes the pointer events. Redraw the background from control handlers and app
  events, the overlay from the clock.
- **Skip redundant frames.** Most pages quantize the clock (a lag index, a symbol, a BP
  iteration, 4 spectrogram rows). Keep the last quantized value and return early when it has not
  changed; a 60 Hz tick on a half-second BP iteration is 30 wasted redraws.
- **`heatmap()` caches its rendered offscreen canvas** keyed on the identity of `data` plus every
  parameter that affects a pixel. Pass a stable array. If you must rebuild the array in place,
  pass a `version` that changes when the contents do (see stage 1's template view).
- **Precompute at mount, tab entry or idle, never in a frame.** `app.warm()` builds the
  192k-point `DecodeContext` and the SNR baseline on the first idle callback and then starts the
  background JS decode; `app.ensureJsDecoder()` starts that decode on demand. Stage 1 builds its
  causal ladder in chunked `setTimeout` work with a progress readout.
- **`powerSpectrum()` returns a fresh array but reuses its working buffers**, so the result is
  safe to hold; do not reintroduce a shared output buffer, it was worth 2%.
- **DSP changes must be output-identical.** Both kernel speedups (`toneSums` in `sync.js`, the
  twiddle tables in `fft.js`) were verified by diffing every value against the previous
  implementation, not just by running `npm test`. Do the same: import both versions in a scratch
  script and compare arrays element by element before trusting a change.

## Routing and views

The hash is `#<page>` or `#<page>/<view>`. `route()` in `app.js` remounts on a page change but
calls the page module's `setTab(id)` on a view change, so switching views does not rebuild the
DOM. A page with views: read `app.tabFor(page, validIds)` in `mount` for the view to open with
(URL first, then the remembered one), build the bar with `tabbar(...)` whose `onpick` is
`app.setTab`, expose `setTab` on the module (and null it in `unmount`), and give every view a
`caption()` saying what the clock does there and what to look for.

## Hosting

Every runtime URL resolves against `import.meta.url` (`app.asset('data/...')` for data files,
`new URL('../dsp/worker.js', import.meta.url)` for the worker), so the app runs from any subpath.
Do not add document-relative `fetch()` or `new Worker()` paths.

## JTTY

The `#jtty` page is the exception to "port from wsjtr": JTTY is ported from WSJT-X 3.2's Fortran
(`lib/jtty` at commit e3ffc38 of https://github.com/bodiya/wsjtx), with the Fortran file
cited in each module. It runs on its own audio (`st.audio` in `src/vis/jtty.js`), not `app.audio`,
and its receiver runs in `src/dsp/jtty/worker.js`, streaming one decode window at a time. After a
change to `src/dsp/jtty`, run `node tools/jtty_test.mjs`; its fixtures were made by Fortran
drivers linked against that code, and a change that moves a hypothesis or a decode is a bug.

## Data provenance

`data/260807_134110.wav` is WSJT-X's `samples/JTTY/260807_134110.wav`, and
`data/260807_134110.jtty.json` is `rjtty 2.6 1 384 1500 50` run on it.
`data/260726_190930*.wav` and the decode JSON come from recordings made at HamX, a ham radio
conference (capture set `cap-3-attempt2`, 2026-07-26 19:09:30 UTC, 20 m). The `pass` field was
inferred from wsjtr's output bursts; wsjtr's `passN.wav` is the input to outer pass N,
which internally ran several decode/subtract rounds.
