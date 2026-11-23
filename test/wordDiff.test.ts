import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readableDiff, wordDiff } from '../shared/wordDiff.js';

const join = (parts: { op: string; text: string }[], op: string): string =>
  parts.filter((p) => p.op === op || p.op === 'equal').map((p) => p.text).join('');

test('wordDiff round-trips both sides', () => {
  const a = 'returns 200 OK with an empty body';
  const b = 'returns 502 with the error message';
  const parts = wordDiff(a, b);
  assert.equal(join(parts, 'delete'), a);
  assert.equal(join(parts, 'insert'), b);
});

test('readableDiff keeps a small change local', () => {
  const parts = readableDiff('The handler returns 200 OK on failure.', 'The handler returns 502 on failure.');
  assert.ok(parts.some((p) => p.op === 'equal' && p.text.includes('The handler returns')));
});

test('readableDiff replaces the whole sentence on a rewrite', () => {
  const parts = readableDiff('Files over 50 MB are skipped silently.', 'Every upload is streamed in chunks to disk first.');
  assert.deepEqual(parts.filter((p) => p.text.trim()).map((p) => p.op), ['delete', 'insert']);
});

test('a redline never cuts through a `code span`', () => {
  const before = 'Any error is caught and returns 200 with `{ ok: false }`, with no reason and nothing logged.';
  const after = 'Any error is caught and returns 400 with `{ ok: false, error }`, where `error` is the message.';
  for (const part of readableDiff(before, after)) {
    const ticks = (part.text.match(/`/g) ?? []).length;
    assert.equal(ticks % 2, 0, `unbalanced backticks in ${part.op}: ${part.text}`);
  }
  assert.equal(join(wordDiff(before, after), 'insert'), after, 'still round-trips');
});
