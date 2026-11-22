import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpecResponse, SyncResult } from '../shared/types.js';
import { api, boot, fakeGh, fakeGhWithPr, rawPost, runCli } from './cli-harness.js';
import { request } from 'node:http';
import type { PostedReply } from '../shared/types.js';
import { changedPaths, fakeClaude, git, makeRepo, readCalls, snapshot, tempDir } from './helpers.js';

const SPEC = {
  sections: [
    {
      title: 'Addition',
      clauses: [{ id: 's1-c1', text: 'If adding throws, `add` returns 0 and reports nothing.', anchors: [{ file: 'src/app.js', startLine: 4, endLine: 5 }], riskFlag: 'silent error swallow' }],
    },
  ],
  commentMap: [],
};

test('--help prints usage and exits 0', async () => {
  const { code, out } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(out, /Usage/);
  assert.match(out, /--dry-run/);
});

test('rejects a non-numeric --pr and unknown flags', async () => {
  const bad = await runCli(['--pr', 'abc']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /--pr expects a whole number/);
  const unknown = await runCli(['--nope']);
  assert.equal(unknown.code, 1);
  const trailing = await runCli(['--pr', '1abc']);
  assert.equal(trailing.code, 1, '1abc is not PR 1');
  assert.match(trailing.out, /whole number/);
  const port = await runCli(['--demo', '--port', '70000']);
  assert.match(port.out, /at most 65535/);
});

test('outside a git repo it explains and exits 1', async () => {
  const { code, out } = await runCli([], { cwd: tempDir('norepo') });
  assert.equal(code, 1);
  assert.match(out, /Not inside a git repository/);
});

test('--demo boots and guards the API with the page token', async () => {
  const cache = tempDir('cache');
  const r = await boot(['--demo'], { cwd: tempDir('demo'), env: { XDG_CACHE_HOME: cache } });
  try {
    assert.ok(r.token.length >= 32);
    assert.equal((await fetch(`${r.url}/api/spec`)).status, 403);
    const spec = await api<SpecResponse>(r, '/api/spec');
    assert.equal(spec.session.demo, true);
    assert.ok(spec.doc.sections.length > 0);
  } finally {
    await r.stop();
  }
});

test('live run: read-only until Sync, then only the code edit lands in the repo', async () => {
  const repo = makeRepo();
  const cache = tempDir('cache');
  const { binDir, logFile } = fakeClaude(SPEC);
  fakeGh(binDir);
  const env = { XDG_CACHE_HOME: cache, PATH: `${binDir}:${process.env.PATH ?? ''}` };

  // An editor's atomic save of a file the branch did not change: same content, new inode and
  // mtime. Its index stat data is now stale, so porcelain `git diff` would refresh and rewrite
  // .git/index (GIT_OPTIONAL_LOCKS=0 does not prevent that).
  const untouched = join(repo, 'src/util.js');
  const content = readFileSync(untouched);
  await new Promise((r) => setTimeout(r, 1100));
  rmSync(untouched);
  writeFileSync(untouched, content);

  const before = snapshot(repo);
  const r = await boot([], { cwd: repo, env });
  try {
    const { doc, session } = await api<SpecResponse>(r, '/api/spec');
    assert.equal(doc.sections[0]?.clauses[0]?.anchors[0]?.hunk.startsWith('@@'), true, 'anchor got a real hunk');
    assert.equal(session.canPostReplies, false);

    // The spec call: diff over stdin, repo readable with read-only tools only,
    // none of the repo's Claude config (hooks can write files), no session saved, never --bare.
    const [specCall] = readCalls(logFile);
    assert.ok(specCall);
    const after = (flag: string) => specCall.args[specCall.args.indexOf(flag) + 1];
    // Not in the repo: Claude Code runs `git status` in its cwd, which can write .git/index.
    assert.ok(!specCall.cwd.startsWith(repo), 'spec call must not start inside the repo');
    assert.equal(after('--add-dir'), repo, 'the repo is readable via --add-dir');
    assert.ok(specCall.input.includes(`Repository: ${repo}\n`), "the prompt names the repo path");
    assert.equal(after('--tools'), 'Read,Grep,Glob', 'read-only tools; no Bash, Edit, or Write');
    assert.equal(after('--allowedTools'), 'Read,Grep,Glob');
    assert.equal(after('--setting-sources'), '');
    assert.match(after('--settings') ?? '', /"disableAllHooks":true/);
    for (const flag of ['-p', '--output-format', '--json-schema', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) {
      assert.ok(specCall.args.includes(flag), flag);
    }
    assert.ok(!specCall.args.includes('--bare'));
    assert.match(specCall.input, /=== FILE: src\/app.js/);

    const clause = doc.sections[0]!.clauses[0]!;
    clause.currentText = 'If adding throws, `add` rethrows the error.';
    await api(r, '/api/plan', { doc });
    const exported = await api<SyncResult>(r, '/api/sync', { doc, mode: 'export' });
    assert.ok(exported.writtenFile?.startsWith(cache), 'export lands in the cache dir');

    assert.deepEqual(changedPaths(before, snapshot(repo)), [], 'nothing in the repo (incl. .git) changes before Sync runs');

    const result = await api<SyncResult>(r, '/api/sync', { doc, mode: 'run' });
    assert.equal(result.claude?.exitCode, 0);
    assert.equal(result.ok, true);
    assert.deepEqual(result.changes?.files, ['src/app.js'], 'the result reports exactly what claude changed');
    assert.match(result.changes?.diff ?? '', /^\+\/\/ edited by fake claude$/m);
    const syncCall = readCalls(logFile).at(-1)!;
    assert.equal(syncCall.cwd, repo);
    assert.match(syncCall.input, /REQUIRED behavior: If adding throws, `add` rethrows the error\./);
    assert.deepEqual(changedPaths(before, snapshot(repo)), ['src/app.js'], 'Sync changes only what claude edited');

    const again = await rawPost(r, '/api/sync', { doc, mode: 'run' });
    assert.equal(again.status, 409, 'the same edits are never applied twice');
    doc.sections[0]!.clauses[0]!.currentText = 'If adding throws, `add` logs and rethrows.';
    const more = await rawPost(r, '/api/sync', { doc, mode: 'run' });
    assert.equal(more.status, 409, 'nor is any later run against the now-stale spec');
    assert.equal((await api<SpecResponse>(r, '/api/spec')).session.applied, true, 'a reloaded page knows a run happened');
    assert.equal(readCalls(logFile).filter((c) => !c.args.includes('--json-schema')).length, 1);
  } finally {
    await r.stop();
  }
  assert.ok(existsSync(cache));
});

test('a cached spec is reused without calling claude again', async () => {
  const repo = makeRepo();
  const cache = tempDir('cache');
  const { binDir, logFile } = fakeClaude(SPEC);
  fakeGh(binDir);
  const env = { XDG_CACHE_HOME: cache, PATH: `${binDir}:${process.env.PATH ?? ''}` };
  const outputs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await boot([], { cwd: repo, env });
    outputs.push(r.output());
    await r.stop();
  }
  assert.match(outputs[0]!, /writing behavioral spec/);
  const url = (o: string): string | undefined => /ready → (\S+)/.exec(o)?.[1];
  assert.equal(url(outputs[0]!), url(outputs[1]!), 'same repo, same origin, so browser drafts survive a restart');
  assert.doesNotMatch(outputs[1]!, /writing behavioral spec/, 'a cache hit does not claim to call claude');
  assert.equal(readCalls(logFile).filter((c) => c.args.includes('--json-schema')).length, 1);
});

