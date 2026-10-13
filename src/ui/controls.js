// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// Licensed under the GNU GPL, version 3 only. See LICENSE.
//
// Tiny control builders. Each returns the wrapper element; value getters via .value.
export function slider(parent, { label, min, max, step = 1, value, fmt = v => v, oninput }) {
  const w = document.createElement('div'); w.className = 'ctl';
  const lab = document.createElement('div'); lab.className = 'lab'; const b = document.createElement('b');
  lab.append(label, b); const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  const upd = () => { b.textContent = fmt(+inp.value); };
  inp.addEventListener('input', () => { upd(); oninput && oninput(+inp.value); });
  upd(); w.append(lab, inp); parent.append(w);
  Object.defineProperty(w, 'value', { get: () => +inp.value, set: v => { inp.value = v; upd(); } }); w.input = inp;
  return w;
}
export function select(parent, { label, options, value, onchange }) {
  const w = document.createElement('div'); w.className = 'ctl';
  const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = label;
  const sel = document.createElement('select');
  for (const o of options) { const op = document.createElement('option'); const [v, t] = Array.isArray(o) ? o : [o, o]; op.value = v; op.textContent = t; sel.append(op); }
  sel.value = value; sel.addEventListener('change', () => onchange && onchange(sel.value));
  w.append(lab, sel); parent.append(w); Object.defineProperty(w, 'value', { get: () => sel.value, set: v => { sel.value = v; } }); w.select = sel;
  return w;
}
export function checkbox(parent, { label, value, onchange }) {
  const w = document.createElement('label'); w.className = 'ctl check';
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!value; inp.addEventListener('change', () => onchange && onchange(inp.checked));
  w.append(inp, label); parent.append(w); Object.defineProperty(w, 'value', { get: () => inp.checked, set: v => { inp.checked = v; } });
  return w;
}
/**
 * A text field in the same shape as slider()/select(). Carries the mobile keyboard hints every
 * field in this app wants: the inputs here are callsigns and FT8 messages, which are upper case,
 * are not words, and must not be autocorrected. The 16px font is not cosmetic: iOS Safari zooms
 * the whole page in when a focused control is smaller than that and never zooms back out.
 */
export function textInput(parent, { label, value, oninput, mono = true }) {
  const w = document.createElement('div'); w.className = 'ctl';
  const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = label;
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = value;
  inp.setAttribute('autocapitalize', 'characters'); inp.setAttribute('autocorrect', 'off');
  inp.setAttribute('autocomplete', 'off'); inp.spellcheck = false; inp.setAttribute('enterkeyhint', 'done');
  if (mono) inp.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
  inp.addEventListener('input', () => oninput && oninput(inp.value));
  w.append(lab, inp); parent.append(w);
  Object.defineProperty(w, 'value', { get: () => inp.value, set: v => { inp.value = v; } }); w.input = inp;
  return w;
}
/**
 * Coalesce repeated calls into at most one run per animation frame, last arguments win.
 * Slider `input` events fire far faster than the work behind them (a spectrogram rebuild, a full
 * decode, a re-synthesis), and without this a drag queues one of those per event. When the work
 * itself is longer than a frame this self-throttles to "run, then run again with the latest
 * value", which is what a drag should do.
 */
export function coalesce(fn) {
  let raf = 0, args = null;
  return (...a) => {
    args = a;
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; const x = args; args = null; fn(...x); });
  };
}
/**
 * Run at most once per `ms` of quiet. coalesce() is the right throttle when the work fits in a
 * frame; this is the one for work that does not (stage 5's 372 FFTs, ~0.7 s on a phone), where
 * running per frame during a drag just queues a backlog the finger has already moved past.
 */
