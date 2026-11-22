import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

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
 * Where every runtime artifact for `repoPath` lives:
 * `$XDG_CACHE_HOME/redline-pr/<sha256(repo path)>/`, defaulting to
 * `~/.cache/redline-pr/...`. Never inside the repository.
 *
 * Nothing is created here; callers `mkdir` lazily, right before a write.
 */
export function artifactDir(repoPath: string): string {
  const repo = canonical(repoPath);
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache');
  const dir = join(canonical(base), 'redline-pr', createHash('sha256').update(repo).digest('hex'));

  if (isInside(dir, repo)) {
    throw new Error(
      `Refusing to write artifacts to ${dir}: it is inside the repository (${repo}). ` +
        'Point XDG_CACHE_HOME at a directory outside the repo.',
    );
  }
  return dir;
}
