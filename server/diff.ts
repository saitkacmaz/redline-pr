import type { ChangedFile } from '../shared/types.js';

export interface ParsedHunk {
  file: string;
  /** First and last line numbers on the new side of the file. */
  newStart: number;
  newEnd: number;
  /** Lines on the new side; 0 for a pure deletion, which sits just after newStart. */
  newLines: number;
  oldStart: number;
  oldEnd: number;
  raw: string;
}

export interface ParsedFile {
  path: string;
  hunks: ParsedHunk[];
  /** Changes with no line hunks, e.g. "binary", "renamed from x", "mode 100644 → 100755". */
  notes: string[];
}

/** Added and removed lines per file, as `git diff --stat` counts them. */
export function fileStats(files: ParsedFile[]): ChangedFile[] {
  return files.map((f) => {
    let additions = 0;
    let deletions = 0;
    for (const h of f.hunks) {
      for (const line of h.raw.split('\n')) {
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
      }
    }
    return { path: f.path, additions, deletions };
  });
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Undo git's C-style quoting ("a/caf\303\251.txt") and drop the a/ or b/ prefix. */
function cleanPath(raw: string): string {
  let path = raw.replace(/\t$/, '');
  if (path.startsWith('"') && path.endsWith('"')) {
    const bytes: number[] = [];
    const body = path.slice(1, -1);
    const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch !== '\\') {
        bytes.push(...Buffer.from(ch, 'utf8'));
        continue;
      }
      const octal = /^[0-7]{3}/.exec(body.slice(i + 1))?.[0];
      if (octal) {
        bytes.push(Number.parseInt(octal, 8));
        i += 3;
      } else {
        const next = body[i + 1] ?? '';
        bytes.push(escapes[next] ?? next.charCodeAt(0));
        i += 1;
      }
    }
    path = Buffer.from(bytes).toString('utf8');
  }
  return path.replace(/^[ab]\//, '');
}

/** `diff --git a/x b/x` -> x, for entries with no ---/+++ lines (binary, rename, mode). */
function pathFromGitHeader(line: string): string {
  const rest = line.slice('diff --git '.length);
  const quoted = /^"(?:[^"\\]|\\.)*" ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted?.[1]) return cleanPath(quoted[1]);
  // Unquoted: both sides are the same length when the path did not change.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(half + 3);
  return cleanPath(rest.slice(rest.lastIndexOf(' b/') + 1));
}

/**
 * Parse `git diff` output. Hunk bodies are consumed by their header's line
 * counts, so content lines that look like headers (an added "++ x" renders as
 * "+++ x") are never mistaken for file boundaries.
 */
export function parseUnifiedDiff(raw: string): ParsedFile[] {
  // Git on Windows (or a CRLF file) gives \r\n; a stray \r would end up in paths and line text.
  const diff = raw.replace(/\r\n/g, '\n');
  const files: ParsedFile[] = [];
  let file: ParsedFile | undefined;
  let hunk: { header: RegExpExecArray; lines: string[]; oldLeft: number; newLeft: number } | undefined;

  const flush = (): void => {
    if (!file || !hunk) return;
    const [, oldStart = '0', oldLen = '1', newStart = '0', newLen = '1'] = hunk.header;
    const ns = Number(newStart);
    const os = Number(oldStart);
    file.hunks.push({
      file: file.path,
      newStart: ns,
      newEnd: ns + Math.max(Number(newLen) - 1, 0),
      newLines: Number(newLen),
      oldStart: os,
      oldEnd: os + Math.max(Number(oldLen) - 1, 0),
      raw: hunk.lines.join('\n'),
    });
    hunk = undefined;
  };

  for (const line of diff.split('\n')) {
    if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0 || line.startsWith('\\'))) {
      const tag = line[0];
      if (tag === '-') hunk.oldLeft--;
      else if (tag === '+') hunk.newLeft--;
      else if (tag === ' ' || line === '') {
        hunk.oldLeft--;
        hunk.newLeft--;
      }
      hunk.lines.push(tag === undefined ? ' ' : line);
      continue;
    }

    if (line.startsWith('diff --git ')) {
      flush();
      file = { path: pathFromGitHeader(line), hunks: [], notes: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;

    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      hunk = { header, lines: [line], oldLeft: Number(header[2] ?? '1'), newLeft: Number(header[4] ?? '1') };
      continue;
    }
    if (hunk) continue;

    // File header lines, before the first hunk.
    if (line.startsWith('+++ ')) {
      const path = cleanPath(line.slice(4));
      if (path !== '/dev/null') file.path = path;
    } else if (line.startsWith('rename from ')) {
      file.notes.push(`renamed from ${cleanPath(line.slice('rename from '.length))}`);
    } else if (line.startsWith('rename to ')) {
      file.path = cleanPath(line.slice('rename to '.length));
    } else if (line.startsWith('new file mode')) {
      file.notes.push('new file');
    } else if (line.startsWith('deleted file mode')) {
      file.notes.push('deleted');
    } else if (line.startsWith('old mode ')) {
      file.notes.push(`mode ${line.slice('old mode '.length)}`);
    } else if (line.startsWith('new mode ')) {
      const last = file.notes.length - 1;
      if (file.notes[last]?.startsWith('mode ')) file.notes[last] += ` → ${line.slice('new mode '.length)}`;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.notes.push('binary');
    }
  }
  flush();
  // A file with only "new file"/"deleted" and no hunks is an empty file; keep it, it changed.
  return files.filter((f) => f.hunks.length > 0 || f.notes.length > 0);
}