export function debounce(fn, ms = 250) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function button(parent, label, onclick) { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', onclick); parent.append(b); return b; }
export function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
export function panel(parent, title, cls = '') { const p = el('div', 'panel ' + cls); if (title) p.append(el('h3', null, title)); parent.append(p); return p; }

// ---- viewport ----
/** Below this the page is one column: controls under the plots, no side columns. */
export const NARROW = 760;
export function vw() { return document.documentElement.clientWidth; }
export function isNarrow() { return vw() < NARROW; }
/** True on a touch screen. Drives hit-target sizes and "tap" wording, never layout. */
export function coarse() { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } }
/**
 * True when this device should be given the cheaper version of the expensive views: a coarser
 * causal ladder, a smaller heatmap cache, no auto-started decoder. Deliberately not a user-agent
 * test: what matters is core count, RAM and screen size, all of which a desktop can also report.
 */
export function constrained() {
  const mem = navigator.deviceMemory || 8, cpu = navigator.hardwareConcurrency || 8;
  return coarse() || isNarrow() || mem <= 4 || cpu <= 4;
}
/**
 * The width to build a plot at inside `parent`: the parent's content box, clamped to the caller's
 * preferred (desktop) width and to a floor below which the plot stops being a plot. Pages pass
 * the literal they used to hard-code as `pref`, so nothing changes on a wide screen.
 *
 * Measured rather than derived from the viewport because the columns differ per page. That only
 * works if the plot column can actually shrink, which is what `.row > * { min-width: 0 }` and
 * `.stagemain` in styles.css are for; without them a flex item's automatic minimum size is the
 * min-content width of the fixed canvases inside it and this would always return `pref`.
 */
export function fitW(parent, pref, min = 300) {
  let avail = 0;
  if (parent && parent.isConnected) {
    const cs = getComputedStyle(parent);
    avail = parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  }
  if (!(avail > 0)) avail = vw() - 48;                 // detached or display:none: fall back to the viewport
  return Math.max(min, Math.min(pref, Math.floor(Math.min(avail, vw() - 8))));
}

// ---- canvases ----
/** Backing-store scale. Capped at 2: a 3x display would quadruple the fill cost of every canvas
 *  for no visible gain on these plots, and every page here is fill-bound, not vector-bound. */
export const DPR_CAP = 2;
export function dpr() { return Math.min(window.devicePixelRatio || 1, DPR_CAP); }
/**
 * Point a canvas at a new CSS size. Assigning .width/.height reallocates the backing store AND
 * resets the 2D transform, so the device-pixel scale has to be re-applied every time; setTransform
 * rather than scale() so repeated calls do not compound. Keeps the invariant the hit tests rely
 * on: c.w and c.h are the canvas's CSS size, so getBoundingClientRect() agrees with them.
 */
export function sizeCanvas(c, w, h) {
  const d = dpr();
  const bw = Math.round(w * d), bh = Math.round(h * d);
  if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
  c.style.width = w + 'px'; c.style.height = h + 'px';
  c.g.setTransform(d, 0, 0, d, 0, 0);
  c.w = w; c.h = h; c.d = d;
  return c;
}
function mkCanvas(w, h) {
  const c = document.createElement('canvas'); c.g = c.getContext('2d');
  return sizeCanvas(c, w, h);
}
export function canvas(parent, w, h) { const c = mkCanvas(w, h); parent.append(c); return c; }

/**
 * n stacked canvases sharing one CSS box, for splitting a plot into a static background that is
 * redrawn only when its inputs change and a cheap overlay that follows the transport clock.
 * Returns the array (index 0 = bottom); only the top canvas takes pointer events, and it has the
 * same bounding rect as the others, so existing hit-testing code keeps working unchanged.
 */
export function layers(parent, w, h, n = 2) {
  const box = document.createElement('div'); box.className = 'layers'; box.style.width = w + 'px'; box.style.height = h + 'px';
  const out = [];
  for (let i = 0; i < n; i++) { const c = mkCanvas(w, h); if (i < n - 1) { c.className = 'bg'; c.style.pointerEvents = 'none'; } else c.className = 'hit'; box.append(c); out.push(c); }
  parent.append(box); out.box = box; out.top = out[n - 1]; out.w = w; out.h = h;
  return out;
}

