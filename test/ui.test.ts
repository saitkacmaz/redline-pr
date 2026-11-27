import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, chromePath } from './browser.js';
import { boot, type Running } from './cli-harness.js';
import { fakeClaude, fakeCodex, isolatedPath, makeRepo, tempDir } from './helpers.js';

/** The rendered sentences on the page (the focusable view spans). */
const SENTENCES = `[...document.querySelectorAll('main p > span[tabindex="0"]')]`;
const sentence = (needle: string): string => `${SENTENCES}.find((el) => el.textContent.includes(${JSON.stringify(needle)}))`;
const TEXTBOX = `document.querySelector('[role=textbox]')`;

describe('editing in the browser (demo)', { skip: chromePath ? false : 'no Chrome/Chromium found' }, () => {
  let server: Running;
  let page: Browser;

  before(async () => {
    // Both agents "installed" (as fakes the demo never runs), so the Sync view offers the switch.
    const { binDir } = fakeClaude({});
    fakeCodex({}, { binDir });
    server = await boot(['--demo'], { cwd: tempDir('ui'), env: { XDG_CACHE_HOME: tempDir('cache'), PATH: isolatedPath(binDir) } });
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
    // Each note sits level with its sentence, or 16px under the note above if that one runs long.
    const sorted = [...boxes].sort((a, b) => a.note - b.note);
    sorted.forEach((b, i) => {
      const prev = sorted[i - 1];
      const want = Math.max(b.sentence, prev ? prev.bottom + 16 : -Infinity);
      assert.ok(Math.abs(b.note - want) < 3, `note at ${b.note}, expected ${want} (sentence at ${b.sentence})`);
      if (prev) assert.ok(b.note >= prev.bottom, 'notes overlap');
    });
  });

  test('the Sync view takes focus, keeps replies on Escape, and returns focus when leaving', async () => {
    await fresh();
    // Each comment renders inline (narrow screens) and in the margin; use the visible one.
    await page.eval(`[...document.querySelectorAll('textarea[aria-label^="Reply to maya-chen"]')].find((t) => t.offsetParent).focus()`);
    await page.type('Agreed, switching to 502.');
    await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync')`);
    await page.waitFor(`document.activeElement?.id === 'sync-title'`);
    await page.waitFor(`document.querySelector('[data-view=sync] textarea')`);

    const sheet = await page.eval<string>(`document.querySelector('[data-view=sync]').innerText`);
    assert.match(sheet, /No sentences edited/);
    assert.equal(await page.eval<string>(`document.querySelector('[data-view=sync] textarea').value`), 'Agreed, switching to 502.', 'the margin reply shows in the sheet');
    assert.match(sheet, /Posting is off in the demo/);
    assert.doesNotMatch(sheet, /Updated so that/);
    assert.equal(await page.eval<boolean>(`[...document.querySelectorAll('[data-view=sync] button')].find((b) => b.textContent === 'Run with Claude').disabled`), true);
    assert.equal(await page.eval<boolean>(`document.querySelector('[data-clause]').closest('[hidden]') !== null`), true, 'the spec is out of view, not under an overlay');
    assert.equal(await page.eval<string>('location.hash'), '#sync');

    await page.eval(`document.querySelector('[data-view=sync] textarea').focus()`);
    await page.key('Escape');
    assert.equal(await page.eval<boolean>(`!!document.querySelector('[data-view=sync]')`), true, 'Escape in a reply does not close');
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-view=sync]')`);
    await page.waitFor(`document.activeElement?.textContent === 'Sync'`);
  });

  test('a demo run writes the plan instead of running and says so', async () => {
    await fresh();
    await page.clickEl(sentence('always returns HTTP 200'));
    await page.waitFor(TEXTBOX);
    await page.type(' Unless nothing was ingested.');
    await page.key('Enter');
    await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync')`);
    await page.waitFor(`[...document.querySelectorAll('[data-view=sync] button')].find((b) => b.textContent === 'Run with Claude' && !b.disabled)`);
    await page.clickEl(`[...document.querySelectorAll('[data-view=sync] button')].find((b) => b.textContent === 'Run with Claude')`);
    await page.waitFor(`document.querySelector('[data-view=sync]').innerText.includes('Demo mode: wrote the plan')`);

    // The run is done, so the next step is right there: re-analyze, in place.
    const reanalyze = `[...document.querySelectorAll('[data-view=sync] button')].find((b) => b.textContent === 'Re-analyze diff')`;
    await page.waitFor(reanalyze);
    await page.clickEl(reanalyze);
    await page.waitFor(`!document.querySelector('[data-view=sync]')`);
    await page.waitFor(`document.querySelector('header').innerText.includes('0 edits')`);
    assert.equal(await page.eval<boolean>(`${SENTENCES}.length > 0`), true, 'a fresh spec is shown');
    assert.equal(
      await page.eval<boolean>(`!!document.querySelector('header [aria-hidden=true] > .bg-ink')`),
      true,
      'the hairline settles to a solid ink line when the reload is done',
    );
  });

  test('Sync offers Run with Claude (solid) and Run with Codex (outline); a click locks both at once', async () => {
    await fresh();
    await page.clickEl(sentence('always returns HTTP 200'));
    await page.waitFor(TEXTBOX);
    await page.type(' Unless nothing was ingested.');
    await page.key('Enter');
    await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync')`);
    const RUNS = `[...document.querySelectorAll('[data-view=sync] button[data-agent]')]`;
    await page.waitFor(`${RUNS}.length === 2 && ${RUNS}.every((b) => !b.disabled)`);
    assert.equal(await page.eval<string>(`${RUNS}.map((b) => b.textContent).join(' | ')`), 'Run with Claude | Run with Codex');
    const look = `${RUNS}.map((b) => { const c = getComputedStyle(b); return [c.backgroundColor, c.color, c.borderTopColor, c.borderTopWidth, c.boxShadow].join(' '); })`;
    const [claude, codex] = await page.eval<string[]>(look);
    assert.match(claude ?? '', /^rgb\(20, 20, 19\) rgb\(252, 252, 251\) .* none$/, 'primary: flat ink, paper text, no shadow');
    assert.equal(codex, 'rgb(252, 252, 251) rgb(20, 20, 19) rgb(212, 212, 208) 1px none', 'secondary: paper, ink text, 1px #D4D4D0 outline');
    assert.equal(await page.eval<boolean>(`${RUNS}.every((b) => !b.title && !b.querySelector('svg, img'))`), true, 'no titles or icons when both are usable');
    assert.equal(
      await page.eval<string>(`[...document.querySelectorAll('[data-view=sync] button')].find((b) => b.textContent === 'Copy spec diff').className.includes('border')`),
      false,
      'Copy spec diff is a quiet text link',
    );

    // Two clicks in the same instant (before React can re-render): the second is ignored, so
    // only Codex starts; once React has applied the click, both buttons are off.
    const afterClick = await page.eval<string>(
      `(async () => { const runs = ${RUNS}; runs[1].click(); runs[0].click(); await new Promise((r) => setTimeout(r, 0)); return ${RUNS}.map((b) => b.textContent + ':' + b.disabled).join(' | '); })()`,
    );
    assert.equal(afterClick, 'Run with Claude:true | Running Codex…:true');
    await page.waitFor(`document.querySelector('[data-view=sync]').innerText.includes('instead of running Codex')`);

    const reanalyze = `[...document.querySelectorAll('[data-view=sync] button')].find((b) => b.textContent === 'Re-analyze diff')`;
    await page.waitFor(reanalyze);
    await page.clickEl(reanalyze);
    await page.waitFor(`!document.querySelector('[data-view=sync]')`);
  });

  test('responsive: fixed columns, fluid columns, then one column with inline hairline comments; never a sideways scroll', async () => {
    await fresh();
    const measure = `(() => {
      const box = (el) => el.getBoundingClientRect();
      const rail = document.querySelector('[data-for]').parentElement;
      const railOn = getComputedStyle(rail).display !== 'none';
      const notes = railOn
        ? [...rail.querySelectorAll('[data-for]')].map((n) => ({ top: box(n).top, bottom: box(n).bottom, want: box(document.querySelector('[data-clause="' + n.dataset.for + '"]')).top })).sort((a, b) => a.top - b.top)
        : [];
      const inline = [...document.querySelectorAll('[data-clause] aside')].filter((a) => getComputedStyle(a).display !== 'none');
      const sync = [...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync');
      const prose = document.querySelector('[data-clause]').closest('section').parentElement;
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        railOn,
        proseWidth: Math.round(box(prose).width),
        railWidth: railOn ? Math.round(box(rail).width) : 0,
        aligned: notes.every((n) => n.top >= n.want - 1),
        overlap: notes.some((n, i) => i > 0 && n.top < notes[i - 1].bottom),
        inline: inline.length,
        inlineBorder: inline[0] ? getComputedStyle(inline[0]).borderLeft : '',
        syncVisible: box(sync).right <= innerWidth,
      };
    })()`;
    type M = { overflow: number; railOn: boolean; proseWidth: number; railWidth: number; aligned: boolean; overlap: boolean; inline: number; inlineBorder: string; syncVisible: boolean };
    const at = async (width: number, height: number): Promise<M> => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      // One frame for the resize, one for the rAF-batched note placement.
      await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      return page.eval<M>(measure);
    };
    try {
      // The same page, resized, without a reload: notes must follow their sentences.
      const wide = await at(1440, 900);
      assert.deepEqual([wide.overflow, wide.railOn, wide.proseWidth, wide.railWidth, wide.aligned, wide.overlap, wide.inline], [0, true, 680, 340, true, false, 0]);
      const between = await at(1024, 480);
      assert.equal(between.overflow, 0, 'the old fixed 1120px grid overflowed here');
      const split = await at(960, 800);
      assert.deepEqual([split.overflow, split.railOn, split.aligned, split.overlap], [0, true, true, false]);
      assert.equal(split.railWidth, 300);
      assert.equal(split.proseWidth, 960 - 48 - 32 - 300, 'the prose takes the rest');
      const edge = await at(860, 800);
      assert.deepEqual([edge.overflow, edge.railOn, edge.railWidth, edge.aligned], [0, true, 300, true]);
      const narrow = await at(600, 700);
      assert.deepEqual([narrow.overflow, narrow.railOn, narrow.inline, narrow.syncVisible], [0, false, 3, true]);
      assert.equal(narrow.inlineBorder, '2px solid rgb(230, 230, 227)');
      const phone = await at(360, 700);
      assert.deepEqual([phone.overflow, phone.syncVisible], [0, true]);
      const back = await at(1440, 900);
      assert.deepEqual([back.railOn, back.aligned, back.overlap, back.inline], [true, true, false, 0], 'and back again');
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride', {});
    }
  });

  test('on a short pane the PR list stays inside the window and scrolls within itself', async () => {
    await fresh();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 300, deviceScaleFactor: 1, mobile: false });
    try {
      const trigger = `document.querySelector('header button[aria-haspopup=menu]')`;
      await page.clickEl(trigger);
      await page.waitFor(`document.querySelector('[role=menu]')`);
      const menu = await page.eval<{ bottom: number; right: number; overflowY: string; maxHeight: string }>(
        `(() => { const m = document.querySelector('[role=menu]'); const b = m.getBoundingClientRect(); const c = getComputedStyle(m); return { bottom: b.bottom, right: b.right, overflowY: c.overflowY, maxHeight: c.maxHeight }; })()`,
      );
      assert.ok(menu.bottom <= 300, `menu ends at ${menu.bottom}`);
      assert.ok(menu.right <= 1024);
      assert.equal(menu.overflowY, 'auto');
      assert.equal(menu.maxHeight, '228px', '100dvh - 72px');
      await page.key('Escape');
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride', {});
    }
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

  test('anchors show the directory in faint ink and the file and lines in anchor ink, the same in the hunk peek', async () => {
    await fresh();
    const anchor = `document.querySelector('[data-clause] button[data-file]')`;
    const parts = await page.eval<{ dir: string; dirColor: string; name: string; file: string }>(
      `(() => { const b = ${anchor}; const [dir, name] = b.children; return { dir: dir.textContent, dirColor: getComputedStyle(dir).color, name: name.textContent, file: b.dataset.file }; })()`,
    );
    assert.equal(parts.file, 'services/ingest/handler.py');
    assert.equal(parts.dir, 'services/ingest/');
    assert.equal(parts.dirColor, 'rgb(163, 163, 158)', 'the faint token');
    assert.match(parts.name, /^handler\.py:\d+(–\d+)?$/);
    await page.clickEl(anchor);
    const peek = `[...document.querySelectorAll('[data-clause] div')].find((d) => d.className.includes('border-ink/80'))`;
    await page.waitFor(peek);
    assert.equal(await page.eval<string>(`${peek}.firstElementChild.textContent`), parts.dir + parts.name);
  });

  test('N files opens an indented list by directory; a file jumps to its first sentence; Esc and outside clicks close it', async () => {
    await fresh();
    const trigger = `[...document.querySelectorAll('header button')].find((b) => / files?$/.test(b.textContent))`;
    const menu = `document.querySelector('[role=menu][aria-label="Changed files"]')`;
    assert.equal(await page.eval<string>(`${trigger}.textContent`), '3 files');

    await page.clickEl(trigger);
    await page.waitFor(menu);
    const rows = await page.eval<{ text: string; pad: string }[]>(`[...${menu}.children].map((r) => ({ text: r.innerText.replace(/\\s+/g, ' ').trim(), pad: r.style.paddingLeft }))`);
    assert.deepEqual(rows.map((r) => r.text.replace(/ [+-]\d+.*$/, '')), ['migrations/', '0042_ingest_jobs.sql', 'services/ingest/', 'handler.py', 'jobs.py']);
    assert.deepEqual(rows.map((r) => r.pad), ['16px', '32px', '16px', '32px', '32px'], 'pure indentation');
    assert.ok(rows.every((r) => !/[├└│]/.test(r.text)), 'no tree connectors');
    assert.match(rows[3]?.text ?? '', /^handler\.py \+\d+$/, 'line counts; a new file has no deletions to show');

    await page.key('Escape');
    await page.waitFor(`!${menu}`);
    assert.equal(await page.eval<boolean>(`document.activeElement === ${trigger}`), true, 'Escape returns focus');

    await page.clickEl(trigger);
    await page.waitFor(menu);
    await page.click(5, 400);
    await page.waitFor(`!${menu}`);

    await page.eval('window.scrollTo(0, 0)');
    await page.clickEl(trigger);
    await page.waitFor(menu);
    await page.clickEl(`[...${menu}.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.startsWith('jobs.py'))`);
    await page.waitFor(`!${menu} && document.activeElement?.dataset.file === 'services/ingest/jobs.py'`);
    await page.waitFor(`(() => { const r = document.activeElement.getBoundingClientRect(); return r.top > 48 && r.bottom < innerHeight; })()`);
  });

  test('the Files list fits wide, split-screen, narrow and phone windows, never scrolling the page sideways', async () => {
    await fresh();
    const trigger = `[...document.querySelectorAll('header button')].find((b) => / files?$/.test(b.textContent))`;
    const menu = `document.querySelector('[role=menu][aria-label="Changed files"]')`;
    try {
      for (const width of [1440, 960, 600, 360]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
        await page.eval('window.scrollTo(0, 0)');
        await page.clickEl(trigger);
        await page.waitFor(menu);
        const m = await page.eval<{ left: number; right: number; width: number; overflow: number }>(
          `(() => { const b = ${menu}.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, overflow: document.documentElement.scrollWidth - innerWidth }; })()`,
        );
        assert.ok(m.left >= 0 && m.right <= width, `${width}px: menu at ${m.left}–${m.right}`);
        assert.equal(m.width, Math.min(380, width - 32), `${width}px: min(380px, 100vw - 32px)`);
        assert.equal(m.overflow, 0, `${width}px: no sideways scroll`);
        await page.key('Escape');
        await page.waitFor(`!${menu}`);
      }
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride', {});
    }
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

  test('Sync is a page in history: browser Back returns to the spec with edits and scroll intact', async () => {
    await fresh();
    await page.clickEl(sentence('always returns HTTP 200'));
    await page.waitFor(TEXTBOX);
    await page.type(' Unless nothing was ingested.');
    await page.key('Enter');
    await page.eval(`window.scrollTo(0, 600)`);
    const scrolled = await page.eval<number>('window.scrollY');
    // Click without the helper's scrollIntoView, which would move the page before Sync opens.
    await page.eval(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync').click()`);
    await page.waitFor(`document.querySelector('[data-view=sync]')`);
    assert.equal(await page.eval<string>('location.hash'), '#sync');

    await page.eval('history.back()');
    await page.waitFor(`!document.querySelector('[data-view=sync]')`);
    assert.equal(await page.eval<string>('location.hash'), '');
    assert.match(await page.eval<string>(`document.querySelector('header').innerText`), /1 edit\b/, 'the edit survived');
    const restored = await page.eval<number>('window.scrollY');
    assert.ok(Math.abs(restored - scrolled) < 2, `scroll position came back: left at ${scrolled}, back at ${restored}`);
    await page.waitFor(`document.activeElement?.textContent === 'Sync'`);

    // Forward reopens it; the quiet link goes back too.
    await page.eval('history.forward()');
    await page.waitFor(`document.querySelector('[data-view=sync]')`);
    await page.clickEl(`[...document.querySelectorAll('[data-view=sync] button')].find((b) => b.textContent.includes('Back to spec'))`);
    await page.waitFor(`!document.querySelector('[data-view=sync]')`);
  });

  test('a tall margin thread or an open code peek never opens a gap between sentences', async () => {
    await fresh();
    const tops = `[...document.querySelectorAll('[data-clause]')].map((el) => Math.round(el.getBoundingClientRect().top + scrollY))`;
    const before = await page.eval<number[]>(tops);
    const proseHeight = `document.querySelector('[data-clause]').parentElement.closest('section').parentElement.getBoundingClientRect().height`;
    const heightBefore = await page.eval<number>(proseHeight);

    // Expand the longest thread in the margin: only the margin may move.
    const toggle = `document.querySelector('aside[data-for] button[aria-expanded]')`;
    assert.equal(await page.eval<string>(`${toggle}.textContent`), '2 replies');
    await page.clickEl(toggle);
    await page.waitFor(`${toggle}.getAttribute('aria-expanded') === 'true'`);
    assert.match(await page.eval<string>(`${toggle}.closest('aside').innerText`), /One worker today|only run one worker/, 'the middle reply is shown in place');
    assert.deepEqual(await page.eval<number[]>(tops), before, 'no sentence moved');
    assert.equal(await page.eval<number>(proseHeight), heightBefore, 'the prose column did not grow');
    const notes = await page.eval<{ top: number; bottom: number }[]>(`[...document.querySelectorAll('aside[data-for]')].map((n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }).sort((a, b) => a.top - b.top)`);
    for (let i = 1; i < notes.length; i++) assert.ok(notes[i]!.top >= notes[i - 1]!.bottom, 'notes never overlap');

    // Opening a code peek pushes only what follows, by exactly the peek's height: the 20px rhythm holds.
    const gaps = `(() => { const els = [...document.querySelectorAll('[data-clause]')]; return els.slice(1).map((el, i) => Math.round(el.getBoundingClientRect().top - els[i].getBoundingClientRect().bottom)); })()`;
    const gapsBefore = await page.eval<number[]>(gaps);
    await page.clickEl(`document.querySelector('[data-clause] button[aria-expanded]')`);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(await page.eval<number[]>(gaps), gapsBefore, 'every gap between adjacent sentences is unchanged');
    assert.ok(gapsBefore.every((g) => g <= 20 || g > 60), `sentence rhythm is tight within sections: ${gapsBefore.join(',')}`);
  });

  test('resolved and outdated threads are one muted line, expandable, and threads you answered say so', async () => {
    await fresh();
    const link = `[...document.querySelectorAll('button')].find((b) => b.textContent === '2 resolved/outdated hidden')`;
    assert.equal(await page.eval<boolean>(`!!${link}`), true);
    assert.equal(await page.eval<boolean>(`document.body.innerText.includes('Typo in the log message')`), false, 'hidden by default');
    await page.clickEl(link);
    await page.waitFor(`document.body.innerText.includes('Typo in the log message')`);
    assert.match(await page.eval<string>('document.body.innerText'), /resolved · 1 reply/);
    assert.match(await page.eval<string>(`[...document.querySelectorAll('aside[data-for]')].map((n) => n.innerText).join('\\n')`), /@maya-chen\s+services\/ingest\/handler\.py:52\s+replied/);
  });

  test('a server that has stopped is named as such, not "Failed to fetch"', async () => {
    await fresh();
    // Point the page's requests at a port nothing listens on, as if redline had exited.
    await page.eval(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).startsWith('/api/plan') ? real('http://127.0.0.1:9/api/plan', o) : real(u, o); })()`);
    await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync')`);
    await page.waitFor(`document.querySelector('[data-view=sync] [role=alert]')`);
    const text = await page.eval<string>(`document.querySelector('[data-view=sync] [role=alert]').textContent`);
    assert.match(text, /Can’t reach redline\. It has probably stopped/);
    assert.doesNotMatch(text, /Failed to fetch/);
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-view=sync]')`);
    await page.goto(server.url);
  });

  test('the page logs no errors', () => {
    assert.deepEqual(page.errors, []);
  });
});

