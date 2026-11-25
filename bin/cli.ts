#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { LoadTarget } from '../shared/types.js';
import { ActivityBus } from '../server/activity.js';
import { createApp } from '../server/app.js';
import { killAll } from '../server/exec.js';
import { artifactDir } from '../server/paths.js';
import { repoRoot } from '../server/git.js';
import { chooseAgent, detectProviders, PROVIDERS } from '../server/providers/index.js';
import { parseCliArgs } from '../server/cli-args.js';
import { browserCommand } from '../server/platform.js';
import { Workspace } from '../server/workspace.js';

const HELP = `redline-pr — read your PR as a behavioral spec, redline it, sync it back.

Usage
  redline [claude|codex] [<pr>] [options]   (also installed as redline-pr)

  redline           the current branch's PR, or its local diff if it has none
  redline 14        PR #14 (same as --pr 14)
  redline codex     write the spec with Codex (default: Claude Code if logged in, else Codex)
  redline codex 14  both, in any order

Options
  --agent <name>    Same as the claude / codex positional
  --model <name>    Model for that agent (claude --model / codex -m; default: its own)
  --base <branch>   Base branch to diff against (default: PR base, origin/HEAD, main, master, develop)
  --pr <number>     GitHub PR number (default: the PR for the current branch)
  --demo            Load a pre-baked PR; no repo, gh, or agent login needed
  --dry-run         On Sync, write the plan to the cache dir instead of running the agent
  --port <port>     Port to listen on (default: a fixed port per repo, so drafts survive restarts)
  --no-open         Do not open the browser
  -v, --version     Print the version
  -h, --help        Show this help

The spec is written by your local \`claude\` or \`codex\` CLI using your existing login.
No API key is needed.

Environment
  REDLINE_AGENT         Same as --agent
  REDLINE_MODEL         Same as --model
  REDLINE_CLAUDE_FLAGS  Flags for claude -p on Sync (default: --permission-mode acceptEdits)
  REDLINE_CODEX_FLAGS   Flags for codex exec on Sync (default: --sandbox workspace-write)
  XDG_CACHE_HOME        Artifacts go to $XDG_CACHE_HOME/redline-pr/<sha256 of repo path>/
                        (default ~/.cache, or %LOCALAPPDATA% on Windows).
                        Nothing is ever written inside the repo.
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

/** Open the page, or just say where it is when there's no display (SSH, headless Linux). */
function openBrowser(url: string): void {
  const target = browserCommand(url);
  if (!target) {
    log(dim(`Open ${url} in your browser.`));
    return;
  }
  const child = spawn(target.file, target.args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: target.verbatim, windowsHide: true });
  child.on('error', () => log(dim(`Open ${url} in your browser.`)));
  child.unref();
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
  const missing = /`(claude|codex)` is not installed/.exec(message)?.[1];
  if (missing === 'claude') return 'The claude CLI was not found on PATH. Install Claude Code (https://claude.com/claude-code) and log in, or try --demo.';
  if (missing === 'codex') return 'The codex CLI was not found on PATH. Install it (https://developers.openai.com/codex/cli) and run `codex login`, or try --demo.';
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
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string };
    console.log(pkg.version);
    return;
  }

  const webDir = join(packageRoot(), 'dist', 'web');
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error('The web UI is not built. Run `npm run build` in the redline-pr package first.');
  }

  console.log('\n  redline-pr');
  // Only this has to happen before the server starts; everything else loads in the page, with progress.
  const root = args.demo
    ? process.cwd()
    : await repoRoot(process.cwd()).catch(() => {
        throw new Error('Not inside a git repository. Run from your repo, or try --demo.');
      });
  const artifacts = artifactDir(root);
  const providers = await detectProviders();
  const agent = chooseAgent(args.agent, providers, args.demo);
  const model = args.model;
  if (args.demo) log(dim('demo PR · Sync writes a plan instead of running an agent'));
  else log(dim(`agent → ${PROVIDERS[agent].label}${model ? ` · ${model}` : ''}`));
  log(dim(`artifacts → ${artifacts}`));

  const bus = new ActivityBus((text) => log(dim(text)));
  const workspace = new Workspace({
    root,
    artifactDir: artifacts,
    displayRoot: root.startsWith(homedir()) ? `~${root.slice(homedir().length)}` : root,
    ...(args.base ? { base: args.base } : {}),
    demo: args.demo,
    dryRun: args.dryRun,
    bus,
    agent,
    providers,
    ...(model ? { model } : {}),
  });
  const app = createApp({
    workspace,
    bus,
    webDir,
    token: process.env.REDLINE_DEV_TOKEN || randomBytes(24).toString('hex'),
  });

  const server = await listen(app.fetch, args.port || stablePort(root, args.demo), args.port === 0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  log(`ready → ${url}`);
  log(dim('ctrl-c to stop\n'));
  if (args.open) openBrowser(url);
  const target: LoadTarget = args.pr ? { kind: 'pr', number: args.pr } : { kind: 'auto' };
  workspace.load(target);

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