/**
 * Re-size a canvas or a layers() group in place. Pages call this from their resize() hook, then
 * redraw: every draw function here already derives its plot box from cv.w / cv.h, so nothing else
 * has to change. Returns true when the size actually moved, so a caller can skip the redraw.
 */
export function resizePlot(target, w, h) {
  const isLayers = Array.isArray(target);
  const cur = isLayers ? target : { w: target.w, h: target.h };
  // The device pixel ratio is part of the size: a window dragged to a display with a different
  // ratio, or a desktop zoom, changes the backing store without changing the CSS box.
  const d = dpr(), first = isLayers ? target[0] : target;
  if (cur.w === w && cur.h === h && first && first.d === d) return false;
  if (isLayers) {
    target.box.style.width = w + 'px'; target.box.style.height = h + 'px';
    for (const c of target) sizeCanvas(c, w, h);
    target.w = w; target.h = h;
  } else sizeCanvas(target, w, h);
  return true;
}

/**
 * Pointer position in canvas coordinates. Scales by cv.w / rect.width rather than assuming they
 * are equal, so a canvas that CSS has scaled (a panel zoomed, a future max-width rule) still maps
 * taps to the right frequency instead of silently reporting one three times too low.
 */
export function canvasPos(cv, e) {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (cv.w / (r.width || cv.w)), y: (e.clientY - r.top) * (cv.h / (r.height || cv.h)) };
}

/**
 * Pointer input for a plot: one path for mouse, touch and pen.
 *
 * `onmove(x, y, e)` is the hover readout. A touch screen has no hover, so a press-and-drag stands
 * in for one: the readout follows the finger, and the pick only fires on release if the finger
 * stayed within TAP_SLOP of where it went down. That also means a tap both fills in the readout
 * and picks, which is what a mouse user gets from moving and then clicking.
 *
 * The canvas is left at `touch-action: pan-y` (styles.css) rather than `none`: a vertical swipe
 * that starts on a plot must still scroll the page, or half of every stage becomes unreachable.
 * The browser takes the gesture over in that case and sends pointercancel, which drops the pick.
 */
const TAP_SLOP = 10;
export function onPlot(cv, { onmove, onpick } = {}) {
  let id = null, x0 = 0, y0 = 0, moved = false, lastUp = -1e9, p0 = { x: 0, y: 0 };
  const pos = e => canvasPos(cv, e);
  const down = e => {
    id = e.pointerId; moved = false; x0 = e.clientX; y0 = e.clientY;
    // Capture, so a drag that wanders off the canvas still ends in pointerup here. Without it
    // pointerleave cancels the sequence, `up` never runs, and the click that follows the release
    // is then treated as a fresh synthesized one and picks wherever the finger let go.
    try { cv.setPointerCapture(e.pointerId); } catch { }
    p0 = pos(e); onmove && onmove(p0.x, p0.y, e);
  };
  const move = e => {
    if (id !== null && e.pointerId !== id) return;
    if (id === null && e.pointerType !== 'mouse') return;        // no hover without a press on touch
    if (id !== null && (Math.abs(e.clientX - x0) > TAP_SLOP || Math.abs(e.clientY - y0) > TAP_SLOP)) moved = true;
    const p = pos(e); onmove && onmove(p.x, p.y, e);
  };
  const up = e => {
    if (id === null || e.pointerId !== id) return;
    const wasTap = !moved; id = null; lastUp = e.timeStamp;
    // The position at PRESS, not at release: on a narrow screen the readout this fired on the way
    // down can grow a line and move the canvas under the finger before it lifts.
    if (wasTap && onpick) onpick(p0.x, p0.y, e);
  };
  // A gesture cut short still gets a trailing click in some paths (a pointerleave where capture was
  // refused), so arm the same one-shot suppression it would have had. Only when one was in flight:
  // a bare mouse leaving the canvas must not eat an unrelated click.
  const cancel = e => { if (id !== null && e && e.timeStamp != null) lastUp = e.timeStamp; id = null; };
  // A click that did NOT come from a pointer sequence is synthesized: the headless-Chrome sweep
  // dispatches one, and so does assistive technology. Pointer events alone would silently ignore
  // both, so handle it here and let the real-pointer path suppress the click that follows its own
  // pointerup (which also keeps a drag from picking where it happened to let go).
  // A pointer gesture is followed by its own click, which must not pick a second time. Suppress
  // exactly one click, and only one that arrives right after the release: a latch alone would
  // survive a gesture that ends without a click and swallow the next synthesized one instead.
  const click = e => {
    if (e.timeStamp - lastUp < 500) { lastUp = -1e9; return; }
    const p = pos(e); onmove && onmove(p.x, p.y, e); onpick && onpick(p.x, p.y, e);
  };
  cv.addEventListener('pointerdown', down);
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', cancel);
  cv.addEventListener('pointerleave', cancel);
  cv.addEventListener('click', click);
  return () => {
    cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move);
    cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', cancel);
    cv.removeEventListener('pointerleave', cancel); cv.removeEventListener('click', click);
  };
}

