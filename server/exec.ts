import { spawn, type ChildProcess } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the process was killed for running past `timeoutMs`; `code` is then 124. */
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Called with each stdout chunk as it arrives (stdout is still collected). */
  onStdout?: (chunk: string) => void;
  /** Aborting stops the child's whole process group; the result then has code 130. */
  signal?: AbortSignal;
}

const KILL_GRACE_MS = 5000;
const live = new Set<ChildProcess>();

/**
 * Signal a child's whole process group, so tools it spawned die with it. The group can
 * outlive its leader (a descendant still holding our pipes), so don't stop at exitCode.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is already gone. Fall back to the leader alone (e.g. on Windows).
    if (child.exitCode === null) child.kill(signal);
  }
}

/** Kill every child still running (on Ctrl-C), so a long `claude -p` never outlives redline. */
export function killAll(): void {
  for (const child of live) killGroup(child, 'SIGKILL');
}

/** Spawn without a shell so arguments are never interpolated. */
export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group: a timeout or shutdown can take down the tools the child started.
      detached: process.platform !== 'win32',
    });
    live.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];

    if (opts.timeoutMs) {
      const seconds = Math.round(opts.timeoutMs / 1000);
      timers.push(
        setTimeout(() => {
          timedOut = true;
          stderr += `\n[redline] ${cmd} timed out after ${seconds}s and was stopped.`;
          killGroup(child, 'SIGTERM');
          timers.push(setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS));
        }, opts.timeoutMs),
      );
    }
    const abort = (): void => {
      killGroup(child, 'SIGTERM');
      timers.push(setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS));
    };
    if (opts.signal?.aborted) abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    const done = (): void => {
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener('abort', abort);
      live.delete(child);
    };

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      opts.onStdout?.(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdin.on('error', () => {
      // The child exited before reading all input; its exit code tells the story.
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      done();
      reject(err.code === 'ENOENT' ? new Error(`\`${cmd}\` is not installed or not on PATH`) : err);
    });
    child.on('close', (code) => {
      done();
      resolve({ code: timedOut ? 124 : opts.signal?.aborted ? 130 : (code ?? 1), stdout, stderr, timedOut });
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run and throw with stderr on a non-zero exit. */
export async function runOk(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<string> {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}
