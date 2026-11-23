import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as exec, runOk as execOk, type RunOptions } from './exec.js';

/**
 * Every git call is read-only. GIT_OPTIONAL_LOCKS=0 stops git from
 * opportunistically rewriting .git/index while it computes a diff.
 */
const READ_ONLY = { GIT_OPTIONAL_LOCKS: '0' };
const run = (cmd: string, args: readonly string[], opts: RunOptions = {}) =>
  exec(cmd, args, { ...opts, env: { ...opts.env, ...READ_ONLY } });
const runOk = (cmd: string, args: readonly string[], opts: RunOptions = {}) =>
  execOk(cmd, args, { ...opts, env: { ...opts.env, ...READ_ONLY } });

/** Generated or vendored files that only add noise to a behavioral read. */
const EXCLUDED_PATHS = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'Pipfile.lock',
  'flake.lock',
  'mix.lock',
  'pubspec.lock',
  'Package.resolved',
  'packages.lock.json',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
];

/** Drop the same generated files from a diff that didn't come from `diffAgainst` (e.g. `gh pr diff`). */
export function isExcludedPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return EXCLUDED_PATHS.some((p) => (p.startsWith('*') ? name.endsWith(p.slice(1)) : name === p));
}

export async function headCommit(cwd: string): Promise<string> {
  return (await runOk('git', ['rev-parse', 'HEAD'], { cwd })).trim();
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await runOk('git', ['rev-parse', '--show-toplevel'], { cwd })).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await runOk('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).trim();
}

/** Whether `commit` is `of` or one of its ancestors. False if either isn't known locally. */
export async function isAncestor(cwd: string, commit: string, of: string): Promise<boolean> {
  return (await run('git', ['merge-base', '--is-ancestor', commit, of], { cwd })).code === 0;
}

/** Whether `commit` exists in the local object store. */
export async function hasCommit(cwd: string, commit: string): Promise<boolean> {
  return (await run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd })).code === 0;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const res = await run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  return res.code === 0;
}

/**
 * Resolve a base branch name to a ref that exists locally, preferring the remote-tracking copy.
 * Without an explicit base, the repo's default branch (origin/HEAD, then main, master, develop),
 * trying `current` last: diffing a branch against itself is always empty.
 */
export async function resolveBaseRef(cwd: string, base: string | undefined, current?: string): Promise<{ name: string; ref: string }> {
  const candidates = base ? [base] : [];
  if (!base) {
    const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd });
    if (head.code === 0) candidates.push(head.stdout.trim().replace(/^origin\//, ''));
    candidates.push('main', 'master', 'develop');
  }

  // The current branch goes last: only if nothing else exists (then the diff is honestly empty).
  const ordered = base ? candidates : [...candidates.filter((n) => n !== current), ...candidates.filter((n) => n === current)];
  for (const name of ordered) {
    for (const ref of [`origin/${name}`, name]) {
      if (await refExists(cwd, ref)) return { name, ref };
    }
  }
  throw new Error(
    base
      ? `Base branch "${base}" not found locally or on origin. Try \`git fetch origin ${base}\`.`
      : 'Could not detect a base branch. Pass one with --base <branch>.',
  );
}

async function findMergeBase(cwd: string, baseRef: string): Promise<string> {
  const res = await run('git', ['merge-base', baseRef, 'HEAD'], { cwd });
  if (res.code === 0) return res.stdout.trim();
  const shallow = (await run('git', ['rev-parse', '--is-shallow-repository'], { cwd })).stdout.trim() === 'true';
  throw new Error(
    shallow
      ? `This is a shallow clone, so the history shared with ${baseRef} isn't here. Run \`git fetch --unshallow\` (or \`git fetch --deepen=200\`) and retry.`
      : `HEAD has no history in common with ${baseRef}. Pass the branch this work started from with --base.`,
  );
}

