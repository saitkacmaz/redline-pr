import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeStream, describeToolUse } from '../server/providers/claude-stream.js';

test('tool calls read as plain steps, with repo-relative paths', () => {
  assert.equal(describeToolUse('Read', { file_path: '/repo/src/ingest.py' }, '/repo'), 'Reading src/ingest.py');
  assert.equal(describeToolUse('Edit', { file_path: '/repo/db.py' }, '/repo'), 'Editing db.py');
  assert.equal(describeToolUse('Write', { file_path: '/elsewhere/x.md' }, '/repo'), 'Writing /elsewhere/x.md');
  assert.equal(describeToolUse('Bash', { command: 'npm test -- --watch=false\nsecond line' }), 'Running npm test -- --watch=false');
  assert.equal(describeToolUse('Grep', { pattern: 'claimJob' }), 'Searching for claimJob');
  assert.equal(describeToolUse('StructuredOutput', {}), 'Writing the spec');
  assert.equal(describeToolUse('Mystery', {}), 'Using Mystery');
  assert.ok(describeToolUse('Bash', { command: 'x'.repeat(500) }).length <= 80, 'long commands are clipped');
});

test('stream-json chunks split anywhere still yield steps, notes, and the final result', () => {
  const steps: string[] = [];
  const logs: string[] = [];
  const stream = claudeStream('/repo', { onStep: (s) => steps.push(s), onLog: (l) => logs.push(l) });
  const lines = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the handler.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'File does not exist.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.py' } }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done: a.py returns 502.' },
  ];
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  for (let i = 0; i < text.length; i += 7) stream.push(text.slice(i, i + 7));
  assert.deepEqual(steps, ['Reading a.py', 'Editing a.py']);
  assert.deepEqual(logs, ['Looking at the handler.', '  failed: File does not exist.', 'Done: a.py returns 502.'], 'steps are not logged twice');
  assert.equal(stream.result(text)?.result, 'Done: a.py returns 502.');
});

test('closing notes identical to Claude’s last message are logged once', () => {
  const logs: string[] = [];
  const stream = claudeStream(undefined, { onLog: (l) => logs.push(l) });
  stream.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } })}\n`);
  stream.push(`${JSON.stringify({ type: 'result', result: 'All done.' })}\n`);
  assert.deepEqual(logs, ['All done.']);
});

test('plain --output-format json (a single object) still parses as the result', () => {
  const single = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' });
  const stream = claudeStream(undefined, {});
  stream.push(single);
  assert.equal(stream.result(single)?.result, 'Not logged in');
});