/**
 * Tab bar. items is [[id, label], ...]. onpick(id) is called on click; the caller decides whether
 * that means "change the hash" (deep-linkable views) or just re-render. Returns { el, set(id) }.
 */
export function tabbar(parent, items, current, onpick) {
  const bar = el('div', 'tabs'); const btns = new Map();
  for (const [id, label] of items) { const b = el('button', id === current ? 'active' : '', label); b.dataset.tab = id; b.onclick = () => onpick(id); bar.append(b); btns.set(id, b); }
  parent.append(bar);
  return { el: bar, set(id) { for (const [k, b] of btns) b.classList.toggle('active', k === id); } };
}

/**
 * "Try this" strip: a row of one-click experiments above a page's plots.
 *
 * Each item is { label, see, run }. run() applies the settings, which means setting the control
 * widgets (so the panel agrees with what is on screen) and calling the same redraw their handlers
 * would; see is the sentence of what to watch for, shown under the row once the button is pressed.
 * The point is that a reader should not have to guess which knob matters or what a meaningful
 * change looks like: the strip is the guided version of the same controls. On a phone it is more
 * than that: it is the whole interface, since the buttons fit where thirteen sliders do not.
 *
 * suffix is appended to every line, and may be a function so it can be evaluated at click time:
 * the pages use it to say so when the loaded audio is not the bundled window the numbers came from,
 * which can change while the page stays mounted (the top bar's "open WAV").
 */
export function tryThis(parent, items, suffix = '') {
  const box = el('div', 'trythis'); box.append(el('span', 'lab', 'Try this'));
  const strip = el('div', 'strip'); const see = el('div', 'see'); const btns = [];
  for (const it of items) {
    const b = el('button', '', it.label);
    b.onclick = () => { for (const x of btns) x.classList.remove('active'); b.classList.add('active'); it.run(); see.innerHTML = (it.see || '') + (typeof suffix === 'function' ? suffix() : suffix); };
    strip.append(b); btns.push(b);
  }
  box.append(strip, see); parent.append(box);
  return { el: box, clear() { for (const x of btns) x.classList.remove('active'); see.innerHTML = ''; } };
}

/** The "what the clock does here / what to look for" caption that sits under a tab bar. */
export function caption(parent, cls = '') {
  const c = el('div', 'tabcap ' + cls); parent.append(c);
  return { el: c, set(clock, look) { c.innerHTML = (clock ? `<b>clock:</b> ${clock}` : '') + (look ? `<span class="sep"></span><b>look for:</b> ${look}` : ''); } };
}
