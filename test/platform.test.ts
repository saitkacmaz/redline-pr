import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCliArgs } from '../server/cli-args.js';
import { parseUnifiedDiff } from '../server/diff.js';
import { browserCommand, cacheRoot, findExecutable, npmShimTarget, quoteCmdArg, resolveSpawn, shellPath } from '../server/platform.js';
import { tempDir } from './helpers.js';

/* ---- `redline [claude|codex] [<pr>]` ---- */

const parse = (argv: string, env: NodeJS.ProcessEnv = {}) => parseCliArgs(argv.split(' ').filter(Boolean), env);

test('positional agent and PR number, in any order, with flags anywhere', () => {
  assert.deepEqual([parse('').agent, parse('').pr], [undefined, undefined]);
  assert.equal(parse('claude').agent, 'claude');
  assert.equal(parse('codex').agent, 'codex');
  assert.deepEqual([parse('codex 12').agent, parse('codex 12').pr], ['codex', 12]);
  assert.deepEqual([parse('12 claude').agent, parse('12 claude').pr], ['claude', 12]);
  const withFlags = parse('claude --base develop --no-open');
  assert.deepEqual([withFlags.agent, withFlags.base, withFlags.open], ['claude', 'develop', false]);
  assert.equal(parse('Codex').agent, 'codex', 'case does not matter');
  assert.equal(parse('14').pr, 14);
});

test('--agent and --pr still work, and agree with the positionals or are refused', () => {
  assert.equal(parse('--agent codex').agent, 'codex');
  assert.equal(parse('codex --agent codex').agent, 'codex');
  assert.throws(() => parse('claude --agent codex'), /Both --agent codex and claude were given/);
  assert.throws(() => parse('claude codex'), /Pick one agent/);
  assert.throws(() => parse('--agent gemini'), /Unknown agent "gemini"/);
  assert.equal(parse('--pr 7 7').pr, 7);
  assert.throws(() => parse('--pr 7 8'), /Both --pr 7 and 8 were given/);
  assert.throws(() => parse('7 8'), /at most one PR number/);
  assert.throws(() => parse('seven'), /Unknown argument "seven"\. Pass a PR number \(redline 14\), an agent \(redline codex\)/);
});

test('REDLINE_AGENT and REDLINE_MODEL fill in what the command line left out', () => {
  assert.equal(parse('', { REDLINE_AGENT: 'codex' }).agent, 'codex');
  assert.equal(parse('claude', { REDLINE_AGENT: 'codex' }).agent, 'claude', 'the command line wins');
  assert.throws(() => parse('', { REDLINE_AGENT: 'gpt' }), /REDLINE_AGENT must be claude or codex/);
  assert.equal(parse('', { REDLINE_MODEL: ' opus ' }).model, 'opus');
  assert.equal(parse('--model sonnet', { REDLINE_MODEL: 'opus' }).model, 'sonnet');
});

/* ---- Cache directory ---- */

