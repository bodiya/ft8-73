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
export function button(parent, label, onclick) { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', onclick); parent.append(b); return b; }
export function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
export function panel(parent, title, cls = '') { const p = el('div', 'panel ' + cls); if (title) p.append(el('h3', null, title)); parent.append(p); return p; }
/** Backing-store scale. Capped at 2: a 3x display would quadruple the fill cost of every canvas
 *  for no visible gain on these plots, and every page here is fill-bound, not vector-bound. */
export const DPR_CAP = 2;
export function dpr() { return Math.min(window.devicePixelRatio || 1, DPR_CAP); }
function mkCanvas(w, h) {
  const c = document.createElement('canvas'); const d = dpr();
  c.width = Math.round(w * d); c.height = Math.round(h * d); c.style.width = w + 'px'; c.style.height = h + 'px';
  const g = c.getContext('2d'); g.scale(d, d); c.g = g; c.w = w; c.h = h; return c;
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
 * change looks like: the strip is the guided version of the same controls.
 *
 * suffix is appended to every line, and may be a function so it can be evaluated at click time:
 * the pages use it to say so when the loaded audio is not the bundled window the numbers came from,
 * which can change while the page stays mounted (the top bar's "open WAV").
 */
export function tryThis(parent, items, suffix = '') {
  const box = el('div', 'trythis'); box.append(el('span', 'lab', 'Try this'));
  const see = el('div', 'see'); const btns = [];
  for (const it of items) {
    const b = el('button', '', it.label);
    b.onclick = () => { for (const x of btns) x.classList.remove('active'); b.classList.add('active'); it.run(); see.innerHTML = (it.see || '') + (typeof suffix === 'function' ? suffix() : suffix); };
    box.append(b); btns.push(b);
  }
  box.append(see); parent.append(box);
  return { el: box, clear() { for (const x of btns) x.classList.remove('active'); see.innerHTML = ''; } };
}

/** The "what the clock does here / what to look for" caption that sits under a tab bar. */
export function caption(parent, cls = '') {
  const c = el('div', 'tabcap ' + cls); parent.append(c);
  return { el: c, set(clock, look) { c.innerHTML = (clock ? `<b>clock:</b> ${clock}` : '') + (look ? `<span class="sep"></span><b>look for:</b> ${look}` : ''); } };
}
