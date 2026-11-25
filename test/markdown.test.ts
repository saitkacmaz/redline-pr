import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommentText } from '../web/src/components/CommentText.js';
import { parseMarkdown } from '../web/src/markdown.js';

const html = (text: string): string => renderToStaticMarkup(createElement(CommentText, { text }));
const text = (t: string) => ({ type: 'text', text: t });

test('italic, bold and inline code render as elements', () => {
  assert.deepEqual(parseMarkdown('pulls money *from* the recipient'), [
    text('pulls money '),
    { type: 'em', children: [text('from')] },
    text(' the recipient'),
  ]);
  assert.equal(html('a **big** _deal_ with `x < y`'), 'a <strong class="font-semibold">big</strong> <em>deal</em> with <code class="font-mono text-[0.875em]">x &lt; y</code>');
  assert.equal(html('*a **b** c*'), '<em>a <strong class="font-semibold">b</strong> c</em>', 'bold nests in italic');
  assert.equal(html('``a `tick` b``'), '<code class="font-mono text-[0.875em]">a `tick` b</code>', 'a longer fence holds backticks');
});

test('unmatched or spaced markers stay literal', () => {
  for (const s of ['2 * 3 * 4', 'a lone * here', '**not closed', 'snake_case_name and __init__ish', 'trailing *', 'a `stray backtick', '* bullet-like']) {
    assert.deepEqual(parseMarkdown(s), [text(s)], s);
  }
  assert.deepEqual(parseMarkdown('\\*not italic\\*'), [text('*not italic*')], 'backslash escapes');
  assert.deepEqual(parseMarkdown('*one\n\ntwo*'), [text('*one\n\ntwo*')], 'emphasis never spans a blank line');
});

test('HTML in a comment is shown as text, never parsed', () => {
  const out = html('<img src=x onerror=alert(1)> **<script>alert(1)</script>** `<b>`');
  assert.ok(!out.includes('<img') && !out.includes('<script') && !out.includes('<b>'), out);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), out);
  assert.ok(out.includes('<strong class="font-semibold">&lt;script&gt;'), out);
});

test('links: only http(s), opened safely, without trailing punctuation', () => {
  assert.deepEqual(parseMarkdown('see [the docs](https://example.com/a_b).'), [
    text('see '),
    { type: 'link', href: 'https://example.com/a_b', children: [text('the docs')] },
    text('.'),
  ]);
  assert.deepEqual(parseMarkdown('(details at https://example.com/x?y=1).'), [
    text('(details at '),
    { type: 'link', href: 'https://example.com/x?y=1', children: [text('https://example.com/x?y=1')] },
    text(').'),
  ]);
  assert.equal(html('https://en.wikipedia.org/wiki/Fold_(higher-order_function)'), '<a href="https://en.wikipedia.org/wiki/Fold_(higher-order_function)" target="_blank" rel="noopener noreferrer" class="underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink">https://en.wikipedia.org/wiki/Fold_(higher-order_function)</a>');
  for (const s of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', 'javascript:alert(1)', 'xhttps://example.com']) {
    assert.ok(!html(s).includes('<a'), s);
  }
  assert.ok(!html('https://example.com/*not_em*').includes('<em>'), 'a URL is not re-parsed for emphasis');
});

test('fenced blocks, such as GitHub suggestions, become one code block', () => {
  assert.deepEqual(parseMarkdown('Try this:\n```suggestion\nconst MAX = 50 * 1024;\n```\nThanks!'), [
    text('Try this:'),
    { type: 'block', text: 'const MAX = 50 * 1024;' },
    text('Thanks!'),
  ]);
  assert.ok(html('```\n<b>*x*</b>\n```').includes('&lt;b&gt;*x*&lt;/b&gt;'), 'nothing inside a block is parsed');
});
