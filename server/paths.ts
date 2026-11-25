import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cacheRoot } from './platform.js';

/** Absolute, symlink-resolved path, so the same repo always hashes the same. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where every runtime artifact for `repoPath` lives: `<cache root>/<sha256(repo path)>/`,
 * where the cache root is `$XDG_CACHE_HOME/redline-pr`, `%LOCALAPPDATA%\redline-pr` on
 * Windows, or `~/.cache/redline-pr` (see platform.ts). Never inside the repository.
 *
 * Nothing is created here; callers `mkdir` lazily, right before a write.
 */
export function artifactDir(repoPath: string): string {
  const repo = canonical(repoPath);
  const root = cacheRoot();
  const dir = join(canonical(dirname(root)), basename(root), createHash('sha256').update(repo).digest('hex'));

  if (isInside(dir, repo)) {
    throw new Error(
      `Refusing to write artifacts to ${dir}: it is inside the repository (${repo}). ` +
        'Point XDG_CACHE_HOME (or LOCALAPPDATA on Windows) at a directory outside the repo.',
    );
  }
  return dir;
}
