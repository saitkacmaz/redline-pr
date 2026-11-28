import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../server/exec.js';

test('a timeout stops a process that ignores SIGTERM and is never reported as success', async () => {
  const started = Date.now();
  const res = await run(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    timeoutMs: 300,
  });
  assert.equal(res.timedOut, true);
  assert.equal(res.code, 124);
  assert.match(res.stderr, /timed out/);
  assert.ok(Date.now() - started < 8000);
});

test('a missing binary names the command', async () => {
  await assert.rejects(run('redline-no-such-binary', []), /`redline-no-such-binary` is not installed/);
});

test('stdin is delivered and exit codes pass through', async () => {
  const res = await run(process.execPath, ['-e', "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => process.exit(3))"], {
    input: 'hello',
  });
  assert.equal(res.stdout, 'HELLO');
  assert.equal(res.code, 3);
  assert.equal(res.timedOut, false);
});

test('a timeout still fires when the leader exited but a descendant holds the pipes', async () => {
  const started = Date.now();
  // The leader starts a grandchild that inherits its pipes, prints, and exits at once.
  const grandchild = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }).unref(); console.log('hi')`;
  const res = await run(process.execPath, ['-e', grandchild], { timeoutMs: 400 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});
