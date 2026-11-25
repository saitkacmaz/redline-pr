import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { artifactDir } from '../server/paths.js';
import { lineRange, shortPaths } from '../web/src/paths.js';
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

/* ---- How the page names files ---- */

test('files are named by their shortest unique tail, in every view alike', () => {
  const name = shortPaths(['src/server.js', 'api/index.ts', 'web/index.ts', 'a/lib/util.ts', 'b/lib/util.ts', 'README.md', 'src/server.js']);
  assert.equal(name('src/server.js'), 'server.js', 'unique name: just the file');
  assert.equal(name('api/index.ts'), 'api/index.ts');
  assert.equal(name('web/index.ts'), 'web/index.ts', 'same name: enough folder to tell them apart');
  assert.equal(name('a/lib/util.ts'), 'a/lib/util.ts');
  assert.equal(name('README.md'), 'README.md');
  assert.equal(name('other/file.ts'), 'other/file.ts', 'a path not in the PR is shown in full');
  assert.equal(shortPaths(['x/index.ts', 'index.ts'])('index.ts'), 'index.ts', 'a root file that is a tail of another keeps its name');
  assert.equal(shortPaths(['x/index.ts', 'index.ts'])('x/index.ts'), 'x/index.ts');
  assert.equal(lineRange('server.js', 34, 36), 'server.js:34-36');
  assert.equal(lineRange('server.js', 7, 7), 'server.js:7');
});
