// In-place iterative radix-2 complex FFT for the power-of-two sizes the JTTY receiver uses
// (8192 for the sync surface, 16384 and 32768 for the analytic signal and subtraction).
// Same conventions as WSJT-X four2a: forward is exp(-j...), inverse is exp(+j...), neither scaled.
const plans = new Map();
function plan(n) {
  let p = plans.get(n); if (p) return p;
  if (n & (n - 1)) throw new Error('fftPow2: size must be a power of two, got ' + n);
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  p = { rev, cos, sin }; plans.set(n, p); return p;
}
export function fftPow2(re, im, inverse = false) {
  const n = re.length, { rev, cos, sin } = plan(n), sg = inverse ? -1 : 1;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let st = 0; st < n; st += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t], wi = sg * sin[t], a = st + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}
