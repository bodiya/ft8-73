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
export function button(parent, label, onclick) { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', onclick); parent.append(b); return b; }
export function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
export function panel(parent, title, cls = '') { const p = el('div', 'panel ' + cls); if (title) p.append(el('h3', null, title)); parent.append(p); return p; }
export function canvas(parent, w, h) { const c = document.createElement('canvas'); const dpr = window.devicePixelRatio || 1; c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px'; parent.append(c); const g = c.getContext('2d'); g.scale(dpr, dpr); c.g = g; c.w = w; c.h = h; return c; }
