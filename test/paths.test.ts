import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { artifactDir } from '../server/paths.js';
import { cacheRoot } from '../server/platform.js';
import { fileTree, flattenTree, lineRange, normalizePath, splitPath } from '../web/src/paths.js';
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

test('defaults to the platform cache root and ignores a relative XDG_CACHE_HOME', () => {
  const repo = tempDir('p');
  const dir = withXdg('relative/cache', () => artifactDir(repo));
  assert.ok(dir.startsWith(withXdg(undefined, () => cacheRoot())), dir);
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

test('a path splits into its directory and its file name, forward-slashed and repo-relative', () => {
  assert.deepEqual(splitPath('src/api/server.js'), { dir: 'src/api/', name: 'server.js' });
  assert.deepEqual(splitPath('package.json'), { dir: '', name: 'package.json' }, 'a root file has no leading slash');
  assert.deepEqual(splitPath('src\\core\\wallets.js'), { dir: 'src/core/', name: 'wallets.js' }, 'Windows backslashes');
  assert.deepEqual(splitPath('./tests/a.test.js'), { dir: 'tests/', name: 'a.test.js' });
  assert.equal(normalizePath('/abs/x.ts'), 'abs/x.ts');
  assert.equal(lineRange(34, 36), ':34–36');
  assert.equal(lineRange(7, 7), ':7');
});

const f = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions });
const outline = (files: ReturnType<typeof f>[]): string[] =>
  flattenTree(fileTree(files)).map((r) => `${'  '.repeat(r.depth)}${r.name}${r.kind === 'file' ? ` +${r.additions} -${r.deletions} (${r.path})` : ''}`);

test('the Files list: directories first, then files, alphabetical, indented by depth', () => {
  assert.deepEqual(
    outline([f('tests/transfers.test.js', 90), f('src/core/wallets.js', 65, 12), f('package.json', 2, 1), f('src/api/server.js', 42, 8), f('README.md')]),
    [
      'src/',
      '  api/',
      '    server.js +42 -8 (src/api/server.js)',
      '  core/',
      '    wallets.js +65 -12 (src/core/wallets.js)',
      'tests/',
      '  transfers.test.js +90 -0 (tests/transfers.test.js)',
      'README.md +1 -0 (README.md)',
      'package.json +2 -1 (package.json)',
    ],
  );
});

test('a directory with nothing but one subdirectory folds into it, so deep paths stay one line', () => {
  assert.deepEqual(outline([f('src/api/v1/routes.ts'), f('src/api/v1/auth.ts')]), [
    'src/api/v1/',
    '  auth.ts +1 -0 (src/api/v1/auth.ts)',
    '  routes.ts +1 -0 (src/api/v1/routes.ts)',
  ]);
  assert.deepEqual(outline([f('src/api/v1/routes.ts'), f('src/index.ts')]), [
    'src/',
    '  api/v1/',
    '    routes.ts +1 -0 (src/api/v1/routes.ts)',
    '  index.ts +1 -0 (src/index.ts)',
  ], 'a directory that also holds a file stays its own line');
  assert.deepEqual(outline([f('a\\b\\c.ts')]), ['a/b/', '  c.ts +1 -0 (a/b/c.ts)'], 'backslash paths group like slash paths');
});

test('the order never depends on the order of the diff', () => {
  const files = [f('b/x.ts'), f('a/y.ts'), f('B/z.ts'), f('a/b/w.ts'), f('z.ts'), f('A.ts')];
  const once = outline(files);
  assert.deepEqual(outline([...files].reverse()), once);
  assert.deepEqual(outline([files[3]!, files[0]!, files[5]!, files[1]!, files[4]!, files[2]!]), once);
});
