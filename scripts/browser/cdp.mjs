// Minimal Chrome DevTools Protocol driver (Node built-in WebSocket + fetch).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, profile, width = 1500, height = 1300 }) {
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const page = {
    logs,
    send,
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(500);
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expression, timeout = 15000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await page.eval(expression).catch(() => false)) return true;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${expression}`);
    },
    async key(key, { shift = false } = {}) {
      const codes = { ' ': ['Space', 32], n: ['KeyN', 78], p: ['KeyP', 80], k: ['KeyK', 75], j: ['KeyJ', 74], l: ['KeyL', 76], ArrowRight: ['ArrowRight', 39], ArrowLeft: ['ArrowLeft', 37], Home: ['Home', 36] };
      const [code, keyCode] =
        codes[key] ??
        (/^[a-z]$/.test(key) ? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)] : /^[0-9]$/.test(key) ? [`Digit${key}`, key.charCodeAt(0)] : [key, 0]);
      const base = { key, code, windowsVirtualKeyCode: keyCode, modifiers: shift ? 8 : 0 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key === ' ' ? ' ' : undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
    },
    async screenshot(path, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
    },
    close() {
      ws.close();
      proc.kill();
    },
  };
  return page;
}

export { sleep };