test('the cache root: XDG_CACHE_HOME, else %LOCALAPPDATA% on Windows, else ~/.cache', () => {
  assert.equal(cacheRoot({ XDG_CACHE_HOME: '/x/cache' }, 'linux', '/home/a'), '/x/cache/redline-pr');
  assert.equal(cacheRoot({}, 'linux', '/home/a'), '/home/a/.cache/redline-pr');
  assert.equal(cacheRoot({}, 'darwin', '/Users/a'), '/Users/a/.cache/redline-pr');
  assert.equal(cacheRoot({ XDG_CACHE_HOME: 'relative' }, 'linux', '/home/a'), '/home/a/.cache/redline-pr', 'a relative XDG path is ignored');
  assert.equal(cacheRoot({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Local\\redline-pr');
  assert.equal(cacheRoot({}, 'win32', 'C:\\Users\\a'), 'C:\\Users\\a\\.cache\\redline-pr');
  assert.equal(cacheRoot({ LOCALAPPDATA: '/ignored' }, 'linux', '/home/a'), '/home/a/.cache/redline-pr', 'LOCALAPPDATA only means something on Windows');
});

/* ---- Finding and spawning CLIs ---- */

test('findExecutable searches PATH like which (POSIX) and where (Windows, with PATHEXT)', () => {
  const a = tempDir('path-a');
  const b = tempDir('path-b');
  writeFileSync(join(a, 'claude'), 'not executable');
  writeFileSync(join(b, 'claude'), '#!/bin/sh\n');
  chmodSync(join(b, 'claude'), 0o755);
  assert.equal(findExecutable('claude', { pathEnv: `${a}:${b}`, platform: 'linux' }), join(b, 'claude'), 'skips a non-executable file');
  assert.equal(findExecutable('codex', { pathEnv: `${a}:${b}`, platform: 'linux' }), null);

  writeFileSync(join(a, 'codex.cmd'), '@echo off\n');
  writeFileSync(join(b, 'codex.exe'), '');
  // Windows (like macOS) ignores case in file names, so PATHEXT's ".CMD" finds codex.cmd.
  assert.equal(findExecutable('codex', { pathEnv: `${a};${b}`, platform: 'win32', pathext: '.EXE;.CMD' })?.toLowerCase(), join(a, 'codex.cmd').toLowerCase(), 'first PATH dir wins');
  assert.equal(findExecutable('claude', { pathEnv: `${a};${b}`, platform: 'win32', pathext: '.EXE;.CMD' }), null, 'no extension, no match on Windows');
});

const SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;

test('npm .cmd shims on Windows run through node and their script, so stdin and multi-line arguments survive', () => {
  assert.equal(npmShimTarget(SHIM), 'node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(npmShimTarget('"%~dp0\\node_modules\\x\\cli.mjs" %*'), 'node_modules\\x\\cli.mjs', 'older shims too');
  assert.equal(npmShimTarget('@echo off\r\necho hi'), null);

  const dir = tempDir('shims');
  writeFileSync(join(dir, 'codex.cmd'), SHIM);
  const target = resolveSpawn('codex', ['exec', 'line one\nline two'], { platform: 'win32', pathEnv: dir, pathext: '.CMD', node: 'node.exe' });
  assert.deepEqual(target, { file: 'node.exe', args: [join(dir, 'node_modules\\@openai\\codex\\bin\\codex.js'), 'exec', 'line one\nline two'], verbatim: false });
});

test('a .cmd that is not an npm shim goes through cmd.exe with every argument quoted; POSIX and .exe spawn directly', () => {
  const dir = tempDir('cmds');
  writeFileSync(join(dir, 'gh.cmd'), '@echo off\r\n"C:\\tools\\gh.exe" %*\r\n');
  const viaCmd = resolveSpawn('gh', ['pr', 'a "quoted" & piped|arg'], { platform: 'win32', pathEnv: dir, pathext: '.CMD', comspec: 'C:\\Windows\\cmd.exe' });
  assert.equal(viaCmd.file, 'C:\\Windows\\cmd.exe');
  assert.equal(viaCmd.verbatim, true);
  assert.deepEqual(viaCmd.args.slice(0, 3), ['/d', '/s', '/c']);
  const line = viaCmd.args[3] ?? '';
  assert.ok(line.includes('^"pr^"'), line);
  assert.ok(line.includes('^"a^ \\^"quoted\\^"^ ^&^ piped^|arg^"'), line);

  assert.equal(quoteCmdArg('plain'), '^"plain^"');
  assert.equal(quoteCmdArg('C:\\dir\\'), '^"C:\\dir\\\\^"', 'a trailing backslash is doubled so it does not escape the quote');

  mkdirSync(join(dir, 'exe'));
  writeFileSync(join(dir, 'exe', 'git.exe'), '');
  const exe = resolveSpawn('git', ['status'], { platform: 'win32', pathEnv: join(dir, 'exe'), pathext: '.EXE' });
  assert.deepEqual({ ...exe, file: exe.file.toLowerCase() }, { file: join(dir, 'exe', 'git.exe').toLowerCase(), args: ['status'], verbatim: false });
  assert.deepEqual(resolveSpawn('claude', ['-p'], { platform: 'linux' }), { file: 'claude', args: ['-p'], verbatim: false });
});

test('the browser opens with open / cmd start / xdg-open, and not at all on a headless or SSH Linux session', () => {
  const url = 'http://127.0.0.1:4400';
  assert.deepEqual(browserCommand(url, 'darwin', {}), { file: 'open', args: [url], verbatim: false });
  assert.deepEqual(browserCommand(url, 'win32', {}), { file: 'cmd', args: ['/c', 'start', '""', url], verbatim: true });
  assert.deepEqual(browserCommand(url, 'linux', { DISPLAY: ':0' }), { file: 'xdg-open', args: [url], verbatim: false });
  assert.deepEqual(browserCommand(url, 'linux', { WAYLAND_DISPLAY: 'wayland-0' })?.file, 'xdg-open');
  assert.equal(browserCommand(url, 'linux', { SSH_CONNECTION: '1.2.3.4 22' }), null);
  assert.equal(browserCommand(url, 'linux', {}), null);
});

test('resume commands quote the repo path for the shell they will be pasted into', () => {
  assert.equal(shellPath('/home/a/repo', 'linux'), '/home/a/repo');
  assert.equal(shellPath("/home/a/my repo's", 'linux'), `'/home/a/my repo'\\''s'`);
  assert.equal(shellPath('C:\\work\\repo', 'win32'), 'C:\\work\\repo');
  assert.equal(shellPath('C:\\My Work\\repo', 'win32'), '"C:\\My Work\\repo"');
});

/* ---- Diffs with Windows line endings ---- */

test('a diff with CRLF line endings parses exactly like the LF one', () => {
  const lf = 'diff --git a/src/app.js b/src/app.js\nindex 1..2 100644\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,2 +1,3 @@\n export function add(a, b) {\n+  // checked\n   return a + b;\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const [a] = parseUnifiedDiff(lf);
  const [b] = parseUnifiedDiff(crlf);
  assert.ok(a && b);
  assert.equal(b.path, 'src/app.js', 'no \\r in the path');
  assert.deepEqual(b, a);
  assert.ok(!JSON.stringify(b).includes('\\r'));
});
