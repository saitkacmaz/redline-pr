import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudget, describeFailure } from '../server/spec.js';
import { parseUnifiedDiff } from '../server/diff.js';

const res = (over: Partial<{ code: number; stdout: string; stderr: string; timedOut: boolean }>) => ({
  code: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
});

test('an error printed only on stdout is shown, with the login hint', () => {
  const msg = describeFailure(res({ stdout: 'Invalid API key · Please run /login' }), undefined);
  assert.match(msg, /Invalid API key/);
  assert.match(msg, /log in/);
});

test('huge stderr is cut to its end', () => {
  const msg = describeFailure(res({ stderr: `${'x'.repeat(2_000_000)}\nError: the real reason` }), undefined);
  assert.ok(msg.length < 2000);
  assert.match(msg, /the real reason$/);
});

test('known failure subtypes read as sentences', () => {
  assert.match(describeFailure(res({ code: 0 }), { subtype: 'error_max_turns' }), /turn limit/);
});

test('usage-limit epochs become a reset time', () => {
  const msg = describeFailure(res({}), { result: 'Claude AI usage limit reached|1764000000' });
  assert.doesNotMatch(msg, /1764000000/);
  assert.match(msg, /resets /);
});

test('a timeout says so and suggests a closer base', () => {
  assert.match(describeFailure(res({ code: 124, timedOut: true }), undefined), /did not finish within 20 minutes/);
});

test('an oversized diff fails fast and names the biggest files', () => {
  const big = `diff --git a/dist/bundle.js b/dist/bundle.js
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1 +1 @@
-a
+${'x'.repeat(700_000)}
`;
  const files = parseUnifiedDiff(big);
  assert.throws(() => checkBudget(files, big), /too large.*\n.*Largest files:\n {2}dist\/bundle\.js/s);
  assert.doesNotThrow(() => checkBudget(files, 'small prompt'));
});
