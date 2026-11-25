/**
 * The little of GitHub's comment markdown that reads as noise when left raw: `code`,
 * *italic*, **bold**, [links](https://…), bare https:// URLs, and ``` fenced blocks.
 * Parsed to tokens, rendered as React elements, so nothing in a comment is ever HTML.
 * Anything unmatched (a lone `*`, `2 * 3`, snake_case) stays literal text.
 */
export type Token =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'block'; text: string }
  | { type: 'strong' | 'em'; children: Token[] }
  | { type: 'link'; href: string; children: Token[] };

// A fence opens and closes on its own line; the info string (```suggestion, ```ts) is dropped.
const FENCE = /(?:^|\n)[ \t]*```[^\n`]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?=\n|$)/g;
const PUNCT = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/;
const URL = /^https?:\/\/[^\s<>]+/;

export function parseMarkdown(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    out.push(...parseInline(text.slice(last, m.index).replace(/^\n/, '')));
    out.push({ type: 'block', text: m[1] ?? '' });
    last = m.index + m[0].length;
  }
  out.push(...parseInline(text.slice(last).replace(/^\n/, '')));
  return out;
}

/** Where the closing delimiter of emphasis opened at `i` is, or -1. */
function closer(s: string, i: number, delim: string): number {
  const after = s[i + delim.length];
  if (after === undefined || SPACE.test(after)) return -1;
  if (delim[0] === '_' && WORD.test(s[i - 1] ?? '')) return -1; // snake_case is not emphasis
  for (let j = i + delim.length + 1; j < s.length; j++) {
    if (s.startsWith('\n\n', j)) return -1;
    // A single * skips over a ** pair, so *a **b** c* closes at the end.
    if (delim.length === 1 && s.startsWith(delim + delim, j)) {
      j++;
      continue;
    }
    if (!s.startsWith(delim, j) || SPACE.test(s[j - 1] ?? ' ')) continue;
    if (delim[0] === '_' && WORD.test(s[j + delim.length] ?? '')) continue;
    return j;
  }
  return -1;
}

/** A bare URL without the sentence punctuation after it (and an unbalanced closing paren). */
function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const end = out.at(-1) ?? '';
    const unbalanced = end === ')' && out.split(')').length > out.split('(').length;
    if (!/[.,;:!?'"\]]/.test(end) && !unbalanced) return out;
    out = out.slice(0, -1);
  }
}

function parseInline(s: string, links = true): Token[] {
  const out: Token[] = [];
  let text = '';
  const flush = (): void => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i] ?? '';
    const rest = s.slice(i);

    if (ch === '\\' && PUNCT.test(s[i + 1] ?? '')) {
      text += s[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`';
      let close = s.indexOf(run, i + run.length);
      while (close !== -1 && (s[close + run.length] === '`' || s[close - 1] === '`')) close = s.indexOf(run, close + 1);
      if (close === -1) {
        text += run;
        i += run.length;
        continue;
      }
      let code = s.slice(i + run.length, close);
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
      flush();
      out.push({ type: 'code', text: code });
      i = close + run.length;
      continue;
    }

    if (links && ch === '[') {
      const m = LINK.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'link', href: m[2] ?? '', children: parseInline(m[1] ?? '', false) });
        i += m[0].length;
        continue;
      }
    }

    if (links && ch === 'h' && !WORD.test(s[i - 1] ?? '')) {
      const raw = URL.exec(rest)?.[0];
      const url = raw ? trimUrl(raw) : '';
      if (/^https?:\/\/[^/]/.test(url)) {
        flush();
        out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      const delim = s[i + 1] === ch ? ch + ch : ch;
      const end = closer(s, i, delim);
      if (end !== -1) {
        flush();
        out.push({ type: delim.length === 2 ? 'strong' : 'em', children: parseInline(s.slice(i + delim.length, end), links) });
        i = end + delim.length;
        continue;
      }
      text += delim;
      i += delim.length;
      continue;
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}