test('a failing claude -p exits 1 with its message and writes nothing to the repo', async () => {
  const repo = makeRepo();
  const { binDir } = fakeClaude(SPEC, { failSpec: JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }) });
  fakeGh(binDir);
  const before = snapshot(repo);
  const { code, out } = await runCli(['--no-open'], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  assert.equal(code, 1);
  assert.match(out, /Not logged in/);
  assert.match(out, /log in/);
  assert.deepEqual(changedPaths(before, snapshot(repo)), []);
});

test('replies post only on request, only what the user wrote, and never twice', async () => {
  const repo = makeRepo();
  const { binDir } = fakeClaude({ ...SPEC, commentMap: [{ commentId: 'rc-11', clauseId: 's1-c1' }] });
  const posts = fakeGhWithPr(binDir);
  const r = await boot([], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { doc, session } = await api<SpecResponse>(r, '/api/spec');
    assert.equal(session.canPostReplies, true);
    assert.equal(doc.comments[0]?.clauseId, 's1-c1');

    // Editing a sentence and running drafts and posts nothing.
    doc.sections[0]!.clauses[0]!.currentText = 'If adding throws, `add` rethrows the error.';
    await api<SyncResult>(r, '/api/sync', { doc, mode: 'run' });
    assert.equal(readCalls(join(binDir, 'calls.jsonl')).length, 2);
    assert.equal(existsSync(posts), false, 'running Claude Code posts nothing');

    doc.comments[0]!.replyDraft = 'Done, it rethrows now.';
    doc.comments[0]!.body = 'forged';
    const first = await api<PostedReply[]>(r, '/api/replies', { doc, commentIds: ['rc-11'] });
    assert.deepEqual(first, [{ commentId: 'rc-11', ok: true }]);
    const second = await api<PostedReply[]>(r, '/api/replies', { doc, commentIds: ['rc-11'] });
    assert.deepEqual(second, [{ commentId: 'rc-11', ok: true }]);

    const lines = readFileSync(posts, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'an identical reply is posted once');
    assert.match(lines[0]!, /pulls\/7\/comments\/11\/replies/);
    assert.match(lines[0]!, /body=Done, it rethrows now\./);
  } finally {
    await r.stop();
  }
});

