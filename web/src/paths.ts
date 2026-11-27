import type { ChangedFile } from '../../shared/types';

/** Repo-relative and forward-slashed, whatever the platform wrote: `src\api\x.js` → `src/api/x.js`. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

/** `src/api/server.js` → { dir: 'src/api/', name: 'server.js' }; a root file has no dir. */
export function splitPath(path: string): { dir: string; name: string } {
  const p = normalizePath(path);
  const cut = p.lastIndexOf('/') + 1;
  return { dir: p.slice(0, cut), name: p.slice(cut) };
}

/** `:12` or `:12–30`. */
export function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `:${startLine}` : `:${startLine}–${endLine}`;
}

export type FileTree =
  | { kind: 'dir'; name: string; depth: number; children: FileTree[] }
  | ({ kind: 'file'; name: string; depth: number } & ChangedFile);

type Draft = { dirs: Map<string, Draft>; files: ChangedFile[] };

/** The one child directory of a directory that holds nothing else. */
const soleDir = (node: Draft): [string, Draft] | undefined => (node.files.length === 0 && node.dirs.size === 1 ? [...node.dirs][0] : undefined);

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The changed files grouped by directory, for an indented list: directories first, then
 * files, each alphabetical. A directory whose only child is another directory is folded
 * into it (`src/api/v1/`), so a deep path is one line, not a staircase.
 */
export function fileTree(files: ChangedFile[]): FileTree[] {
  const root: Draft = { dirs: new Map(), files: [] };
  for (const file of files) {
    const path = normalizePath(file.path);
    const parts = path.split('/');
    const name = parts.pop() ?? path;
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push({ ...file, path: name });
  }

  const build = (node: Draft, depth: number, prefix: string): FileTree[] => {
    const dirs = [...node.dirs].sort(([a], [b]) => byName(a, b));
    const out: FileTree[] = dirs.map(([name, child]) => {
      let label = `${name}/`;
      let inner = child;
      for (let only = soleDir(inner); only; only = soleDir(inner)) {
        label += `${only[0]}/`;
        inner = only[1];
      }
      return { kind: 'dir', name: label, depth, children: build(inner, depth + 1, prefix + label) };
    });
    const leaves = [...node.files].sort((a, b) => byName(a.path, b.path));
    return [...out, ...leaves.map((f) => ({ kind: 'file' as const, name: f.path, depth, path: prefix + f.path, additions: f.additions, deletions: f.deletions }))];
  };
  return build(root, 0, '');
}

/** The tree as the rows of a list, in reading order. */
export function flattenTree(tree: FileTree[]): FileTree[] {
  return tree.flatMap((node) => (node.kind === 'dir' ? [node, ...flattenTree(node.children)] : [node]));
}
