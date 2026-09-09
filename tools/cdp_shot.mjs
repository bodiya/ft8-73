// Screenshot a stage after running some JS in the page.
// Usage: node tools/cdp_shot.mjs <hash> <out.png> [js-expression] [--viewport=390x844[@2]] [--full]
// --viewport puts Chrome in a phone viewport with touch (DPR defaults to 2, which is what the app's
// canvases actually draw at: DPR_CAP in src/ui/controls.js). --full captures the whole page, not just
// the top viewport-worth of it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Flags are pulled out first so they cannot be mistaken for the [hash, out, js] positionals. A JS
// expression that legitimately starts with '--' (a prefix decrement) has to be written as `void 0, --i`.
const args = process.argv.slice(2);
const V = (m => m && { w: +m[1], h: +m[2], dpr: +(m[3] || 2) })(/^--viewport=(\d+)x(\d+)(?:@([\d.]+))?$/.exec(args.find(a => a.startsWith('--viewport=')) || ''));
const FULL = args.includes('--full');
const [hash, out, js] = args.filter(a => !a.startsWith('--'));
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Own port and own profile per mode, so a desktop shot and a phone shot can be taken at the same time.
const port = +(process.env.CDP_PORT || 0) || 9334 + (V ? 10 : 0);
// One profile per port, wiped before Chrome starts rather than after it dies: a run must not
// inherit the last run's localStorage (app.js remembers the tab per page), and deleting it
// afterwards races with Chrome still writing to it.
const profile = path.join(os.tmpdir(), `ft8-cdp-shot-${port}`);
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, V ? `--window-size=${V.w},${V.h}` : '--window-size=1500,1100', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws = null;
try {   // a throw anywhere below must still kill Chrome, or it keeps the port and the next run attaches to a stale target
await sleep(1500);
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') console.log('EXC', m.params.exceptionDetails.exception?.description); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) console.log('EVAL ERROR', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
// Before the navigate: nothing in src/ui re-lays-out a page it mounted at the wrong width.
if (V) {
  await send('Emulation.setDeviceMetricsOverride', { width: V.w, height: V.h, deviceScaleFactor: V.dpr, mobile: true,
    screenOrientation: V.w > V.h ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });   // mobile:true alone leaves maxTouchPoints 0
  await send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, acceptLanguage: 'en-US', platform: 'iPhone' });
}
await send('Page.navigate', { url: `http://localhost:8765/#${hash}` });
for (let i = 0; i < 60 && !(await evaluate('window.app && window.app.ready')); i++) await sleep(250);
await sleep(800);
if (js) { console.log('eval →', await evaluate(js)); await sleep(800); }
const m = JSON.parse(await evaluate(`JSON.stringify({w:document.documentElement.clientWidth,h:document.documentElement.clientHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,dpr:devicePixelRatio,back:Math.min(devicePixelRatio||1,2)})`));
if (V) console.log(`viewport ${m.w}x${m.h}, content ${m.sw}x${m.sh}` + (m.sw > m.w + 2 ? '  <- overflows' : '') + `, dpr ${m.dpr} (canvas backing ${m.back})`);
// An explicit clip: under a device-metrics override an unclipped capture returns only the top
// viewport of a much taller page, and any scrolling the evaluated JS did silently offsets the shot.
// --full also widens to the content, so anything hanging off the side of the phone is in the shot;
// without it the clip is exactly the phone screen.
const shot = await send('Page.captureScreenshot', FULL || V
  ? { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: FULL ? Math.max(m.w, m.sw) : m.w, height: FULL ? Math.min(m.sh, 8000) : m.h, scale: 1 } }
  : { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('wrote', out);
} finally {
  if (ws) ws.close();
  chrome.kill();
}
