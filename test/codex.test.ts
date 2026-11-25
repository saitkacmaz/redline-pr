import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexStream, describeCommand, unwrapError, unwrapShell } from '../server/providers/codex-stream.js';
import { describeCodexFailure, strictSchema } from '../server/providers/codex.js';
import { chooseAgent, detectProviders, NO_AGENT, onPath } from '../server/providers/index.js';
import { claudeLoggedIn } from '../server/providers/claude.js';
import type { ProviderStatuses } from '../shared/types.js';
import { SPEC_SCHEMA } from '../server/spec.js';
import { tempDir } from './helpers.js';

const ROOT = '/work/repo';

/** Feed `events` as JSONL (strings go through as raw lines), split at awkward points, and collect what the stream reported. */
function replay(events: unknown[], root = ROOT) {
  const steps: string[] = [];
  const logs: string[] = [];
  const stream = codexStream(root, { onStep: (s) => steps.push(s), onLog: (l) => logs.push(l) });
  const text = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
  for (let i = 0; i < text.length; i += 37) stream.push(text.slice(i, i + 37));
  return { steps, logs, outcome: stream.finish() };
}

const cmd = (id: string, command: string, phase: 'item.started' | 'item.completed', exit: number | null = null, output = '') => ({
  type: phase,
  item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: exit, status: phase === 'item.started' ? 'in_progress' : 'completed' },
});
const msg = (id: string, text: string) => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });

// The shape of a real `codex exec --json --sandbox read-only --output-schema …` run (codex-cli 0.163).
const SPEC_RUN = [
  { type: 'thread.started', thread_id: '01a20fbb-8680-7bc2-9bd4-3e0511b13035' },
  { type: 'turn.started' },
  msg('item_0', 'I’ll read `app.js` and identify the error behavior of `add`.'),
  cmd('item_1', `/bin/zsh -lc "sed -n '1,240p' ${ROOT}/app.js"`, 'item.started'),
  cmd('item_1', `/bin/zsh -lc "sed -n '1,240p' ${ROOT}/app.js"`, 'item.completed', 0, 'export function add…'),
  msg('item_2', '{"summary":"On error, `add` returns `0`.","files":["app.js"]}'),
  { type: 'turn.completed', usage: { input_tokens: 36015, output_tokens: 200 } },
];

test('a spec run: real steps, the session id, and only the last message as the answer', () => {
  const { steps, logs, outcome } = replay(SPEC_RUN);
  assert.deepEqual(steps, ['Reading app.js'], 'one step per item, though it started and completed');
  assert.equal(outcome.threadId, '01a20fbb-8680-7bc2-9bd4-3e0511b13035');
  assert.equal(outcome.completed, true);
  assert.equal(outcome.failure, undefined);
  assert.deepEqual(JSON.parse(outcome.lastMessage ?? ''), { summary: 'On error, `add` returns `0`.', files: ['app.js'] });
  assert.deepEqual(logs, ['I’ll read `app.js` and identify the error behavior of `add`.'], 'the progress note is logged; the JSON answer is not');
});

test('a progress note after the answer would win, so the answer is whatever came last', () => {
  const { outcome } = replay([msg('a', '{"draft":true}'), msg('b', '{"final":true}'), { type: 'turn.completed' }]);
  assert.equal(outcome.lastMessage, '{"final":true}');
});

test('a sync run: reading, editing and running commands become the same steps as Claude’s', () => {
  const file = { path: `${ROOT}/src/app.js`, kind: 'update' };
  const { steps } = replay([
    { type: 'thread.started', thread_id: 't' },
    cmd('item_1', `/bin/zsh -lc "sed -n '1,240p' src/app.js"`, 'item.started'),
    cmd('item_1', `/bin/zsh -lc "sed -n '1,240p' src/app.js"`, 'item.completed', 0),
    { type: 'item.started', item: { id: 'item_2', type: 'file_change', changes: [file], status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [file], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: `${ROOT}/test/new.test.js`, kind: 'add' }, file], status: 'completed' } },
    cmd('item_4', '/bin/zsh -lc "node -e \\"import(\'./app.js\')\\""', 'item.started'),
    cmd('item_5', '/bin/zsh -lc "npm test"', 'item.started'),
    { type: 'turn.completed' },
  ]);
  assert.deepEqual(steps, [
    'Reading src/app.js',
    'Editing src/app.js',
    'Writing test/new.test.js and 1 more',
    `Running node -e "import('./app.js')"`,
    'Running npm test',
  ]);
});

