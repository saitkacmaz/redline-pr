import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { artifactDir } from '../server/paths.js';
import { tempDir } from './helpers.js';

function withXdg<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.XDG_CACHE_HOME;
  if (value === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  }
}

test('artifacts live under XDG_CACHE_HOME/redline-pr/<sha256 of repo path>', () => {
  const repo = tempDir('p');
  const cache = tempDir('cache');
  const dir = withXdg(cache, () => artifactDir(repo));
  assert.equal(dir, join(cache, 'redline-pr', createHash('sha256').update(repo).digest('hex')));
});

test('defaults to ~/.cache and ignores a relative XDG_CACHE_HOME', () => {
  const repo = tempDir('p');
  const dir = withXdg('relative/cache', () => artifactDir(repo));
  assert.ok(dir.startsWith(join(homedir(), '.cache', 'redline-pr')));
});

test('refuses a cache dir inside the repository', () => {
  const repo = tempDir('p');
  assert.throws(() => withXdg(join(repo, '.cache'), () => artifactDir(repo)), /inside the repository/);
});

test('does not create anything', () => {
  const cache = tempDir('cache');
  const dir = withXdg(cache, () => artifactDir(tempDir('p')));
  assert.throws(() => process.chdir(dir));
});
