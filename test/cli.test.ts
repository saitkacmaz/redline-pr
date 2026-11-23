import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrListResponse, SyncResult } from '../shared/types.js';
import { api, boot, events, fakeGh, fakeGhWithPr, rawPost, ready, runCli, settled } from './cli-harness.js';
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
    const spec = await ready(r);
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
    const { doc, view } = await ready(r);
    assert.equal(doc.sections[0]?.clauses[0]?.anchors[0]?.hunk.startsWith('@@'), true, 'anchor got a real hunk');
    assert.equal(view.canPostReplies, false);
    assert.equal(view.runBlocked, undefined);

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
    assert.equal(result.claude?.sessionId, 'fake-session-1', 'the run names its Claude Code session');
    assert.match(readFileSync(join(cache, 'redline-pr', readdirSync(join(cache, 'redline-pr'))[0]!, 'last-run.md'), 'utf8'), new RegExp(`cd ${repo} && claude --resume fake-session-1`));
    const syncCall = readCalls(logFile).at(-1)!;
    assert.equal(syncCall.cwd, repo);
    assert.match(syncCall.input, /REQUIRED behavior: If adding throws, `add` rethrows the error\./);
    assert.deepEqual(changedPaths(before, snapshot(repo)), ['src/app.js'], 'Sync changes only what claude edited');

    const again = await rawPost(r, '/api/sync', { doc, mode: 'run' });
    assert.equal(again.status, 409, 'the same edits are never applied twice');
    doc.sections[0]!.clauses[0]!.currentText = 'If adding throws, `add` logs and rethrows.';
    const more = await rawPost(r, '/api/sync', { doc, mode: 'run' });
    assert.equal(more.status, 409, 'nor is any later run against the now-stale spec');
    assert.match(more.body, /Re-analyze/);
    assert.equal((await ready(r)).view.result?.ok, true, 'a reloaded page knows a run happened');
    assert.equal(readCalls(logFile).filter((c) => !c.args.includes('--json-schema')).length, 1);

    // Re-analyze: the changed code gets a fresh spec (a new id), and that one can be run again.
    await api(r, '/api/load', { target: { kind: 'current' } });
    const fresh = await ready(r);
    assert.notEqual(fresh.doc.id, doc.id);
    assert.equal(fresh.view.result, undefined);
    assert.equal(readCalls(logFile).filter((c) => c.args.includes('--json-schema')).length, 2, 'the changed diff is read again');
    const stale = await rawPost(r, '/api/plan', { doc });
    assert.equal(stale.status, 409, 'edits made against the old spec are refused');
    fresh.doc.sections[0]!.clauses[0]!.currentText = 'If adding throws, `add` logs and rethrows.';
    assert.equal((await api<SyncResult>(r, '/api/sync', { doc: fresh.doc, mode: 'run' })).ok, true);
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
    await ready(r);
    outputs.push(r.output());
    await r.stop();
  }
  assert.match(outputs[0]!, /Drafting behavioral spec/);
  const url = (o: string): string | undefined => /ready → (\S+)/.exec(o)?.[1];
  assert.equal(url(outputs[0]!), url(outputs[1]!), 'same repo, same origin, so browser drafts survive a restart');
  assert.doesNotMatch(outputs[1]!, /Drafting behavioral spec/, 'a cache hit does not claim to call claude');
  assert.equal(readCalls(logFile).filter((c) => c.args.includes('--json-schema')).length, 1);
});

test('a failing claude -p shows its message in the page and writes nothing to the repo', async () => {
  const repo = makeRepo();
  const { binDir } = fakeClaude(SPEC, { failSpec: JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }) });
  fakeGh(binDir);
  const before = snapshot(repo);
  const r = await boot([], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { view } = await settled(r);
    assert.equal(view.status, 'error');
    assert.match(view.status === 'error' ? view.message : '', /Not logged in.*log in/s);
    assert.match(r.output(), /Not logged in/, 'the terminal says so too');
  } finally {
    await r.stop();
  }
  assert.deepEqual(changedPaths(before, snapshot(repo)), []);
});

