import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPullRequest, githubAccess, listPullRequests, NotOnGitHubError, triageThreads, type ReviewThread } from '../server/github.js';
import { git, makeRepo, tempDir } from './helpers.js';

let nextId = 100;
const msg = (login: string, body: string, bot = false) => ({
  databaseId: nextId++,
  author: { login, __typename: bot ? 'Bot' : 'User' },
  body,
  createdAt: '2026-11-20T10:00:00Z',
});

/** A thread as GraphQL returns it: the opening comment, and the last (up to 20) comments. */
function thread(over: Partial<ReviewThread>, messages: ReturnType<typeof msg>[], total = messages.length): ReviewThread {
  return {
    id: `T${nextId++}`,
    isResolved: false,
    isOutdated: false,
    path: 'src/app.js',
    line: 12,
    originalLine: 10,
    diffSide: 'RIGHT',
    opening: { nodes: messages.slice(0, 1) },
    recent: { totalCount: total, nodes: messages.slice(-20) },
    ...over,
  };
}

test('resolved and outdated threads are hidden, counted, and never become margin comments', () => {
  const open = thread({}, [msg('rev', 'Please rethrow.')]);
  const resolved = thread({ isResolved: true }, [msg('rev', 'Typo here.'), msg('me', 'Fixed.')]);
  const outdated = thread({ isOutdated: true, line: null }, [msg('rev', 'Old line, old concern.')]);
  const { comments, hidden } = triageThreads([open, resolved, outdated], 'me');
  assert.deepEqual(comments.map((c) => c.body), ['Please rethrow.']);
  assert.deepEqual(hidden.map((h) => [h.body, h.reason, h.replyCount]), [['Typo here.', 'resolved', 1], ['Old line, old concern.', 'outdated', 0]]);
});

test('an open thread with replies is one margin item, not one per message', () => {
  const t = thread({}, [msg('rev', 'Is this safe with two workers?'), msg('me', 'One worker today.'), msg('rev', 'Autoscaling lands next sprint.')]);
  const { comments } = triageThreads([t], 'me');
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.id, `rc-${t.opening.nodes[0]!.databaseId}`, 'replies thread under the opening comment');
  assert.deepEqual(comments[0]!.replies, [
    { author: 'me', body: 'One worker today.' },
    { author: 'rev', body: 'Autoscaling lands next sprint.' },
  ]);
  assert.equal(comments[0]!.replied, undefined, 'the reviewer had the last word');
});

test('a thread where the PR author replied last is kept and flagged `replied`', () => {
  const { comments } = triageThreads([thread({}, [msg('rev', 'Can this be a 4xx?'), msg('me', 'Done, 400 now.')])], 'me');
  assert.equal(comments[0]!.replied, true);
});

test('long threads keep the opening and the latest replies, and count what was not fetched', () => {
  const all = [msg('rev', 'Opening'), ...Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'rev' : 'me', `reply ${i}`))];
  const t: ReviewThread = { ...thread({}, all, all.length), opening: { nodes: all.slice(0, 1) }, recent: { totalCount: all.length, nodes: all.slice(-20) } };
  const [c] = triageThreads([t], 'me').comments;
  assert.equal(c!.body, 'Opening');
  assert.equal(c!.replies?.at(-1)?.body, 'reply 29', 'the newest reply is the one that matters');
  assert.equal(c!.omittedReplies, 10);
});

test('bot threads and bot replies are dropped; removed-line comments keep their file but not a line', () => {
  const botThread = thread({}, [msg('ci-bot', 'Coverage dropped', true)]);
  const leftSide = thread({ diffSide: 'LEFT', line: 4 }, [msg('rev', 'Why remove this?'), msg('lint-bot', 'noise', true)]);
  const { comments, hidden } = triageThreads([botThread, leftSide], 'me');
  assert.equal(hidden.length, 0);
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.line, undefined);
  assert.equal(comments[0]!.file, 'src/app.js');
  assert.equal(comments[0]!.replies, undefined);
});

/* ---- Repos GitHub can't serve: no remote, another host, no gh ---- */

/** A `gh` on PATH that logs its argv and answers `auth` with `authCode` and everything else with `stderr`, exit 1. */
function failingGh(stderr: string, authCode = 0): { bin: string; calls: () => string[][] } {
  const bin = tempDir('gh');
  const log = join(bin, 'calls.jsonl');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n[ "$1" = auth ] && exit ${authCode}\necho ${JSON.stringify(stderr)} >&2\nexit 1\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []) };
}

async function withPath<T>(dirs: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = dirs;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

const GITLAB_STDERR =
  'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`';

test('a repo with no remote never runs gh, and says so calmly', async () => {
  const repo = makeRepo();
  git(repo, 'remote', 'remove', 'origin');
  const gh = failingGh('should not be called');
  const access = await withPath(`${gh.bin}:${process.env.PATH ?? ''}`, () => githubAccess(repo));
  assert.deepEqual(access, { ok: false, reason: 'no-remote', note: 'This repository has no remote, so there are no pull requests here.' });
  assert.deepEqual(gh.calls(), []);
});

test('a remote on GitLab is "not on GitHub", not a failure: no PR for the branch, a plain sentence for the list', async () => {
  const repo = makeRepo();
  git(repo, 'remote', 'set-url', 'origin', 'git@gitlab.com:acme/app.git');
  const gh = failingGh(GITLAB_STDERR);
  await withPath(`${gh.bin}:${process.env.PATH ?? ''}`, async () => {
    assert.deepEqual(await githubAccess(repo), { ok: true }, 'gh itself is logged in; only the remote is elsewhere');
    await assert.rejects(findPullRequest(repo), NotOnGitHubError);
    await assert.rejects(findPullRequest(repo, 5), NotOnGitHubError);
    await assert.rejects(listPullRequests(repo), (err: Error) => err instanceof NotOnGitHubError && !err.message.includes('gh auth login'));
  });
});

test('any other gh failure on the branch lookup means "no PR", and an explicit PR says what gh said', async () => {
  const repo = makeRepo();
  const gh = failingGh('error connecting to api.github.com');
  await withPath(`${gh.bin}:${process.env.PATH ?? ''}`, async () => {
    assert.equal(await findPullRequest(repo), null);
    await assert.rejects(findPullRequest(repo, 5), /error connecting to api\.github\.com/);
  });
});

test('gh missing or logged out turns GitHub off with a one-line reason', async () => {
  const repo = makeRepo();
  // Only git on PATH (and node, which the git wrapper doesn't need): no gh anywhere.
  const gitOnly = tempDir('gitonly');
  symlinkSync(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim(), join(gitOnly, 'git'));
  const missing = await withPath(gitOnly, () => githubAccess(repo));
  assert.equal(missing.ok ? '' : missing.reason, 'no-gh');

  const gh = failingGh('You are not logged into any GitHub hosts.', 1);
  const loggedOut = await withPath(`${gh.bin}:${process.env.PATH ?? ''}`, () => githubAccess(repo));
  assert.equal(loggedOut.ok ? '' : loggedOut.reason, 'no-login');
  assert.match(loggedOut.ok ? '' : loggedOut.note, /gh auth login/);
});
