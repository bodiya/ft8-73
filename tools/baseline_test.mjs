// Baseline sanity test: fit a smooth floor to the averaged spectrum; check it sits under the spectrum and near its low percentile.
import fs from 'node:fs';
import { parseWav } from '../src/dsp/wav.js';
import { spectrumBaseline, xbaseFromSbaseDb, polyfitWsjt, BASELINE_DF } from '../src/dsp/baseline.js';

const { samples } = parseWav(fs.readFileSync('data/260726_190930.wav').buffer);
let t = Date.now();
const b = spectrumBaseline(samples, 200, 4007);
console.log(`baseline: ${b.nAveraged} spectra averaged, bins ${b.ia}..${b.ib}, ${b.points.length} fit points, ${Date.now() - t} ms`);
console.log('coeffs:', Array.from(b.coeffs).map(v => v.toExponential(3)).join(' '));
let below = 0, n = 0, sumDiff = 0;
for (let i = b.ia; i <= b.ib; i++) { n++; if (b.sbaseDb[i] <= b.savgDb[i]) below++; sumDiff += b.savgDb[i] - b.sbaseDb[i]; }
console.log(`baseline below averaged spectrum in ${below}/${n} bins; mean (spectrum - baseline) = ${(sumDiff / n).toFixed(2)} dB`);
for (const f of [300, 737, 1000, 1551, 2000, 3000, 3900]) console.log(`  ${f} Hz: savg ${b.savgDb[Math.round(f / BASELINE_DF)].toFixed(1)} dB, sbase ${b.sbaseDb[Math.round(f / BASELINE_DF)].toFixed(1)} dB, xbase ${xbaseFromSbaseDb(b.sbaseDb, f).toExponential(2)}`);
// polyfit check: exact recovery of a quartic
const xs = [], ys = []; for (let x = -20; x <= 20; x += 2.5) { xs.push(x); ys.push(3 - 0.5 * x + 0.02 * x * x + 0.001 * x ** 3 - 0.00005 * x ** 4); }
console.log('polyfit recovers [3, -0.5, 0.02, 0.001, -5e-5]:', Array.from(polyfitWsjt(xs, ys)).map(v => +v.toPrecision(4)));
