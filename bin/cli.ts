#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { MarginComment, SessionInfo, SpecDocument } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { killAll } from '../server/exec.js';
import { demoDocument } from '../server/demo.js';
import { parseUnifiedDiff } from '../server/diff.js';
import { artifactDir } from '../server/paths.js';
import { currentBranch, diffAgainst, hasCommit, isAncestor, repoRoot, resolveBaseRef } from '../server/git.js';
import { fetchComments, findPullRequest, ghAvailable, type PullRequest } from '../server/github.js';
import { generateSpec, modelLabel } from '../server/spec.js';

const HELP = `redline-pr — read your PR as a behavioral spec, redline it, sync it back.

Usage
  npx redline-pr [options]

Options
  --base <branch>   Base branch to diff against (default: PR base, origin/HEAD, main, master)
  --pr <number>     GitHub PR number (default: the PR for the current branch)
  --demo            Load a pre-baked PR; no repo, gh, or claude login needed
  --dry-run         On Sync, write the plan to the cache dir instead of running claude -p
  --port <port>     Port to listen on (default: a fixed port per repo, so drafts survive restarts)
  --no-open         Do not open the browser
  -h, --help        Show this help

The spec is written by your local \`claude\` CLI using your existing Claude login.
No API key is needed.

Environment
  REDLINE_MODEL         Model passed to claude --model (default: your claude CLI default)
  REDLINE_CLAUDE_FLAGS  Flags passed to claude -p (default: --permission-mode acceptEdits)
  XDG_CACHE_HOME        Artifacts go to $XDG_CACHE_HOME/redline-pr/<sha256 of repo path>/
                        (default ~/.cache). Nothing is ever written inside the repo.
`;

const dim = (s: string): string => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s);
const log = (s: string): void => console.log(`  ${s}`);

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const parsed: unknown = JSON.parse(readFileSync(pkg, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'name' in parsed && parsed.name === 'redline-pr') return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate the redline-pr package root.');
    dir = parent;
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => log(dim(`Open ${url} in your browser.`)));
  child.unref();
}

interface Loaded {
  doc: SpecDocument;
  workDir: string;
  artifactDir: string;
  canPostReplies: boolean;
}