describe('an agent that is not logged in (real repo)', { skip: chromePath ? false : 'no Chrome/Chromium found' }, () => {
  test('its Run button is visibly off, with the reason in a native title', async () => {
    const spec = {
      sections: [{ title: 'Addition', clauses: [{ id: 's1-c1', text: 'If adding throws, `add` returns 0.', anchors: [{ file: 'src/app.js', startLine: 2, endLine: 5 }], riskFlag: null }] }],
      commentMap: [],
    };
    const { binDir } = fakeClaude(spec);
    fakeCodex(spec, { binDir, loggedIn: false });
    const server = await boot([], { cwd: makeRepo(), env: { XDG_CACHE_HOME: tempDir('cache'), PATH: isolatedPath(binDir) } });
    const page = await Browser.launch();
    try {
      await page.goto(server.url);
      await page.waitFor(`${SENTENCES}.length > 0`);
      await page.clickEl(sentence('returns 0'));
      await page.waitFor(TEXTBOX);
      await page.type(' Or rethrows.');
      await page.key('Enter');
      await page.clickEl(`[...document.querySelectorAll('header button')].find((b) => b.textContent === 'Sync')`);
      const codex = `document.querySelector('[data-view=sync] button[data-agent=codex]')`;
      await page.waitFor(`${codex} && !document.querySelector('[data-view=sync] button[data-agent=claude]').disabled`);
      assert.equal(await page.eval<boolean>(`${codex}.disabled`), true);
      assert.equal(await page.eval<string>(`${codex}.title`), 'Codex CLI not logged in');
      assert.equal(
        await page.eval<string>(`(() => { const c = getComputedStyle(${codex}); return [c.color, c.borderTopColor, c.cursor].join(' '); })()`),
        'rgb(163, 163, 158) rgb(230, 230, 227) not-allowed',
      );
      assert.equal(await page.eval<string>(`document.querySelector('[data-view=sync] button[data-agent=claude]').textContent`), 'Run with Claude');
      assert.doesNotMatch(await page.eval<string>(`document.querySelector('[data-view=sync]').innerText`), /not logged in/, 'no banner: the title says it');
    } finally {
      await page.close();
      await server.stop();
    }
  });
});