test('a failed turn reports the API’s own sentence, not the JSON around it', () => {
  const api = JSON.stringify({
    type: 'error',
    status: 400,
    error: { type: 'invalid_request_error', message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found' },
  });
  const { logs, outcome } = replay([
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `gpt-x` not found.' } },
    { type: 'turn.started' },
    { type: 'error', message: api },
    { type: 'turn.failed', error: { message: api } },
  ]);
  assert.equal(outcome.completed, false);
  assert.equal(outcome.failure, "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.");
  assert.deepEqual(logs, ['warning: Model metadata for `gpt-x` not found.', `error: ${outcome.failure}`]);
});

test('an error with no turn.failed after it still fails the run; garbage lines go to the log', () => {
  const { logs, outcome } = replay(['not json at all', { type: 'error', message: 'stream disconnected' }]);
  assert.equal(outcome.failure, 'stream disconnected');
  assert.equal(logs[0], 'not json at all');
});

test('a command that fails is logged with its exit code and last line', () => {
  const { logs } = replay([cmd('c', '/bin/zsh -lc "npm test"', 'item.completed', 1, 'ok 1\nnot ok 2 - adds')]);
  assert.deepEqual(logs, ['  failed (exit 1): not ok 2 - adds']);
});

test('commands are described by what they do, with the shell wrapper and repo path removed', () => {
  assert.equal(unwrapShell(`/bin/zsh -lc "rg -n \\"foo bar\\" src"`), 'rg -n "foo bar" src');
  assert.equal(unwrapShell(`bash -c 'ls -la'`), 'ls -la');
  assert.equal(unwrapShell('git status'), 'git status');
  assert.equal(describeCommand(`/bin/zsh -lc "cat ${ROOT}/README.md | head -50"`, ROOT), 'Reading README.md');
  assert.equal(describeCommand(`/bin/zsh -lc "nl -ba src/db.py"`, ROOT), 'Reading src/db.py');
  assert.equal(describeCommand(`/bin/zsh -lc "rg -n \\"claim_job\\" src"`, ROOT), 'Searching for claim_job');
  assert.equal(describeCommand(`/bin/zsh -lc "rg --files ${ROOT}"`, ROOT), 'Listing files');
  assert.equal(describeCommand(`/bin/zsh -lc "ls ${ROOT}/docs"`, ROOT), 'Listing docs');
  assert.equal(describeCommand('/bin/zsh -lc "python -m pytest -q"', ROOT), 'Running python -m pytest -q');
});

test('unwrapError keeps plain messages and digs the sentence out of JSON', () => {
  assert.equal(unwrapError('plain'), 'plain');
  assert.equal(unwrapError('{"message":"inner"}'), 'inner');
  assert.equal(unwrapError('{"error":{"message":"deeper"}}'), 'deeper');
});

test('the spec schema handed to Codex is strict: every object closed, every property required', () => {
  const strict = strictSchema(SPEC_SCHEMA) as Record<string, unknown>;
  assert.equal('$schema' in strict, false);
  let objects = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.properties && typeof o.properties === 'object') {
      objects++;
      assert.equal(o.additionalProperties, false);
      assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties).sort());
    }
    Object.values(o).forEach(walk);
  };
  walk(strict);
  assert.ok(objects >= 5, `walked ${objects} objects`);
  const clause = (((strict.properties as any).sections.items.properties.clauses.items) as Record<string, any>);
  assert.ok(JSON.stringify(clause.properties.riskFlag).includes('null'), 'riskFlag stays nullable, so "required" is honest');
});

