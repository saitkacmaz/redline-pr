import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileStats, hunkFor, numberedDiff, parseUnifiedDiff } from '../server/diff.js';
import { DEMO_DIFF } from '../server/demo.js';

const SMALL = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,7 @@
 export function add(a, b) {
-  return a + b;
+  try {
+    return a + b;
+  } catch {
+    return 0;
+  }
 }
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3333333..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-too
`;

test('parses files, paths, and hunk ranges', () => {
  const files = parseUnifiedDiff(SMALL);
  assert.deepEqual(
    files.map((f) => f.path),
    ['src/a.js', 'old.txt'],
  );
  const [hunk] = files[0]!.hunks;
  assert.equal(hunk!.newStart, 1);
  assert.equal(hunk!.newEnd, 7);
  assert.equal(hunk!.oldEnd, 3);
});

test('parses the demo diff into its three files', () => {
  const files = parseUnifiedDiff(DEMO_DIFF);
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ['migrations/0042_ingest_jobs.sql', 'services/ingest/handler.py', 'services/ingest/jobs.py'],
  );
});

test('fileStats counts added and removed lines per file, like git diff --stat', () => {
  assert.deepEqual(fileStats(parseUnifiedDiff(SMALL)), [
    { path: 'src/a.js', additions: 5, deletions: 1 },
    { path: 'old.txt', additions: 0, deletions: 2 },
  ]);
  const tricky = 'diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1,2 +1,2 @@\n---- old rule\n++++ new rule\n same\n\\ No newline at end of file\n';
  assert.deepEqual(fileStats(parseUnifiedDiff(tricky)), [{ path: 'x.md', additions: 1, deletions: 1 }], 'content that looks like a header still counts once');
});

test('numberedDiff numbers new-side lines and leaves removals unnumbered', () => {
  const out = numberedDiff(parseUnifiedDiff(SMALL)).split('\n');
  assert.equal(out[0], '=== FILE: src/a.js');
  assert.equal(out[2], '   1  export function add(a, b) {');
  assert.equal(out[3], '     -  return a + b;');
  assert.equal(out[4], '   2 +  try {');
});

test('hunkFor slices to the anchor with a valid header', () => {
  const files = parseUnifiedDiff(DEMO_DIFF);
  const peek = hunkFor(files, 'services/ingest/handler.py', 30, 30);
  const [header, ...body] = peek.split('\n');
  const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(header!);
  assert.ok(m, `bad header: ${header}`);
  const newCount = body.filter((l) => !l.startsWith('-') && !l.startsWith('\\')).length;
  assert.equal(Number(m[4]), newCount);
  assert.ok(Number(m[3]) <= 30 && Number(m[3]) + newCount - 1 >= 30);
  assert.ok(body.length <= 7 + 2, 'peek should be about the anchor +/- 3 lines');
});

test('hunkFor matches a path suffix and returns empty for unknown files', () => {
  const files = parseUnifiedDiff(SMALL);
  assert.notEqual(hunkFor(files, 'a.js', 2, 3), '');
  assert.equal(hunkFor(files, 'nope.js', 1, 1), '');
});

/* ---- Real git output: run the same command redline runs against scratch repos ---- */

import { writeFileSync as writeRaw, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { diffAgainst } from '../server/git.js';
import { git, tempDir, write } from './helpers.js';

async function diffOf(change: (dir: string) => void, setup?: (dir: string) => void): Promise<ReturnType<typeof parseUnifiedDiff>> {
  const dir = tempDir('diff');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'keep.txt', 'keep\n');
  setup?.(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  change(dir);
  return parseUnifiedDiff(await diffAgainst(dir, 'main'));
}

test('non-ASCII and spaced file names keep their real paths', async () => {
  const files = await diffOf((d) => {
    write(d, 'café.txt', 'x\n');
    write(d, 'my file.txt', 'y\n');
    git(d, 'add', '-A');
  });
  assert.deepEqual(files.map((f) => f.path).sort(), ['café.txt', 'my file.txt']);
});

test('an added line starting with "++" is content, not a file header', async () => {
  const files = await diffOf((d) => write(d, 'a.hs', 'main = do\n++ extra\n  print 1\n'), (d) => write(d, 'a.hs', 'main = do\n  print 1\n'));
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, 'a.hs');
  const out = numberedDiff(files);
  assert.match(out, /^ {3}2 \+\+\+ extra$/m);
  assert.match(out, /^ {3}3 {4}print 1$/m);
});

test('the user diff config cannot change prefixes', async () => {
  const files = await diffOf((d) => {
    git(d, 'config', 'diff.mnemonicPrefix', 'true');
    git(d, 'config', 'diff.noprefix', 'true');
    write(d, 'keep.txt', 'changed\n');
  });
  assert.deepEqual(files.map((f) => f.path), ['keep.txt']);
});

test('renames, mode changes, and binary files are reported, not dropped', async () => {
  const files = await diffOf(
    (d) => {
      git(d, 'mv', 'old.txt', 'new.txt');
      chmodSync(join(d, 'run.sh'), 0o755);
      writeRaw(join(d, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 9]));
      git(d, 'add', '-A');
      // Windows has no executable bit, so git takes the mode from the index there.
      git(d, 'update-index', '--chmod=+x', 'run.sh');
    },
    (d) => {
      write(d, 'old.txt', 'same content\nacross the rename\n');
      write(d, 'run.sh', 'echo hi\n');
      writeRaw(join(d, 'img.bin'), Buffer.from([0, 1, 2, 0]));
    },
  );
  const byPath = new Map(files.map((f) => [f.path, f.notes]));
  assert.deepEqual(byPath.get('new.txt'), ['renamed from old.txt']);
  assert.deepEqual(byPath.get('run.sh'), ['mode 100644 → 100755']);
  assert.deepEqual(byPath.get('img.bin'), ['binary']);
  assert.match(numberedDiff(files), /=== FILE: new\.txt \(renamed from old\.txt\)/);
});

test('an ambiguous file name does not pick an arbitrary file', () => {
  const twoIndexes = `diff --git a/src/a/index.ts b/src/a/index.ts
