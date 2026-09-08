// Screenshot a stage after running some JS in the page. Usage: node tools/cdp_shot.mjs <hash> <out.png> [js-expression]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [hash, out, js] = process.argv.slice(2);
const port = 9334;
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, '--window-size=1500,1100', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') console.log('EXC', m.params.exceptionDetails.exception?.description); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) console.log('EVAL ERROR', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://localhost:8765/#${hash}` });
for (let i = 0; i < 60 && !(await evaluate('window.app && window.app.ready')); i++) await sleep(250);
await sleep(800);
if (js) { console.log('eval →', await evaluate(js)); await sleep(800); }
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('wrote', out);
ws.close(); chrome.kill();
