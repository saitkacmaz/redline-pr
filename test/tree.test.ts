import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { changesBetween, treeState } from '../server/git.js';
import { changedPaths, git, snapshot, tempDir, write } from './helpers.js';

test('a run is reported relative to what was on disk before it, not to HEAD', async () => {
  const dir = tempDir('tree');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'clean.js', 'a\n');
  write(dir, 'dirty.js', 'one\ntwo\n');
  write(dir, 'q"uote.ts', 'x\n');
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
  write(dir, 'q"uote.ts', 'y\n');
  write(dir, 'new.js', 'fresh\n');
  rmSync(join(dir, 'gone.js'));

  const changes = await changesBetween(dir, before, await treeState(dir));
  assert.deepEqual(changes.files, ['clean.js', 'dirty.js', 'gone.js', 'new.js', 'notes.txt', 'q"uote.ts']);

  const patch = (p: string): string => changes.diff.split(/^(?=diff --git )/m).find((c) => c.startsWith(`diff --git a/${p} `)) ?? '';
  assert.match(patch('dirty.js'), /^\+claude$/m);
  assert.doesNotMatch(patch('dirty.js'), /^\+mine$/m, "the user's earlier edit is not shown as Claude's");
  assert.match(patch('notes.txt'), /^\+edited$/m);
  assert.match(patch('q"uote.ts'), /^\+y$/m);
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
