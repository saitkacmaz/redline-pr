import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerEvent, SessionInfo, SpecDocument, SpecResponse, SpecView } from '../shared/types.js';

/** The built CLI, exactly what `redline-pr` runs. `npm test` builds first. */
const CLI = join(import.meta.dirname, '..', 'dist', 'bin', 'cli.js');

export interface Running {
  url: string;
  token: string;
  output: () => string;
  stop: () => Promise<void>;
}

export function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

export async function boot(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Running> {
  const child: ChildProcess = spawn(process.execPath, [CLI, '--no-open', ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  let out = '';
  const url = await new Promise<string>((resolve, reject) => {
    const onData = (d: Buffer): void => {
      out += d.toString();
      const m = /ready → (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('close', (code) => reject(new Error(`cli exited ${code}:\n${out}`)));
  });
  const html = await (await fetch(url)).text();
  const token = /name="redline-token" content="([^"]+)"/.exec(html)?.[1] ?? '';
  return {
    url,
    token,
    output: () => out,
    stop: () =>
      new Promise((resolve) => {
        child.removeAllListeners('close');
        child.on('close', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

export const api = async <T>(r: Running, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${r.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-redline-token': r.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(res.ok, `${path} -> ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as T;
};

/** Wait until the server has finished loading (the CLI boots first, then loads in the background). */
export async function settled(r: Running, timeoutMs = 15_000): Promise<SpecResponse> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await api<SpecResponse>(r, '/api/spec');
    if (res.view.status !== 'loading') return res;
    if (Date.now() > until) throw new Error(`still loading after ${timeoutMs}ms:\n${r.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The loaded spec, once ready; fails with the server's message otherwise. */
export async function ready(r: Running): Promise<{ session: SessionInfo; doc: SpecDocument; view: Extract<SpecView, { status: 'ready' }> }> {
  const res = await settled(r);
  assert.equal(res.view.status, 'ready', JSON.stringify(res.view));
  const view = res.view as Extract<SpecView, { status: 'ready' }>;
  return { session: res.session, doc: view.doc, view };
}

/** Collect /api/events for `ms` and return the events. */
export async function events(r: Running, during: () => Promise<unknown>, settleMs = 300): Promise<ServerEvent[]> {
  const ctl = new AbortController();
  const res = await fetch(`${r.url}/api/events`, { headers: { 'x-redline-token': r.token }, signal: ctl.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const out: ServerEvent[] = [];
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const data = buffer.slice(0, end).split('\n').find((l) => l.startsWith('data:'));
          buffer = buffer.slice(end + 2);
          if (data) out.push(JSON.parse(data.slice(5)) as ServerEvent);
        }
      }
    } catch {
      // aborted
    }
  })();
  await during();
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  ctl.abort();
  await pump;
  return out;
}

/** A `gh` that is installed but not logged in, so live runs never touch the network. */
export function fakeGh(binDir: string): void {
  const path = join(binDir, 'gh');
  writeFileSync(path, '#!/bin/sh\necho "not logged in" >&2\nexit 1\n');
  chmodSync(path, 0o755);
}


/**
 * A logged-in `gh` with PR #7 (feat -> main) and one inline review comment, plus PR #8
 * (branch `other`, not checked out) whose diff comes from `gh pr diff`. Passing `currentPr: false`
 * makes `gh pr view` without a number find nothing. POSTs succeed and are appended to `<binDir>/gh-posts.jsonl`.
 */
export function fakeGhWithPr(
  binDir: string,
  opts: { headRefName?: string; headRefOid?: string; postDelayMs?: number; currentPr?: boolean } = {},
): string {
  const posts = join(binDir, 'gh-posts.jsonl');
  const pr7 = { number: 7, title: 'Make add safe', headRefName: opts.headRefName ?? 'feat', baseRefName: 'main', ...(opts.headRefOid ? { headRefOid: opts.headRefOid } : {}) };
  const pr8 = { number: 8, title: 'Tidy util', headRefName: 'other', baseRefName: 'main' };
  const list = [{ ...pr7, author: { login: 'ana' } }, { ...pr8, author: { login: 'bo' } }];
  const diff8 = 'diff --git a/src/util.js b/src/util.js\nindex 1..2 100644\n--- a/src/util.js\n+++ b/src/util.js\n@@ -1 +1,2 @@\n export const id = (x) => x;\n+export const two = 2;\n';
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === 'auth') process.exit(0);
if (a[0] === 'pr' && a[1] === 'view') {
  const n = a[2] && !a[2].startsWith('-') ? Number(a[2]) : null;
  if (n === 8) process.stdout.write(${JSON.stringify(JSON.stringify(pr8))});
  else if (n === 7 || (n === null && ${opts.currentPr !== false})) process.stdout.write(${JSON.stringify(JSON.stringify(pr7))});
  else { process.stderr.write('no pull requests found'); process.exit(1); }
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'list') {
  process.stdout.write(${JSON.stringify(JSON.stringify(list))});
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'diff') {
  process.stdout.write(${JSON.stringify(diff8)});
  process.exit(0);
}
if (a[0] === 'api' && a.includes('POST')) {
  setTimeout(() => {
    fs.appendFileSync(${JSON.stringify(posts)}, JSON.stringify(a) + '\\n');
    process.stdout.write('{}');
    process.exit(0);
  }, ${opts.postDelayMs ?? 0});
  return;
}
if (a[0] === 'api' && a.some((x) => x.endsWith('/pulls/7/comments'))) {
  process.stdout.write(JSON.stringify({ id: 11, user: { login: 'rev', type: 'User' }, body: 'Please rethrow instead.', path: 'src/app.js', line: 4 }) + '\\n');
}
process.exit(0);
`;
  const path = join(binDir, 'gh');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return posts;
}

/** POST and return the raw status and body, for asserting refusals. */
export async function rawPost(r: Running, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(`${r.url}${path}`, {
    method: 'POST',
    headers: { 'x-redline-token': r.token, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}