test('requests for a non-loopback Host are refused (DNS rebinding)', async () => {
  const r = await boot(['--demo'], { cwd: tempDir('demo'), env: { XDG_CACHE_HOME: tempDir('cache') } });
  try {
    const port = new URL(r.url).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    const cross = await rawPost(r, '/api/plan', { doc: {} }, { origin: 'http://evil.example' });
    assert.equal(cross.status, 403);
    assert.equal((await fetch(r.url.replace('127.0.0.1', 'localhost'))).status, 200);
  } finally {
    await r.stop();
  }
});

test('a port in use gets a one-line explanation, not a stack trace', async () => {
  const first = await boot(['--demo'], { cwd: tempDir('demo'), env: { XDG_CACHE_HOME: tempDir('cache') } });
  try {
    const port = new URL(first.url).port;
    const { code, out } = await runCli(['--demo', '--no-open', '--port', port], { cwd: tempDir('demo'), env: { XDG_CACHE_HOME: tempDir('cache') } });
    assert.equal(code, 1);
    assert.match(out, new RegExp(`port ${port} is already in use`));
    assert.doesNotMatch(out, /\n\s+at /);
  } finally {
    await first.stop();
  }
});

test('--pr for a different branch is refused before anything is loaded', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-qb', 'unrelated');
  const { binDir, logFile } = fakeClaude(SPEC);
  fakeGhWithPr(binDir);
  const { code, out } = await runCli(['--pr', '7', '--no-open'], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  assert.equal(code, 1);
  assert.match(out, /PR #7 is for branch feat, but unrelated is checked out/);
  assert.equal(readCalls(logFile).length, 0, 'no spec is generated');
});

test('a shallow clone explains how to fetch the missing history', async () => {
  const origin = makeRepo();
  git(origin, 'checkout', '-q', 'main');
  for (let i = 0; i < 3; i++) git(origin, 'commit', '-q', '--allow-empty', '-m', `main ${i}`);
  git(origin, 'checkout', '-q', 'feat');
  const clone = tempDir('shallow');
  git(clone, 'clone', '-q', '--depth', '1', '--no-single-branch', `file://${origin}`, '.');
  git(clone, 'checkout', '-q', 'feat');
  const { binDir } = fakeClaude(SPEC);
  fakeGh(binDir);
  const { code, out } = await runCli(['--base', 'main', '--no-open'], { cwd: clone, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  assert.equal(code, 1);
  assert.match(out, /shallow clone.*git fetch --unshallow/);
});

test('two tabs posting the same reply at once post it once', async () => {
  const repo = makeRepo();
  const { binDir } = fakeClaude({ ...SPEC, commentMap: [{ commentId: 'rc-11', clauseId: 's1-c1' }] });
  const posts = fakeGhWithPr(binDir, { postDelayMs: 400 });
  const r = await boot([], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { doc } = await api<SpecResponse>(r, '/api/spec');
    doc.comments[0]!.replyDraft = 'On it.';
    await Promise.all([
      api<PostedReply[]>(r, '/api/replies', { doc, commentIds: ['rc-11'] }),
      api<PostedReply[]>(r, '/api/replies', { doc, commentIds: ['rc-11'] }),
    ]);
    assert.equal(readFileSync(posts, 'utf8').trim().split('\n').length, 1);
  } finally {
    await r.stop();
  }
});

test('--pr for a PR already merged into the base is refused; a renamed checkout of the PR head is not', async () => {
  const repo = makeRepo();
  const mainSha = git(repo, 'rev-parse', 'main').trim();
  const headSha = git(repo, 'rev-parse', 'HEAD').trim();
  const env = (binDir: string) => ({ XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` });

  const old = fakeClaude(SPEC);
  fakeGhWithPr(old.binDir, { headRefName: 'old-feature', headRefOid: mainSha });
  const refused = await runCli(['--pr', '7', '--no-open'], { cwd: repo, env: env(old.binDir) });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /PR #7 is for branch old-feature/);

  const renamed = fakeClaude(SPEC);
  fakeGhWithPr(renamed.binDir, { headRefName: 'someone/feat', headRefOid: headSha });
  const r = await boot(['--pr', '7'], { cwd: repo, env: env(renamed.binDir) });
  await r.stop();
});

test('Ctrl-C while the spec is being written stops claude too', async () => {
  const repo = makeRepo();
  const binDir = tempDir('bin');
  const pidFile = join(binDir, 'pid');
  writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 60\n`);
  chmodSync(join(binDir, 'claude'), 0o755);
  fakeGh(binDir);
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'dist', 'bin', 'cli.js'), '--no-open'], {
    cwd: repo,
    env: { ...process.env, XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const exited = new Promise((r) => child.on('close', r));
  child.kill('SIGINT');
  await exited;
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), 'claude is no longer running');
});

test('POSTs from an IPv6 loopback origin are allowed', async () => {
  const r = await boot(['--demo'], { cwd: tempDir('demo'), env: { XDG_CACHE_HOME: tempDir('cache') } });
  try {
    const { doc } = await api<SpecResponse>(r, '/api/spec');
    assert.equal((await rawPost(r, '/api/plan', { doc }, { origin: 'http://[::1]:5173' })).status, 200);
  } finally {
    await r.stop();
  }
});