/**
 * Render the diff with explicit new-side line numbers so the model can cite
 * exact ranges instead of guessing from hunk headers.
 */
export function numberedDiff(files: ParsedFile[]): string {
  const out: string[] = [];
  for (const file of files) {
    out.push(`=== FILE: ${file.path}${file.notes.length ? ` (${file.notes.join('; ')})` : ''}`);
    for (const hunk of file.hunks) {
      const lines = hunk.raw.split('\n');
      out.push(lines[0] ?? '');
      let n = hunk.newStart;
      for (const line of lines.slice(1)) {
        if (line.startsWith('-')) out.push(`     ${line}`);
        else if (line.startsWith('\\')) out.push(`     ${line}`);
        else out.push(`${String(n++).padStart(4)} ${line}`);
      }
    }
  }
  return out.join('\n');
}

const PEEK_CONTEXT = 3;

/**
 * Cut a hunk down to the lines around [start, end] on the new side and
 * re-emit a valid `@@` header, so a peek shows the anchored code rather
 * than an entire new file.
 */
function sliceHunk(hunk: ParsedHunk, start: number, end: number): string {
  const lines = hunk.raw.split('\n').slice(1);
  const from = start - PEEK_CONTEXT;
  const to = end + PEEK_CONTEXT;
  const kept: string[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let firstOld = 0;
  let firstNew = 0;
  let oldCount = 0;
  let newCount = 0;

  for (const line of lines) {
    const isDel = line.startsWith('-');
    const isAdd = line.startsWith('+');
    const isMeta = line.startsWith('\\');
    // Deleted lines sit "at" the next new-side line.
    const inRange = newLine >= from && newLine <= to;
    if (inRange && !isMeta) {
      if (kept.length === 0) {
        firstOld = oldLine;
        firstNew = newLine;
      }
      kept.push(line);
      if (!isAdd) oldCount++;
      if (!isDel) newCount++;
    } else if (inRange && isMeta && kept.length > 0) {
      kept.push(line);
    }
    if (!isAdd && !isMeta) oldLine++;
    if (!isDel && !isMeta) newLine++;
  }

  if (kept.length === 0) return hunk.raw;
  const oldStart = oldCount === 0 ? Math.max(firstOld - 1, 0) : firstOld;
  return [`@@ -${oldStart},${oldCount} +${firstNew},${newCount} @@`, ...kept].join('\n');
}

/** The diffed file a model-written path refers to: exact, else a unique path-suffix match. */
export function findFile(files: ParsedFile[], file: string): ParsedFile | undefined {
  const exact = files.find((f) => f.path === file);
  if (exact) return exact;
  const suffix = files.filter((f) => f.path.endsWith(`/${file.replace(/^\.?\//, '')}`));
  return suffix.length === 1 ? suffix[0] : undefined;
}

/** The diff lines around [start, end] on the new side of `file`, as unified hunk(s). */
export function hunkFor(files: ParsedFile[], file: string, start: number, end: number): string {
  const target = findFile(files, file);
  if (!target) return '';
  return target.hunks
    .filter((h) =>
      h.newLines === 0 ? start <= h.newStart + 1 && end >= h.newStart : h.newStart <= end && h.newEnd >= start,
    )
    .map((h) => sliceHunk(h, start, end))
    .join('\n');
}
