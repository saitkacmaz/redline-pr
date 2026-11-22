import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  assert.equal(res.status, 200, `${path} -> ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as T;
};

/** A `gh` that is installed but not logged in, so live runs never touch the network. */
export function fakeGh(binDir: string): void {
  const path = join(binDir, 'gh');
  writeFileSync(path, '#!/bin/sh\necho "not logged in" >&2\nexit 1\n');
  chmodSync(path, 0o755);
}


/**
 * A logged-in `gh` with PR #7 (feat -> main) and one inline review comment.
 * POSTs succeed and are appended to `<binDir>/gh-posts.jsonl`.
 */
export function fakeGhWithPr(binDir: string, opts: { headRefName?: string; headRefOid?: string; postDelayMs?: number } = {}): string {
  const posts = join(binDir, 'gh-posts.jsonl');
  const pr = { number: 7, title: 'Make add safe', headRefName: opts.headRefName ?? 'feat', baseRefName: 'main', ...(opts.headRefOid ? { headRefOid: opts.headRefOid } : {}) };
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === 'auth') process.exit(0);
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(${JSON.stringify(JSON.stringify(pr))});
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