async function loadLive(base: string | undefined, prFlag: number | undefined): Promise<Loaded> {
  const cwd = process.cwd();
  const root = await repoRoot(cwd).catch(() => {
    throw new Error('Not inside a git repository. Run from your repo, or try --demo.');
  });
  const artifacts = artifactDir(root);
  const branch = await currentBranch(root);
  const hasGh = await ghAvailable(root);
  if (prFlag && !hasGh) throw new Error('--pr needs the GitHub CLI. Install gh and run `gh auth login`.');
  const pr = hasGh ? await findPullRequest(root, prFlag) : null;
  const baseRef = await resolveBaseRef(root, base ?? pr?.baseRefName);

  // An explicit --pr must be the work that's checked out: otherwise its comments land on an
  // unrelated diff and replies post to the wrong PR. (Without --pr, gh matched it to this branch.)
  // The PR head must be in this branch's own history (not already merged into the base, which
  // every old PR is); if it was never fetched, fall back to the branch name.
  const sameWork = async (p: PullRequest): Promise<boolean> => {
    if (p.headRefOid === undefined || !(await hasCommit(root, p.headRefOid))) return p.headRefName === branch;
    return (await isAncestor(root, p.headRefOid, 'HEAD')) && !(await isAncestor(root, p.headRefOid, baseRef.ref));
  };
  if (prFlag && pr && !(await sameWork(pr))) {
    throw new Error(
      `PR #${pr.number} is for branch ${pr.headRefName}, but ${branch} is checked out. Run \`gh pr checkout ${pr.number}\` first.`,
    );
  }

  log(dim(`diffing ${branch} against ${baseRef.ref}`));
  const rawDiff = await diffAgainst(root, baseRef.ref);
  const files = parseUnifiedDiff(rawDiff);
  if (files.length === 0) throw new Error(`No changes between ${branch} and ${baseRef.ref}.`);

  let comments: MarginComment[] = [];
  if (pr) {
    try {
      comments = await fetchComments(root, pr.number);
      log(dim(`PR #${pr.number} · ${comments.length} comment${comments.length === 1 ? '' : 's'}`));
    } catch (err) {
      log(`PR #${pr.number} · could not load comments, continuing without them: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  } else {
    log(dim(hasGh ? 'no PR found for this branch; continuing without comments' : 'gh not available; continuing without comments'));
  }

  const doc = await generateSpec(
    {
      prTitle: pr?.title ?? branch,
      ...(pr ? { prNumber: pr.number } : {}),
      branch,
      baseBranch: baseRef.name,
      rawDiff,
      files,
      comments,
      repoRoot: root,
      cacheDir: join(artifacts, 'cache'),
    },
    () => log(dim(`writing behavioral spec with claude -p · ${modelLabel()} (${files.length} files)…`)),
  );
  return { doc, workDir: root, artifactDir: artifacts, canPostReplies: pr !== null };
}

/**
 * The same repo gets the same port each launch, so the page has the same origin and
 * its localStorage drafts survive a restart or a crash. 4400-4999, from the repo path.
 */
function stablePort(workDir: string, demo: boolean): number {
  const hash = createHash('sha256').update(demo ? 'redline-pr demo' : workDir).digest();
  return 4400 + (hash.readUInt16BE(0) % 600);
}

type Server = ReturnType<typeof serve>;

/** Listen on `port`; if it's taken and the user didn't ask for it, fall back to any free port. */
function listen(fetch: Parameters<typeof serve>[0]['fetch'], port: number, fallback: boolean): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname: '127.0.0.1' }, () => resolve(server));
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && fallback) {
        listen(fetch, 0, false).then(resolve, reject);
        return;
      }
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`port ${port} is already in use. Pick another with --port, or leave it out to use a free one.`)
          : err,
      );
    });
  });
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('`claude` is not installed')) {
    return 'The claude CLI was not found on PATH. Install Claude Code (https://claude.com/claude-code) and log in, or try --demo.';
  }
  return message;
}

/**
 * Children run in their own process group (so a timeout can kill the tools they start),
 * which also means the terminal's Ctrl-C and hang-up don't reach them. Until the server is
 * up, stop them ourselves; a `claude -p` must never outlive redline.
 */
function stopEarly(): void {
  killAll();
  process.exit(130);
}

async function main(): Promise<void> {
  process.on('SIGINT', stopEarly).on('SIGTERM', stopEarly).on('SIGHUP', stopEarly);
  process.on('exit', killAll);
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      pr: { type: 'string' },
      demo: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const whole = (flag: string, value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`${flag} expects a whole number, got "${value}"`);
    return Number(value);
  };
  const prNumber = whole('--pr', values.pr);
  if (prNumber === 0) throw new Error('--pr expects a PR number, got 0');
  const port = whole('--port', values.port) ?? 0;
  if (port > 65535) throw new Error(`--port must be at most 65535, got ${port}`);

  const webDir = join(packageRoot(), 'dist', 'web');
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error('The web UI is not built. Run `npm run build` in the redline-pr package first.');
  }

  console.log('\n  redline-pr');
  const loaded: Loaded = values.demo
    ? { doc: demoDocument(), workDir: process.cwd(), artifactDir: artifactDir(process.cwd()), canPostReplies: false }
    : await loadLive(values.base, prNumber);
  if (values.demo) log(dim('demo PR loaded · Sync writes a plan instead of running claude -p'));
  log(dim(`artifacts → ${loaded.artifactDir}`));

  const session: SessionInfo = {
    repo: loaded.workDir.startsWith(homedir()) ? `~${loaded.workDir.slice(homedir().length)}` : loaded.workDir,
    demo: values.demo,
    dryRun: values['dry-run'],
    canPostReplies: loaded.canPostReplies && !values.demo && !values['dry-run'],
    model: modelLabel(),
    artifactDir: loaded.artifactDir,
    applied: false,
  };

  const app = createApp({
    doc: loaded.doc,
    session,
    sync: {
      workDir: loaded.workDir,
      artifactDir: loaded.artifactDir,
      demo: session.demo,
      dryRun: session.dryRun,
      canPostReplies: session.canPostReplies,
    },
    webDir,
    token: process.env.REDLINE_DEV_TOKEN || randomBytes(24).toString('hex'),
  });

  const server = await listen(app.fetch, port || stablePort(loaded.workDir, values.demo), port === 0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  log(`ready → ${url}`);
  log(dim('ctrl-c to stop\n'));
  if (!values['no-open']) openBrowser(url);

  process.off('SIGINT', stopEarly).off('SIGTERM', stopEarly).off('SIGHUP', stopEarly);
  const shutdown = (): void => {
    killAll();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown).on('SIGTERM', shutdown).on('SIGHUP', shutdown);
}

main().catch((err: unknown) => {
  killAll();
  console.error(`\n  redline-pr: ${describeError(err)}\n`);
  process.exit(1);
});
