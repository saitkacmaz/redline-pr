import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const created: string[] = [];
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory in the OS temp dir, removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `redline-test-${prefix}-`)));
  created.push(dir);
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

export function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

/** A repo with `main` and a checked-out `feat` branch that changes src/app.js (src/util.js is untouched). */
export function makeRepo(): string {
  const dir = tempDir('repo');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'src/app.js', 'export function add(a, b) {\n  return a + b;\n}\n');
  write(dir, 'src/util.js', 'export const id = (x) => x;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feat');
  write(dir, 'src/app.js', 'export function add(a, b) {\n  try {\n    return a + b;\n  } catch {\n    return 0;\n  }\n}\n');
  git(dir, 'commit', '-qam', 'feat');
  return dir;
}

/** sha256 of every file under `root`, including .git, keyed by relative path. */
export function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(root, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

/** Paths added, removed, or changed between two snapshots. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort();
}

/**
 * A fake `claude` on PATH. Spec calls (with --json-schema) get `specJson` as
 * structured_output; sync calls append a line to src/app.js, like a real edit.
 * Every invocation's argv and stdin are logged to `logFile` for assertions.
 */
export function fakeClaude(specJson: unknown, opts: { failSpec?: string } = {}): { binDir: string; logFile: string } {
  const binDir = tempDir('bin');
  const logFile = join(binDir, 'calls.jsonl');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, cwd: process.cwd(), input }) + '\\n');
  if (args.includes('--json-schema')) {
    ${opts.failSpec ? `process.stdout.write(${JSON.stringify(opts.failSpec)}); process.exit(1);` : ''}
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: ${JSON.stringify(specJson)} }));
  } else {
    fs.appendFileSync('src/app.js', '// edited by fake claude\\n');
    process.stdout.write('Change 1: edited src/app.js');
  }
});
`;
  const path = join(binDir, 'claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { binDir, logFile };
}

export function readCalls(logFile: string): { args: string[]; cwd: string; input: string }[] {
  try {
    return readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; cwd: string; input: string });
  } catch {
    return [];
  }
}
