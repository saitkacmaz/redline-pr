import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tempDir } from './helpers.js';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** A local Chrome/Chromium binary, or undefined (browser tests then skip). */
export const chromePath = CANDIDATES.find((p): p is string => !!p && existsSync(p));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface CdpResponse {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
  error?: { message: string };
  method?: string;
  params?: { exceptionDetails?: { exception?: { description?: string }; text?: string }; type?: string; args?: { value?: unknown; description?: string }[] };
}

/** Minimal Chrome DevTools Protocol driver: enough to click, type, press keys, and read the DOM. */
export class Browser {
  private nextId = 0;
  private pending = new Map<number, (r: CdpResponse) => void>();
  /** Uncaught exceptions and console.error calls seen on the page. */
  readonly errors: string[] = [];

  private constructor(
    private readonly chrome: ChildProcess,
    private readonly ws: WebSocket,
  ) {
    ws.onmessage = (m: MessageEvent<string>) => {
      const d = JSON.parse(m.data) as CdpResponse;
      if (d.id !== undefined) {
        this.pending.get(d.id)?.(d);
        this.pending.delete(d.id);
      } else if (d.method === 'Runtime.exceptionThrown') {
        const ex = d.params?.exceptionDetails;
        this.errors.push(ex?.exception?.description ?? ex?.text ?? 'exception');
      } else if (d.method === 'Runtime.consoleAPICalled' && d.params?.type === 'error') {
        this.errors.push((d.params.args ?? []).map((a) => String(a.value ?? a.description)).join(' '));
      }
    };
  }

  static async launch(): Promise<Browser> {
    if (!chromePath) throw new Error('no Chrome found');
    const port = await freePort();
    const chrome = spawn(
      chromePath,
      ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${tempDir('chrome')}`, `--remote-debugging-port=${port}`, '--window-size=1400,1000', 'about:blank'],
      { stdio: 'ignore' },
    );
    let target: { type: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 100 && !target; i++) {
      await sleep(100);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        target = list.find((t) => t.type === 'page');
      } catch {
        // Chrome is still starting.
      }
    }
    if (!target) throw new Error('Chrome did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const browser = new Browser(chrome, ws);
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    return browser;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval<T>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(`eval failed: ${expression}\n${JSON.stringify(res.result.exceptionDetails)}`);
    return res.result?.result?.value as T;
  }

  /** Poll until the expression is truthy. */
  async waitFor(expression: string, timeoutMs = 5000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.eval<boolean>(`!!(${expression})`)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for: ${expression}`);
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.waitFor(`document.readyState === 'complete'`);
  }

  async click(x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await sleep(50);
  }

  /** Click the center of the first element matching a JS expression that returns an Element. */
  async clickEl(elementExpr: string): Promise<void> {
    const r = await this.eval<{ x: number; y: number }>(
      `(() => { const el = ${elementExpr}; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 40), y: b.top + Math.min(b.height / 2, 10) }; })()`,
    );
    await this.click(r.x, r.y);
  }

  async key(key: 'Enter' | 'Escape' | 'Tab', modifiers = 0): Promise<void> {
    const code = { Enter: 13, Escape: 27, Tab: 9 }[key];
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers });
    await sleep(50);
  }

  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
    await sleep(30);
  }

  async screenshot(): Promise<Buffer> {
    const r = (await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })) as { result?: { data?: string } };
    return Buffer.from(r.result?.data ?? '', 'base64');
  }

  async close(): Promise<void> {
    this.ws.close();
    this.chrome.kill();
    await sleep(50);
  }
}
