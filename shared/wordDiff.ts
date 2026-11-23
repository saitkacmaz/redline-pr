export type DiffOp = 'equal' | 'delete' | 'insert';

export interface DiffPart {
  op: DiffOp;
  text: string;
}

/**
 * Split into words and whitespace. A `code span` is one token even if it has spaces,
 * so a redline never cuts through code and leaves stray backticks behind.
 */
function tokenize(text: string): string[] {
  return text.match(/`[^`]*`|\s+|[^\s`]+|`/g) ?? [];
}

/**
 * Word-level LCS diff. Sentences are short (one clause), so the O(n*m)
 * table is cheap and gives a stable, readable redline.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }

  const parts: DiffPart[] = [];
  const push = (op: DiffOp, text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.text += text;
    else parts.push({ op, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i] as string;
    const bj = b[j] as string;
    if (ai === bj) {
      push('equal', ai);
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      push('delete', ai);
      i++;
    } else {
      push('insert', bj);
      j++;
    }
  }
  while (i < a.length) push('delete', a[i++] as string);
  while (j < b.length) push('insert', b[j++] as string);
  return parts;
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/**
 * A diff tuned for reading: each changed region becomes one deletion followed
 * by one insertion (short shared words inside a region are absorbed), and a
 * mostly-rewritten sentence is shown as a whole strike-and-replace.
 */
export function readableDiff(before: string, after: string): DiffPart[] {
  const raw = wordDiff(before, after);
  const kept = raw.filter((p) => p.op === 'equal').reduce((n, p) => n + words(p.text), 0);
  if (kept / Math.max(words(before), words(after), 1) < 0.4) {
    return [
      { op: 'delete', text: before },
      { op: 'equal', text: ' ' },
      { op: 'insert', text: after },
    ];
  }

  const out: DiffPart[] = [];
  let del = '';
  let ins = '';
  const flush = (): void => {
    if (del.trim()) out.push({ op: 'delete', text: del.trim() });
    if (del.trim() && ins.trim()) out.push({ op: 'equal', text: ' ' });
    if (ins.trim()) out.push({ op: 'insert', text: ins.trim() });
    del = '';
    ins = '';
  };

  raw.forEach((part, i) => {
    const inRegion = del !== '' || ins !== '';
    const next = raw[i + 1];
    // A lone short word between two changes reads better as part of the change.
    const absorb = part.op === 'equal' && inRegion && next !== undefined && words(part.text) <= 1;
    if (part.op === 'delete' || absorb) del += part.text;
    if (part.op === 'insert' || absorb) ins += part.text;
    if (part.op === 'equal' && !absorb) {
      flush();
      out.push(part);
    }
  });
  flush();
  return out;
}