test('Codex failures read as one sentence, with the login hint only when it applies', () => {
  const res = { code: 1, stderr: '', timedOut: false };
  assert.equal(describeCodexFailure(res, 'boom', 60_000), 'codex exec could not generate the spec: boom');
  assert.match(describeCodexFailure(res, '401 Unauthorized', 60_000), /Run `codex login`, then retry\.$/);
  assert.match(describeCodexFailure({ ...res, timedOut: true }, undefined, 20 * 60_000), /did not finish within 20 minutes/);
});

/* ---- Which agent runs ---- */

const st = (claude: string, codex: string): ProviderStatuses => {
  const one = (v: string) => ({ installed: v !== 'missing', loggedIn: v === 'ready' });
  return { claude: one(claude), codex: one(codex) };
};

test('plain `redline` prefers Claude Code when it is installed and logged in', () => {
  assert.equal(chooseAgent(undefined, st('ready', 'ready')), 'claude');
  assert.equal(chooseAgent(undefined, st('ready', 'missing')), 'claude');
});

test('plain `redline` falls back to Codex, without comment, when Claude is missing or logged out', () => {
  assert.equal(chooseAgent(undefined, st('loggedout', 'ready')), 'codex');
  assert.equal(chooseAgent(undefined, st('missing', 'ready')), 'codex');
});

test('neither agent ready: one line on how to log in to either; the demo needs none', () => {
  for (const s of [st('missing', 'missing'), st('loggedout', 'loggedout'), st('missing', 'loggedout')]) {
    assert.throws(() => chooseAgent(undefined, s), (err: Error) => err.message === NO_AGENT);
  }
  assert.match(NO_AGENT, /"claude auth login".*"codex login"/);
  assert.equal(chooseAgent(undefined, st('missing', 'missing'), true), 'claude');
});

test('asking for an agent by name gets it, or one actionable line when it is not installed or not logged in', () => {
  assert.equal(chooseAgent('codex', st('ready', 'ready')), 'codex');
  assert.equal(chooseAgent('claude', st('ready', 'ready')), 'claude');
  assert.throws(() => chooseAgent('codex', st('ready', 'loggedout')), (err: Error) => err.message === 'Codex CLI is not logged in. Run "codex login" and try again.');
  assert.throws(() => chooseAgent('codex', st('ready', 'missing')), /^Error: Codex CLI is not installed\. Install it from https:\/\/developers\.openai\.com\/codex\/cli/);
  assert.throws(() => chooseAgent('claude', st('loggedout', 'ready')), (err: Error) => err.message === 'Claude Code is not logged in. Run "claude auth login" and try again.');
  assert.throws(() => chooseAgent('claude', st('missing', 'ready')), /Claude Code is not installed/);
  assert.throws(() => chooseAgent('gemini', st('ready', 'ready')), /Unknown agent "gemini"/);
  assert.equal(chooseAgent('codex', st('missing', 'missing'), true), 'codex', 'the demo takes the name without checking');
});

test('`claude auth status` counts as logged in only when its JSON says so', () => {
  assert.equal(claudeLoggedIn('{"loggedIn":true,"authMethod":"claude.ai"}'), true);
  assert.equal(claudeLoggedIn('{"loggedIn":false,"authMethod":"none"}'), false);
  assert.equal(claudeLoggedIn('{"loggedIn":true,"authMethod":"none"}'), false);
  assert.equal(claudeLoggedIn('Logged in as someone'), true, 'older text output: the exit code decides');
});

test('status checks the binary and the login together, and never logs in when the binary is missing', async () => {
  const bin = tempDir('agents');
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n[ "$1 $2" = "login status" ] && { echo "Not logged in"; exit 1; }\nexit 0\n');
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(bin, 'claude'), 'not executable');
  assert.equal(await onPath('codex', bin), true);
  assert.equal(await onPath('claude', bin), false, 'a file without the executable bit is not an install');
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    assert.deepEqual(await detectProviders(), { claude: { installed: false, loggedIn: false }, codex: { installed: true, loggedIn: false } });
  } finally {
    process.env.PATH = saved;
  }
});
