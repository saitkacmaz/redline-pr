import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, chromePath } from './browser.js';
import { boot, type Running } from './cli-harness.js';
import { tempDir } from './helpers.js';

/** The rendered sentences on the page (the focusable view spans). */
const SENTENCES = `[...document.querySelectorAll('main p > span[tabindex="0"]')]`;
const sentence = (needle: string): string => `${SENTENCES}.find((el) => el.textContent.includes(${JSON.stringify(needle)}))`;
const TEXTBOX = `document.querySelector('[role=textbox]')`;

describe('editing in the browser (demo)', { skip: chromePath ? false : 'no Chrome/Chromium found' }, () => {
  let server: Running;
  let page: Browser;

  before(async () => {
    server = await boot(['--demo'], { cwd: tempDir('ui'), env: { XDG_CACHE_HOME: tempDir('cache') } });
    page = await Browser.launch();
  });
  after(async () => {
    await page?.close();
    await server?.stop();
  });

  const fresh = async (): Promise<void> => {
    // Let the app finish loading (it saves drafts on load) before clearing them.
    await page.goto(server.url);
    await page.waitFor(`${SENTENCES}.length > 0`);
    await page.eval('localStorage.clear()');
    await page.goto(server.url);
    await page.waitFor(`${SENTENCES}.length > 0`);
  };

  test('Enter keeps an edit and the sentence renders exactly once', async () => {
    await fresh();
    const original = await page.eval<string>(`${sentence('always returns HTTP 200')}.textContent`);
    await page.clickEl(sentence('always returns HTTP 200'));
    await page.waitFor(TEXTBOX);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 4 });
    await page.type(' Unless nothing was ingested.');
    await page.key('Enter');
    await page.waitFor(`!${TEXTBOX}`);

    const shown = await page.eval<string>(`${sentence('always returns HTTP 200')}.textContent`);
    assert.equal(shown.split('always returns HTTP 200').length - 1, 1, `sentence duplicated: ${shown}`);
    assert.ok(!shown.includes('`'), 'backticks render as code, not raw');
    assert.ok(shown.length > original.length);
    assert.match(await page.eval<string>(`document.querySelector('header').innerText`), /1 edit\b/);
    assert.equal(await page.eval<boolean>(`document.activeElement === ${sentence('always returns HTTP 200')}`), true, 'focus returns to the sentence');
  });

  test('Escape cancels the edit and restores the original text', async () => {
    await fresh();
    const original = await page.eval<string>(`${sentence('always returns HTTP 200')}.textContent`);
    await page.clickEl(sentence('always returns HTTP 200'));
    await page.waitFor(TEXTBOX);
    await page.type(' XYZ');
    await page.key('Escape');
    await page.waitFor(`!${TEXTBOX}`);
    assert.equal(await page.eval<string>(`${sentence('always returns HTTP 200')}.textContent`), original);
    assert.match(await page.eval<string>(`document.querySelector('header').innerText`), /0 edits/);
    assert.equal(await page.eval<boolean>(`document.activeElement === ${sentence('always returns HTTP 200')}`), true);
  });

  test('drag-selecting text in a sentence does not start editing', async () => {
    await fresh();
    const r = await page.eval<{ x: number; y: number; w: number }>(
      `(() => { const el = ${sentence('always returns HTTP 200')}; el.scrollIntoView({ block: 'center' }); const b = el.getClientRects()[0]; return { x: b.left + 4, y: b.top + b.height / 2, w: b.width }; })()`,
    );
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + r.w / 2, y: r.y, button: 'left', buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + r.w / 2, y: r.y, button: 'left', clickCount: 1 });
    assert.equal(await page.eval<boolean>(`!!${TEXTBOX}`), false, 'no edit mode');
    assert.ok((await page.eval<string>('getSelection().toString()')).length > 5, 'text is selected');
  });

  test('margin notes align with their sentence and never overlap', async () => {
    await fresh();
    const boxes = await page.eval<{ note: number; sentence: number; bottom: number }[]>(`
      [...document.querySelectorAll('[data-for]')].map((n) => ({
        note: n.getBoundingClientRect().top,
        bottom: n.getBoundingClientRect().bottom,
        sentence: document.querySelector('[data-clause="' + n.dataset.for + '"]').getBoundingClientRect().top,
      }))`);
    assert.equal(boxes.length, 3);
    for (const b of boxes) assert.ok(b.note >= b.sentence - 1 && b.note - b.sentence < 8, `note at ${b.note}, sentence at ${b.sentence}`);
    const sorted = [...boxes].sort((a, b) => a.note - b.note);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i]!.note >= sorted[i - 1]!.bottom, 'notes overlap');
  });

  test('the Sync sheet takes focus, keeps replies on Escape, and returns focus on close', async () => {
    await fresh();
    // Each comment renders inline (narrow screens) and in the margin; use the visible one.
    await page.eval(`[...document.querySelectorAll('textarea[aria-label^="Reply to maya-chen"]')].find((t) => t.offsetParent).focus()`);
    await page.type('Agreed, switching to 502.');
    await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync')`);
    await page.waitFor(`document.activeElement?.id === 'sync-title'`);
    await page.waitFor(`document.querySelector('[role=dialog] textarea')`);

    const sheet = await page.eval<string>(`document.querySelector('[role=dialog]').innerText`);
    assert.match(sheet, /No sentences edited/);
    assert.equal(await page.eval<string>(`document.querySelector('[role=dialog] textarea').value`), 'Agreed, switching to 502.', 'the margin reply shows in the sheet');
    assert.match(sheet, /Posting is off in the demo/);
    assert.doesNotMatch(sheet, /Updated so that/);
    assert.equal(await page.eval<boolean>(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Run with Claude Code').disabled`), true);
    assert.equal(await page.eval<boolean>(`document.querySelector('main').closest('[inert]') !== null`), true, 'page behind is inert');

    await page.eval(`document.querySelector('[role=dialog] textarea').focus()`);
    await page.key('Escape');
    assert.equal(await page.eval<boolean>(`!!document.querySelector('[role=dialog]')`), true, 'Escape in a reply does not close');
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[role=dialog]')`);
    await page.waitFor(`document.activeElement?.textContent === 'Sync'`);
  });

  test('a demo run writes the plan instead of running and says so', async () => {
    await fresh();
    await page.clickEl(sentence('always returns HTTP 200'));
    await page.waitFor(TEXTBOX);
    await page.type(' Unless nothing was ingested.');
    await page.key('Enter');
    await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync')`);
    await page.waitFor(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Run with Claude Code' && !b.disabled)`);
    await page.clickEl(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Run with Claude Code')`);
    await page.waitFor(`document.querySelector('[role=dialog]').innerText.includes('Demo mode: wrote the plan')`);

    // The run is done, so the next step is right there: re-analyze, in place.
    const reanalyze = `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Re-analyze diff')`;
    await page.waitFor(reanalyze);
    await page.clickEl(reanalyze);
    await page.waitFor(`!document.querySelector('[role=dialog]')`);
    await page.waitFor(`document.querySelector('header').innerText.includes('0 edits')`);
    assert.equal(await page.eval<boolean>(`${SENTENCES}.length > 0`), true, 'a fresh spec is shown');
    assert.equal(
      await page.eval<boolean>(`!!document.querySelector('header [aria-hidden=true] > .bg-ink')`),
      true,
      'the hairline settles to a solid ink line when the reload is done',
    );
  });

  test('the PR title opens a quiet switcher; Escape closes it and returns focus', async () => {
    await fresh();
    const trigger = `document.querySelector('header button[aria-haspopup=menu]')`;
    assert.match(await page.eval<string>(`${trigger}.textContent`), /#1287/);
    await page.clickEl(trigger);
    await page.waitFor(`document.querySelector('[role=menu]')?.innerText.includes('The demo has one PR')`);
    assert.equal(await page.eval<string>(`${trigger}.getAttribute('aria-expanded')`), 'true');
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[role=menu]')`);
    assert.equal(await page.eval<boolean>(`document.activeElement === ${trigger}`), true);
  });

  test('Refresh reloads in place and keeps unsaved redlines', async () => {
    await fresh();
    await page.clickEl(sentence('always returns HTTP 200'));
    await page.waitFor(TEXTBOX);
    await page.type(' Kept.');
    await page.key('Enter');
    await page.waitFor(`document.querySelector('header').innerText.includes('1 edit')`);
    await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Refresh')`);
    await page.waitFor(`document.querySelector('header').innerText.includes('Ready') || !document.querySelector('main [inert]')`);
    await page.waitFor(`${sentence('Kept.')}`);
    assert.match(await page.eval<string>(`document.querySelector('header').innerText`), /1 edit\b/);
  });

  test('a server that has stopped is named as such, not "Failed to fetch"', async () => {
    await fresh();
    // Point the page's requests at a port nothing listens on, as if redline had exited.
    await page.eval(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).startsWith('/api/plan') ? real('http://127.0.0.1:9/api/plan', o) : real(u, o); })()`);
    await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync')`);
    await page.waitFor(`document.querySelector('[role=dialog] [role=alert]')`);
    const text = await page.eval<string>(`document.querySelector('[role=dialog] [role=alert]').textContent`);
    assert.match(text, /Can’t reach redline\. It has probably stopped/);
    assert.doesNotMatch(text, /Failed to fetch/);
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[role=dialog]')`);
    await page.goto(server.url);
  });

  test('the page logs no errors', () => {
    assert.deepEqual(page.errors, []);
  });
});