test('replies post only on request, only what the user wrote, and never twice', async () => {
  const repo = makeRepo();
  const { binDir } = fakeClaude({ ...SPEC, commentMap: [{ commentId: 'rc-11', clauseId: 's1-c1' }] });
  const posts = fakeGhWithPr(binDir);
  const r = await boot([], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { doc, view } = await ready(r);
    assert.equal(view.canPostReplies, true);
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

test('a PR that is not checked out is read from gh pr diff, and Run is refused', async () => {
  const repo = makeRepo();
  const { binDir, logFile } = fakeClaude(SPEC);
  fakeGhWithPr(binDir);
  const before = snapshot(repo);
  const r = await boot(['8'], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { doc, view } = await ready(r);
    assert.equal(doc.prNumber, 8);
    assert.equal(doc.branch, 'other');
    assert.match(view.runBlocked ?? '', /PR #8 isn’t checked out.*gh pr checkout 8/);
    const spec = readCalls(logFile).find((c) => c.args.includes('--json-schema'))!;
    assert.match(spec.input, /\+export const two = 2;/, 'the diff came from GitHub');
    assert.match(spec.input, /has feat checked out, not this PR's branch \(other\)/, 'Claude is told the files on disk differ');

    doc.sections[0]!.clauses[0]!.currentText = 'Something else.';
    const run = await rawPost(r, '/api/sync', { doc, mode: 'run' });
    assert.equal(run.status, 409);
    assert.match(run.body, /gh pr checkout 8/);
    assert.equal(readCalls(logFile).filter((c) => !c.args.includes('--json-schema')).length, 0, 'claude never ran to edit');
  } finally {
    await r.stop();
  }
  assert.deepEqual(changedPaths(before, snapshot(repo)), [], 'nothing was fetched or checked out');
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
  const r = await boot(['--base', 'main'], { cwd: clone, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { view } = await settled(r);
    assert.match(view.status === 'error' ? view.message : '', /shallow clone.*git fetch --unshallow/);
  } finally {
    await r.stop();
  }
});

test('two tabs posting the same reply at once post it once', async () => {
  const repo = makeRepo();
  const { binDir } = fakeClaude({ ...SPEC, commentMap: [{ commentId: 'rc-11', clauseId: 's1-c1' }] });
  const posts = fakeGhWithPr(binDir, { postDelayMs: 400 });
  const r = await boot([], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { doc } = await ready(r);
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

test('a PR already merged into the base is not this checkout; a renamed checkout of the PR head is', async () => {
  const repo = makeRepo();
  const mainSha = git(repo, 'rev-parse', 'main').trim();
  const headSha = git(repo, 'rev-parse', 'HEAD').trim();
  const env = (binDir: string) => ({ XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` });

  const old = fakeClaude(SPEC);
  fakeGhWithPr(old.binDir, { headRefName: 'old-feature', headRefOid: mainSha });
  const merged = await boot(['--pr', '7'], { cwd: repo, env: env(old.binDir) });
  try {
    assert.match((await ready(merged)).view.runBlocked ?? '', /PR #7 isn’t checked out/);
  } finally {
    await merged.stop();
  }

  const renamed = fakeClaude(SPEC);
  fakeGhWithPr(renamed.binDir, { headRefName: 'someone/feat', headRefOid: headSha });
  const r = await boot(['--pr', '7'], { cwd: repo, env: env(renamed.binDir) });
  try {
    assert.equal((await ready(r)).view.runBlocked, undefined);
  } finally {
    await r.stop();
  }
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
    const { doc } = await ready(r);
    assert.equal((await rawPost(r, '/api/plan', { doc }, { origin: 'http://[::1]:5173' })).status, 200);
  } finally {
    await r.stop();
  }
});

test('a positional number is the PR; two different PR numbers, or a stray word, are refused', async () => {
  const repo = makeRepo();
  const { binDir } = fakeClaude(SPEC);
  fakeGhWithPr(binDir, { currentPr: false });
  const env = { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` };
  const r = await boot(['7'], { cwd: repo, env });
  try {
    assert.equal((await ready(r)).doc.prNumber, 7, '`redline 7` loads PR #7 even though the branch lookup finds none');
  } finally {
    await r.stop();
  }
  const both = await runCli(['7', '--pr', '8'], { cwd: repo, env });
  assert.equal(both.code, 1);
  assert.match(both.out, /Both --pr 8 and 7/);
  const word = await runCli(['seven'], { cwd: repo, env });
  assert.equal(word.code, 1);
  assert.match(word.out, /Unknown argument "seven"/);
});

test('no PR and no local changes: the page still boots, says so, and lists PRs to switch to', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', 'main');
  const { binDir, logFile } = fakeClaude(SPEC);
  fakeGhWithPr(binDir, { currentPr: false });
  const before = snapshot(repo);
  const r = await boot([], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { view, session } = await settled(r);
    assert.equal(view.status, 'empty');
    assert.match(view.status === 'empty' ? view.message : '', /No changes on main against main/);
    assert.equal(session.branch, 'main');
    assert.equal(readCalls(logFile).length, 0, 'nothing to send to claude');

    const prs = await api<PrListResponse>(r, '/api/prs');
    assert.deepEqual(prs.prs.map((p) => [p.number, p.author, p.checkedOut]), [[7, 'ana', false], [8, 'bo', false]]);

    // Switch in place, then back to the local diff, without restarting.
    await api(r, '/api/load', { target: { kind: 'pr', number: 7 } });
    assert.equal((await ready(r)).doc.prNumber, 7);
    assert.deepEqual((await api<PrListResponse>(r, '/api/prs')).current, { kind: 'pr', number: 7 });
    await api(r, '/api/load', { target: { kind: 'local' } });
    assert.equal((await settled(r)).view.status, 'empty');
  } finally {
    await r.stop();
  }
  assert.deepEqual(changedPaths(before, snapshot(repo)), []);
});

test('/api/events streams the real steps of a load and a run', async () => {
  const repo = makeRepo();
  const { binDir } = fakeClaude(SPEC, { syncDelayMs: 300 });
  fakeGh(binDir);
  const r = await boot([], { cwd: repo, env: { XDG_CACHE_HOME: tempDir('cache'), PATH: `${binDir}:${process.env.PATH ?? ''}` } });
  try {
    const { doc } = await ready(r);
    const loadSteps = (await events(r, () => api(r, '/api/load', { target: { kind: 'current' } })))
      .flatMap((e) => (e.type === 'activity' ? [`${e.activity.state}:${e.activity.step}`] : []));
    assert.ok(loadSteps.includes('running:Reading the diff of feat against main'), loadSteps.join('\n'));
    assert.ok(loadSteps.at(-1)?.startsWith('done:Ready'), loadSteps.join('\n'));

    const { doc: current } = await ready(r);
    assert.notEqual(current.id, doc.id);
    current.sections[0]!.clauses[0]!.currentText = 'If adding throws, `add` rethrows the error.';
    let blocked = 0;
    const runEvents = await events(r, async () => {
      const run = api<SyncResult>(r, '/api/sync', { doc: current, mode: 'run' });
      await new Promise((res) => setTimeout(res, 150));
      blocked = (await rawPost(r, '/api/load', { target: { kind: 'current' } })).status;
      return run;
    });
    assert.equal(blocked, 409, 'reloading waits for Claude Code to finish editing');
    const steps = runEvents.flatMap((e) => (e.type === 'activity' && e.activity.kind === 'sync' ? [`${e.activity.state}:${e.activity.step}`] : []));
    assert.deepEqual(steps, ['running:Starting Claude Code', 'running:Editing src/app.js', 'done:Synced — 1 file modified in 1s']);
    assert.ok(runEvents.some((e) => e.type === 'log' && e.line.endsWith('Change 1: edited src/app.js')), 'Claude’s notes are in the log');
  } finally {
    await r.stop();
  }
});
