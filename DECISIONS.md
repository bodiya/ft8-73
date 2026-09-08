# Pending decisions and where to pick up

Status as of 2026-09-08: every page runs end to end and `node tools/cdp_check.mjs` passes
clean. Sections 1 to 3 were open choices and are now decided (keep every view, and integrate
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
are committed; see "Host it" in the README. Verified in headless Chrome from `/ft8-for-dummies/`,
`/ft8-for-dummies` and `/ft8-for-dummies/index.html#ldpc/heat`, including the module worker.

## How to resume

```bash
npm start                       # serve on :8765
npm test                        # Node decode check vs wsjtr's list
node tools/cdp_check.mjs        # drives every page/tab in headless Chrome
node tools/cdp_shot.mjs <page> out.png "<js to run first>"
```
See CLAUDE.md for the layout and conventions.
