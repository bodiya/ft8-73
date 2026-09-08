// Drive the app in headless Chrome over CDP: visit every stage and tab, poke controls, report console errors/exceptions.
import { spawn } from 'node:child_process';
const port = 9333;
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, '--window-size=1500,1200', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push('CONSOLE ' + m.params.args.map(a => a.value || a.description).join(' ')); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) errors.push('EVAL ' + expr.slice(0, 80) + ': ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:8765/#home' });
for (let i = 0; i < 40 && !(await evaluate('window.app && window.app.ready')); i++) await sleep(250);
console.log('ready:', await evaluate('app.candidates.length + " candidates"'));
const go = async h => { await evaluate(`location.hash='#${h}'`); await sleep(700); };
const slider = async (i, v) => evaluate(`(()=>{const r=document.querySelectorAll('.controls input[type=range]'); if(!r[${i}]) return 'missing'; r[${i}].value=${v}; r[${i}].dispatchEvent(new Event('input')); return 'ok';})()`);
const sel = async (i, v) => evaluate(`(()=>{const s=document.querySelectorAll('.controls select'); if(!s[${i}]) return 'missing'; s[${i}].value=${JSON.stringify(v)}; s[${i}].dispatchEvent(new Event('change')); return 'ok';})()`);
const tab = async (i) => evaluate(`(()=>{const b=document.querySelectorAll('.tabs button'); if(!b[${i}]) return 'missing'; b[${i}].click(); return b[${i}].textContent;})()`);
const canvasClick = async (i, x, y) => evaluate(`(()=>{const e=document.querySelectorAll('canvas:not(.bg)')[${i}]; if(!e) return 'missing'; const r=e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+${x},clientY:r.top+${y}})); return 'ok';})()`);
const play = async ms => { await evaluate('app.clock.seek(0); app.clock.play()'); await sleep(ms); await evaluate('app.clock.pause()'); };

await go('signal'); await canvasClick(0, 400, 300); await sel(0, '1920'); await play(600); await evaluate('app.clock.setSpeed(0.25)'); await sleep(300); await evaluate('app.clock.setSpeed(1)');
console.log('signal ok; selected:', await evaluate('app.selected && app.selected.label'));

await go('sync');
await slider(0, 0.6); await slider(1, 2.5); console.log('threshold 2.5 →', await evaluate('app.candidates.length + " candidates"')); await slider(1, 1.2); await slider(0, 0.4);
await canvasClick(1, 300, 190); await sel(0, '250'); await play(700);
console.log(' tab', await tab(1)); await play(900); console.log(' tab', await tab(2)); await play(1500); await slider(2, 20); console.log(' tab', await tab(0));
await evaluate(`document.querySelectorAll('table.list tr')[3].click()`);
console.log('sync ok; selected:', await evaluate('app.selected && (app.selected.freq+" Hz")'));

await go('candidate'); await slider(0, 12); await slider(1, 3); await evaluate(`document.querySelectorAll('.controls input[type=checkbox]')[1].click()`); await play(500);
await evaluate(`document.querySelectorAll('table.list tr')[10].click()`); await sleep(300); await slider(0, 0); await slider(1, 0);
console.log('candidate ok; nsync:', await evaluate('app.trace && app.trace.syncQuality.nsync'), 'decoded:', await evaluate('app.trace && app.trace.result && app.trace.result.message.text'));

await go('ldpc');
await sel(1, 'c'); await slider(3, 3); await play(800);
for (let i = 0; i < 6; i++) { console.log(' tab', await tab(i)); await sleep(300); if (i === 3) await evaluate(`document.querySelectorAll('.controls button')[0] && document.querySelectorAll('.controls button')[0].click()`); if (i === 4) { await evaluate(`(()=>{const r=document.querySelectorAll('.panel .controls input[type=range]'); const s=r[r.length-1]; s.value=1; s.dispatchEvent(new Event('input'));})()`); } }
await tab(0); await canvasClick(1, 500, 254); await sleep(200); // click a check node → view D
await evaluate(`document.querySelectorAll('table.list tr')[6].click()`); await sleep(400);
console.log('ldpc ok; view:', await evaluate(`document.querySelector('.tabs button.active').textContent`));

await go('passes'); await sleep(500);
for (let i = 0; i < 60 && !(await evaluate('app.truth.js && app.truth.js.length && !app.worker')); i++) await sleep(500);
console.log('live passes: js decodes', await evaluate('app.truth.js.length'), 'pass inputs', await evaluate('app.jsPassInputs.length'), 'status:', await evaluate(`document.getElementById('loadstatus').textContent`));
console.log(' by pass:', await evaluate('JSON.stringify(app.truth.js.reduce((m,d)=>{m[d.pass]=(m[d.pass]||0)+1;return m},{}))'), 'how:', await evaluate('JSON.stringify(app.truth.js.reduce((m,d)=>{m[d.how]=(m[d.how]||0)+1;return m},{}))'));
console.log(' not in wsjtr list:', await evaluate('JSON.stringify(app.truth.js.filter(d=>!app.truth.wsjtr.some(w=>w.message===d.message)).map(d=>d.message))'));
await tab(0); await sleep(2500); await evaluate(`document.querySelectorAll('.controls button')[2].click()`); await play(400);
console.log('passes ok');

await go('encode'); await sleep(500);
await evaluate(`(()=>{const i=document.querySelector('.controls input[type=text]'); i.value='KC1WIH K1ABC R-08'; i.dispatchEvent(new Event('input'));})()`); await sleep(500);
await slider(1, -18); await sleep(800); await play(600);
console.log('encode ok; tones:', await evaluate(`document.querySelectorAll('.bits span').length`));
await evaluate(`document.querySelectorAll('.controls button')[0].click()`); await sleep(1500); // decode synthetic as loaded window → #sync
console.log('synthetic loaded:', await evaluate('app.name'), 'candidates', await evaluate('app.candidates.length'), 'top', await evaluate('app.candidates[0] && app.candidates[0].freq'));
for (let i = 0; i < 60 && !(await evaluate('app.truth.js && app.truth.js.length && !app.worker')); i++) await sleep(500);
console.log(' js decodes on synthetic:', await evaluate('JSON.stringify(app.truth.js.map(d=>[d.message,d.snr,d.freq,d.dt]))'));
await go('candidate'); await sleep(500); console.log(' stage2 on synthetic:', await evaluate('app.trace && app.trace.result && app.trace.result.message.text'));
await evaluate(`document.getElementById('btn-example').click()`); await sleep(1500); console.log('back to example:', await evaluate('app.name'), await evaluate('app.candidates.length'));
await go('home');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors or exceptions');
ws.close(); chrome.kill();