/** Plumbing diff with fixed prefixes and UTF-8 paths, independent of the user's diff.* config. */
const PLUMBING_DIFF = [
  '-c',
  'core.quotePath=false',
  'diff-index',
  '-p',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/**
 * Diff of the working tree (committed + uncommitted) against the merge-base with the base ref.
 *
 * Uses plumbing `git diff-index`, not porcelain `git diff`: porcelain refreshes stale stat
 * data and writes .git/index back even with GIT_OPTIONAL_LOCKS=0 (e.g. after an editor's
 * atomic save of an unchanged file). Plumbing also ignores the user's diff.* config, so
 * prefixes stay a/ b/ and paths stay unquoted UTF-8.
 */
export async function diffAgainst(cwd: string, baseRef: string): Promise<string> {
  const mergeBase = await findMergeBase(cwd, baseRef);
  const excludes = [
    ...EXCLUDED_PATHS.map((p) => `:(exclude,glob)**/${p}`),
    // Files the repo itself marks as generated or vendored (.gitattributes, as GitHub does).
    ':(exclude,attr:linguist-generated)',
    ':(exclude,attr:linguist-vendored)',
  ];
  return runOk('git', [...PLUMBING_DIFF, '-M', '--unified=3', mergeBase, '--', '.', ...excludes], { cwd });
}

/** A file that differs from HEAD (modified, deleted, or untracked), as it was at snapshot time. */
interface FileSnap {
  hash: string | null; // null: the file doesn't exist
  content: Buffer | null; // null when missing or too large to keep
}

/** Uncommitted work at a point in time: every path that differs from HEAD, with its content. */
export interface TreeState {
  dirty: Map<string, FileSnap>;
}

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const splitZ = (out: string): string[] => out.split('\0').filter(Boolean);

async function snap(root: string, path: string): Promise<FileSnap> {
  try {
    const content = await readFile(join(root, path));
    return {
      hash: createHash('sha256').update(content).digest('hex'),
      content: content.length <= MAX_SNAPSHOT_BYTES ? content : null,
    };
  } catch {
    return { hash: null, content: null };
  }
}

/** Read-only snapshot: diff-index and ls-files never write the index; files are only read. */
export async function treeState(cwd: string): Promise<TreeState> {
  const [tracked, untracked] = await Promise.all([
    runOk('git', ['diff-index', '--name-only', '-z', 'HEAD', '--'], { cwd }),
    runOk('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd }),
  ]);
  const paths = [...new Set([...splitZ(tracked), ...splitZ(untracked)])];
  const snaps = await Promise.all(paths.map(async (p) => [p, await snap(cwd, p)] as const));
  return { dirty: new Map(snaps) };
}

/** Only the hunks of a patch: --no-index headers name temp files, so the caller writes its own. */
const hunksOnly = (patch: string): string => {
  const at = patch.search(/^@@/m);
  return at === -1 ? (/^Binary files/m.test(patch) ? 'Binary file changed\n' : '') : patch.slice(at);
};

/** `git diff --no-index` between two paths, without touching any repository. */
async function diffFiles(cwd: string, from: string, to: string): Promise<string> {
  const res = await run('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--unified=3', from, to], { cwd });
  return hunksOnly(res.stdout);
}

/**
 * What changed between two snapshots, as a patch per file relative to its content at
 * `before`, so edits the user had already made are not shown as Claude's. Old contents
 * are written to a private temp dir outside the repo, only to diff against.
 */
export async function changesBetween(
  cwd: string,
  before: TreeState,
  after: TreeState,
): Promise<{ files: string[]; diff: string }> {
  const paths = [...new Set([...before.dirty.keys(), ...after.dirty.keys()])].sort();
  const changed = paths.filter((p) => before.dirty.get(p)?.hash !== after.dirty.get(p)?.hash);
  if (changed.length === 0) return { files: [], diff: '' };

  const scratch = await mkdtemp(join(tmpdir(), 'redline-run-'));
  try {
    const patches: string[] = [];
    for (const path of changed) {
      const old = before.dirty.get(path);
      const now = join(cwd, path);
      let body: string;
      if (!old) {
        // Clean before the run, so its diff against HEAD is exactly this run's change.
        const tracked = await run('git', [...PLUMBING_DIFF, '--unified=3', 'HEAD', '--', `:(literal)${path}`], { cwd });
        body = tracked.stdout.trim() ? hunksOnly(tracked.stdout) : await diffFiles(cwd, '/dev/null', now);
      } else if (old.hash !== null && old.content === null) {
        body = 'Changed (too large to show).\n';
      } else {
        const prior = join(scratch, 'before');
        await writeFile(prior, old.content ?? '');
        const exists = (await snap(cwd, path)).hash !== null;
        body = await diffFiles(cwd, old.hash === null ? '/dev/null' : prior, exists ? now : '/dev/null');
      }
      patches.push(`diff --git a/${path} b/${path}\n${body}`);
    }
    return { files: changed, diff: patches.join('') };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
