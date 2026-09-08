# Pending decisions and where to pick up

Status as of 2026-09-08: every page runs end to end and `node tools/cdp_check.mjs` passes
clean. The items below are choices Brian has not made yet, plus loose ends noticed while
building. Nothing here blocks use of the app.

## 1. Which stage-1 template animation to keep

Three tabs in the right-hand panel of **1 · Coarse sync** show the same computation:

| Tab | What the clock does | Notes |
|---|---|---|
| A · lag sweep | slides the 21-cell template through all 125 lags at one frequency | original; simplest to explain |
| B · frequency sweep | slides it across the zoom span at one lag; score trace along the sweep | needs a narrow zoom span to be watchable |
| C · causal reveal | re-runs the whole search on only the audio heard so far | explains early decoding; first play-through computes ~85 surfaces (70 ms each) and caches them |

Decide: keep all three, or keep A + C and drop B. Candidate rings clutter view C at
mid-window (many spurious candidates before two arrays are heard); that is real behavior, but
a "hide candidates" toggle may help.

## 2. Which stage-3 belief-propagation view to keep

Tabs on **3 · LDPC**: A Tanner graph, B circular, C reliability heatmap (iteration × bit,
plus checks per iteration), D one check node with its numeric messages. OSD and AP tabs are
separate and should stay.

Impressions from building them: C is the clearest for "does it converge and where are the
wrong bits"; D is the only one that shows the actual arithmetic; A and B are pretty but
busy with all 522 edges drawn. Suggested cut: keep C and D, keep one of A/B.

Also open: the strongest candidate decodes at iteration 0, so the default demo is dull.
Options: default stage 3 to a weak candidate (e.g. the first one that needs > 5 iterations),
or preset noise σ ≈ 2.

## 3. Stage-4 default: recorded residuals or live JS run

Tab A shows wsjtr's recorded per-outer-pass input audio; tab B runs this decoder's three
passes in a worker (~10 s for pass 2 to appear because each subtraction is 8 FFTs of
180 000 points). Live is the default now. Decide whether A stays (it only applies to the
bundled window), and whether to speed up the FFT (an iterative mixed-radix or split-radix
implementation would give 3–5×; `src/dsp/fft.js` is the only place to change).

Related fact: wsjtr's `passN.wav` is the input to the N-th *outer* pass, and each outer
pass has up to four internal decode/subtract rounds. The `pass` field in
`data/260726_190930.decodes.json` was inferred from output bursts and does not correspond
to subtraction rounds. If exact per-round residuals matter, add a debug dump to wsjtr.

## 4. Scope not ported

- A7 cross-sequence decoding (needs callsigns from previous windows) and AP types 3–6
  (need QSO context). Both could be demonstrated with a second recorded window.
- `--rx-frequency` two-pass candidate selection and `--refine-top`.
- wsjtr's internal multi-round scheduling within an outer pass (JS does one subtraction
  round per pass, then escalates depth 1 → 2 → 3).
- Hashed callsigns unpack as `<...>` (no call-hash table).

## 5. Smaller loose ends

- Stage 0 audio playback below 0.5× drops pitch with speed (plain `playbackRate`). A
  phase-vocoder or granular stretch would keep pitch; probably not worth it.
- Stage 2 could show the tone grid built from the coarse 3.125 Hz spectrogram next to the
  fine-sync one, to make the point of the baseband/fine-sync step.
- Encode page: Field Day / RTTY / EU VHF packing is ported but has no examples in the UI;
  the "try:" list only shows standard and free-text messages.
- "Open WAV" accepts any length ≥ 12.64 s and truncates to 15 s; there is no UI for
  choosing which 15 s of a longer file.
- No mobile/narrow layout; canvases are fixed-width (1000–1060 px).
- Hosting: the app is static and would work on GitHub Pages as-is (the data directory is
  ~1 MB).

## How to resume

```bash
npm start                       # serve on :8765
npm test                        # Node decode check vs wsjtr's list
node tools/cdp_check.mjs        # drives every page/tab in headless Chrome
node tools/cdp_shot.mjs <page> out.png "<js to run first>"
```
See CLAUDE.md for the layout and conventions.
