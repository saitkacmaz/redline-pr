import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { findExecutable } from '../server/platform.js';

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

/**
 * A repo with `main` and a checked-out `feat` branch that changes src/app.js (src/util.js is untouched).
 * Its origin names a GitHub repo, never fetched, so a fake `gh` has something to answer for.
 */
export function makeRepo(): string {
  const dir = tempDir('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  write(dir, 'src/app.js', 'export function add(a, b) {\n  return a + b;\n}\n');
  write(dir, 'src/util.js', 'export const id = (x) => x;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feat');
  write(dir, 'src/app.js', 'export function add(a, b) {\n  try {\n    return a + b;\n  } catch {\n    return 0;\n  }\n}\n');
  git(dir, 'commit', '-qam', 'feat');
  return dir;
}

/**
 * Put a node script on PATH as the command `name`. POSIX: an executable file. Windows: the
 * script plus an npm-style `.cmd` shim, which redline runs as node + script, exactly like
 * a real npm-installed `claude` or `codex`. Returns the script's path.
 */
export function installBin(binDir: string, name: string, script: string): string {
  if (process.platform !== 'win32') {
    const file = join(binDir, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    return file;
  }
  const file = join(binDir, `${name}.js`);
  writeFileSync(file, script);
  writeFileSync(join(binDir, `${name}.cmd`), `@ECHO off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
  return file;
}

/** `dirs` in front of the current PATH. */
export const prependPath = (...dirs: string[]): string => [...dirs, process.env.PATH ?? ''].join(delimiter);

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
 * A fake `claude` on PATH that speaks `--output-format stream-json`. Spec calls (with
 * --json-schema) "read" src/app.js and return `specJson` as structured_output; sync calls
 * "edit" src/app.js by appending a line, like a real edit. Every invocation's argv and
 * stdin are logged to `logFile` for assertions. `syncDelayMs` holds a sync run open.
 */
export function fakeClaude(specJson: unknown, opts: { failSpec?: string; syncDelayMs?: number; loggedIn?: boolean; binDir?: string } = {}): { binDir: string; logFile: string } {
  const binDir = opts.binDir ?? tempDir('bin');
  const logFile = join(binDir, 'calls.jsonl');
  const loggedIn = opts.loggedIn !== false;
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: ${loggedIn}, authMethod: ${loggedIn ? "'claude.ai'" : "'none'"} }));
  process.exit(${loggedIn ? 0 : 1});
}
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const tool = (name, input) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, cwd: process.cwd(), input }) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 'fake-session-1' });
  if (args.includes('--json-schema')) {
    ${opts.failSpec ? `process.stdout.write(${JSON.stringify(opts.failSpec)}); process.exit(1);` : ''}
    const repo = args[args.indexOf('--add-dir') + 1];
    tool('Read', { file_path: path.join(repo, 'src/app.js') });
    out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: ${JSON.stringify(specJson)} });
  } else {
    tool('Edit', { file_path: path.join(process.cwd(), 'src/app.js') });
    setTimeout(() => {
      fs.appendFileSync('src/app.js', '// edited by fake claude\\n');
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Change 1: edited src/app.js' });
    }, ${opts.syncDelayMs ?? 0});
  }
});
`;
  installBin(binDir, 'claude', script);
  return { binDir, logFile };
}

/**
 * A fake `codex` on PATH that speaks `codex exec --json`, logging each call to `logFile`
 * like fakeClaude, plus whether the schema file existed at call time. Spec calls (with
 * --output-schema) "read" src/app.js, send a progress note, then the answer as the last
 * message and to the --output-last-message file. Sync calls edit src/app.js. `failSpec`
 * (and `failSync`) fail the way Codex reports an API error.
 */
export function fakeCodex(specJson: unknown, opts: { failSpec?: string; failSync?: string; syncDelayMs?: number; loggedIn?: boolean; binDir?: string } = {}): { binDir: string; logFile: string } {
  const binDir = opts.binDir ?? tempDir('bin');
  const logFile = join(binDir, 'codex-calls.jsonl');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write(${opts.loggedIn !== false ? "'Logged in using ChatGPT\\n'" : "'Not logged in\\n'"});
  process.exit(${opts.loggedIn !== false ? 0 : 1});
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const schema = flag('--output-schema');
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, cwd: process.cwd(), input, schema: schema && fs.existsSync(schema) ? JSON.parse(fs.readFileSync(schema, 'utf8')) : null }) + '\\n');
  out({ type: 'thread.started', thread_id: 'thread-1' });
  out({ type: 'turn.started' });
  if (schema) {
    ${opts.failSpec ? `const m = JSON.stringify({ type: 'error', status: 400, error: { message: ${JSON.stringify(opts.failSpec)} } }); out({ type: 'error', message: m }); out({ type: 'turn.failed', error: { message: m } }); process.exit(1);` : ''}
    const repo = /^Repository: (.+)$/m.exec(input)[1];
    out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will read src/app.js first.' } });
    const command = '/bin/zsh -lc "sed -n \\'1,80p\\' ' + path.join(repo, 'src/app.js') + '"';
    out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command, aggregated_output: 'x', exit_code: 0, status: 'completed' } });
    const answer = JSON.stringify(${JSON.stringify(specJson)});
    fs.writeFileSync(flag('--output-last-message'), answer);
    out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: answer } });
  } else {
    ${opts.failSync ? `const m = JSON.stringify({ type: 'error', status: 400, error: { message: ${JSON.stringify(opts.failSync)} } }); out({ type: 'error', message: m }); out({ type: 'turn.failed', error: { message: m } }); process.exit(1);` : ''}
    const file = path.join(process.cwd(), 'src/app.js');
    out({ type: 'item.started', item: { id: 'item_1', type: 'file_change', changes: [{ path: file, kind: 'update' }], status: 'in_progress' } });
    fs.appendFileSync(file, '// edited by fake codex\\n');
    out({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: file, kind: 'update' }], status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Change 1: edited src/app.js' } });
  }
  setTimeout(() => out({ type: 'turn.completed', usage: {} }), schema ? 0 : ${opts.syncDelayMs ?? 0});
});
`;
  installBin(binDir, 'codex', script);
  return { binDir, logFile };
}

/**
 * A directory with git (and node, for a fake's `#!/usr/bin/env node`) and nothing else. On
 * Windows, where symlinks need admin rights, it's git's own directory instead: Git for
 * Windows keeps only its own tools there.
 */
export function gitOnlyDir(): string {
  const gitPath = findExecutable('git');
  if (!gitPath) throw new Error('git is not on PATH');
  if (process.platform === 'win32') return dirname(gitPath);
  const tools = tempDir('tools');
  symlinkSync(process.execPath, join(tools, 'node'));
  symlinkSync(gitPath, join(tools, 'git'));
  return tools;
}

/** A PATH with only `dirs` plus node, git and the OS's own tools: no real claude, codex or gh can leak in. */
export function isolatedPath(...dirs: string[]): string {
  const system = process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  return [...dirs, gitOnlyDir(), ...system].join(delimiter);
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