--- a/src/a/index.ts
+++ b/src/a/index.ts
@@ -1 +1 @@
-a
+b
diff --git a/src/b/index.ts b/src/b/index.ts
--- a/src/b/index.ts
+++ b/src/b/index.ts
@@ -1 +1 @@
-c
+d
`;
  const files = parseUnifiedDiff(twoIndexes);
  assert.equal(hunkFor(files, 'index.ts', 1, 1), '');
  assert.notEqual(hunkFor(files, 'b/index.ts', 1, 1), '');
});

test('an anchor on an unchanged line does not borrow a nearby deletion', () => {
  const d = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -40,6 +40,0 @@
-1
-2
-3
-4
-5
-6
`;
  const files = parseUnifiedDiff(d);
  assert.equal(hunkFor(files, 'f.txt', 42, 42), '');
  assert.notEqual(hunkFor(files, 'f.txt', 40, 41), '');
});

test('files the repo marks linguist-generated or vendored are left out', async () => {
  const files = await diffOf(
    (d) => {
      write(d, 'gen/api.ts', 'export const v = 2;\n');
      write(d, 'third_party/lib.js', 'v2\n');
      write(d, 'keep.txt', 'changed\n');
      write(d, 'Gemfile.lock', 'v2\n');
    },
    (d) => {
      write(d, '.gitattributes', 'gen/** linguist-generated\nthird_party/** linguist-vendored\n');
      write(d, 'gen/api.ts', 'export const v = 1;\n');
      write(d, 'third_party/lib.js', 'v1\n');
      write(d, 'Gemfile.lock', 'v1\n');
    },
  );
  assert.deepEqual(files.map((f) => f.path), ['keep.txt']);
});
