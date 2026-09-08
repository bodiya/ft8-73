# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A no-build, static web app of interactive visualizations that teach how an FT8 decoder
works, one page per DSP stage, with live-tweakable parameters and a shared transport clock.
Every algorithm is a JavaScript port of Brian's Rust decoder **wsjtr**
(`~/repos/wsjtr-public`, itself a port of WSJT-X). Faithfulness to wsjtr is the rule: when
adding or changing DSP, port from the Rust rather than inventing, and cite the Rust/Fortran
origin in a comment. License is GPLv3 (inherited from WSJT-X).

## Run and test

```bash
npm start                       # python3 -m http.server 8765 ; open http://localhost:8765/
npm test                        # tools/decode_test.mjs [wav] [depth]: JS decoder vs wsjtr's decode list
node tools/osd_test.mjs         # OSD / AP port checks
node tools/subtract_test.mjs    # subtraction + baseline SNR checks vs wsjtr's residual WAV
node tools/pack77_test.mjs      # message packing round-trips (+ ft8coder comparison if built)
node tools/baseline_test.mjs
node tools/cdp_check.mjs        # drives every page and tab in headless Chrome; must end "no console errors or exceptions"
node tools/cdp_shot.mjs <page> <out.png> ["<js expression run before the shot>"]
```

The page must be served over HTTP (ES modules + fetch); `file://` shows an explanatory
message instead. `google-chrome` is used headless by the CDP tools. After any UI change,
run `cdp_check.mjs` and look at a screenshot from `cdp_shot.mjs`; after any DSP change, run
`npm test` and the relevant `tools/*_test.mjs`. Expected `npm test` result on the bundled
window at depth 3: 30 unique messages, all 18 of wsjtr's pass-1 decodes, nothing outside
wsjtr's list.

## Layout

```
index.html              shell: top bar (nav, open WAV, example), transport bar, #stage
src/ui/app.js           app state, routing (#hash per page), data loading, worker wiring, clock
src/ui/clock.js         transport clock (t, duration, speed, loop); each page sets its own duration
src/ui/controls.js      slider/select/checkbox/button/panel/canvas builders
src/ui/draw.js          colormaps, heatmap (with max-pool option), axes, line plots
src/ui/styles.css
src/dsp/                the decoder (see README for the file → Rust module map)
src/vis/                one module per page: home, stage0_signal … stage4_passes, stage5_encode
data/                   bundled window (raw + wsjtr's pass-2/3 residual WAVs) and decode lists
tools/                  Node tests and the CDP drivers
DECISIONS.md            pending choices and loose ends; update it when they change
```

## Conventions

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
  (~70 ms).
- Text style in the UI: no em-dashes; short blurbs; numbers in tables or readouts.

## Data provenance

`data/260726_190930*.wav` and the decode JSON come from the HamX capture
`~/ham/hamx/data/cap-3-attempt2` (2026-07-26 19:09:30 UTC, 20 m). The `pass` field was
inferred from wsjtr's output bursts; wsjtr's `passN.wav` is the input to outer pass N,
which internally ran several decode/subtract rounds.
