import type { SpecDocument } from '../../shared/types';

/** Every file the page can name: anchors, comments, and hidden threads. */
export function docPaths(doc: SpecDocument): string[] {
  return [
    ...doc.sections.flatMap((s) => s.clauses.flatMap((c) => c.anchors.map((a) => a.file))),
    ...doc.comments.flatMap((c) => (c.file ? [c.file] : [])),
    ...(doc.hiddenThreads ?? []).flatMap((t) => (t.file ? [t.file] : [])),
  ];
}

/**
 * Names each path by its shortest unique tail among `paths`: `server.js` when it's the only
 * one, `api/index.ts` and `web/index.ts` when two share a name. Compact in prose, never
 * ambiguous. A path that wasn't in the list is shown in full.
 */
export function shortPaths(paths: Iterable<string>): (path: string) => string {
  const all = [...new Set(paths)];
  const split = all.map((p) => p.split('/'));
  const names = new Map<string, string>();
  all.forEach((path, i) => {
    const parts = split[i] ?? [path];
    for (let n = 1; n <= parts.length; n++) {
      const tail = parts.slice(-n).join('/');
      const clash = split.some((other, j) => j !== i && other.slice(-n).join('/') === tail);
      if (!clash) {
        names.set(path, tail);
        return;
      }
    }
    names.set(path, path);
  });
  return (path) => names.get(path) ?? path;
}

/** `file:12` or `file:12-30`. */
export function lineRange(name: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${name}:${startLine}` : `${name}:${startLine}-${endLine}`;
}
