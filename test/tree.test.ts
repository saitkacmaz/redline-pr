import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { changesBetween, NoBaseBranchError, resolveBaseRef, treeState } from '../server/git.js';
import { changedPaths, git, makeRepo, snapshot, tempDir, write } from './helpers.js';

test('a run is reported relative to what was on disk before it, not to HEAD', async () => {
  const dir = tempDir('tree');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'clean.js', 'a\n');
  write(dir, 'dirty.js', 'one\ntwo\n');
  // A file name git has to quote. Windows forbids `"` in names, so a space stands in there.
  const ODD = process.platform === 'win32' ? 'sp ace.ts' : 'q"uote.ts';
  write(dir, ODD, 'x\n');
  write(dir, 'gone.js', 'bye\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');

  // The user's own uncommitted work before the run.
  write(dir, 'dirty.js', 'one\ntwo\nmine\n');
  write(dir, 'notes.txt', 'draft\n');

  const before = await treeState(dir);
  const gitBefore = snapshot(join(dir, '.git'));

  // What "Claude" does.
  write(dir, 'clean.js', 'a\nb\n');
  write(dir, 'dirty.js', 'one\ntwo\nmine\nclaude\n');
  write(dir, 'notes.txt', 'draft\nedited\n');
  write(dir, ODD, 'y\n');
  write(dir, 'new.js', 'fresh\n');
  rmSync(join(dir, 'gone.js'));

  const changes = await changesBetween(dir, before, await treeState(dir));
  assert.deepEqual(changes.files, ['clean.js', 'dirty.js', 'gone.js', 'new.js', 'notes.txt', ODD].sort());

  const patch = (p: string): string => changes.diff.split(/^(?=diff --git )/m).find((c) => c.startsWith(`diff --git a/${p} `)) ?? '';
  assert.match(patch('dirty.js'), /^\+claude$/m);
  assert.doesNotMatch(patch('dirty.js'), /^\+mine$/m, "the user's earlier edit is not shown as Claude's");
  assert.match(patch('notes.txt'), /^\+edited$/m);
  assert.match(patch(ODD), /^\+y$/m);
  assert.match(patch('new.js'), /^\+fresh$/m);
  assert.match(patch('gone.js'), /^-bye$/m);
  assert.deepEqual(changedPaths(gitBefore, snapshot(join(dir, '.git'))), [], 'snapshots never write .git');
});

test('no changes, no report', async () => {
  const dir = tempDir('tree');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'a.js', 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  write(dir, 'a.js', 'dirty\n');
  const s = await treeState(dir);
  assert.deepEqual(await changesBetween(dir, s, await treeState(dir)), { files: [], diff: '' });
});

test('the auto-detected base is never the branch being reviewed', async () => {
  const repo = makeRepo();
  // A clone made from a checkout of `feat` points origin/HEAD at origin/feat.
  git(repo, 'update-ref', 'refs/remotes/origin/feat', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat');
  assert.deepEqual(await resolveBaseRef(repo, undefined, 'feat'), { name: 'main', ref: 'origin/main' });
  assert.deepEqual(await resolveBaseRef(repo, 'feat', 'feat'), { name: 'feat', ref: 'origin/feat' }, 'an explicit --base is taken as given');
});

/** A repo with no remote whose default branch is `name`, and a `feat` branch off it. */
function localRepo(name: string): string {
  const dir = tempDir('local');
  git(dir, 'init', '-q', '-b', name);
  write(dir, 'a.js', 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feat');
  return dir;
}

test('without a remote, the base is the local main, then master, then develop', async () => {
  assert.deepEqual(await resolveBaseRef(localRepo('main'), undefined, 'feat'), { name: 'main', ref: 'main' });
  assert.deepEqual(await resolveBaseRef(localRepo('master'), undefined, 'feat'), { name: 'master', ref: 'master' });
  assert.deepEqual(await resolveBaseRef(localRepo('develop'), undefined, 'feat'), { name: 'develop', ref: 'develop' });
  const both = localRepo('master');
  git(both, 'branch', 'main', 'master');
  assert.deepEqual(await resolveBaseRef(both, undefined, 'feat'), { name: 'main', ref: 'main' }, 'main before master');
});

test('origin/HEAD wins over a local main, whatever the default branch is called', async () => {
  const repo = localRepo('main');
  git(repo, 'branch', 'develop', 'main');
  git(repo, 'update-ref', 'refs/remotes/origin/develop', 'develop');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  assert.deepEqual(await resolveBaseRef(repo, undefined, 'feat'), { name: 'develop', ref: 'origin/develop' });
  assert.deepEqual(await resolveBaseRef(repo, 'main', 'feat'), { name: 'main', ref: 'main' }, '--base comes first');
});

test('no default branch at all is a NoBaseBranchError; a missing --base is a plain error that names it', async () => {
  const repo = localRepo('trunk');
  await assert.rejects(resolveBaseRef(repo, undefined, 'feat'), NoBaseBranchError);
  await assert.rejects(resolveBaseRef(repo, 'release', 'feat'), (err: Error) => !(err instanceof NoBaseBranchError) && /"release" not found/.test(err.message));
});

test('generated files are left out of a large PR before Claude sees it', async () => {
  const { isExcludedPath } = await import('../server/git.js');
  for (const path of ['web/package-lock.json', 'Cargo.lock', 'api/user.pb.go', 'proto/user_pb2.py', 'lib/model.g.dart', 'src/__snapshots__/App.test.tsx.snap', 'src/__generated__/schema.ts', 'dist/app.min.js']) {
    assert.equal(isExcludedPath(path), true, path);
  }
  for (const path of ['src/lock.ts', 'src/snapshots/view.ts', 'server/generated_report.py', 'go.mod']) {
    assert.equal(isExcludedPath(path), false, path);
  }
});
