import { isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../exec.js';
import { findExecutable } from '../platform.js';

export interface StreamHandlers {
  /** A real step, worded for a person: "Reading src/app.js", "Running npm test". */
  onStep?: (step: string) => void;
  /** Everything worth showing in the raw log. */
  onLog?: (line: string) => void;
}

/** The first line of `text`, cut to `max` characters. */
export const clip = (text: string, max = 72): string => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** `path` relative to `root` when it lies inside it; otherwise as given. */
export function underRoot(path: string, root?: string): string {
  if (root && isAbsolute(path)) {
    const rel = relative(root, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return path;
}

/** Keep the end of long output: that's where CLIs put the actual error. */
export function tail(text: string, max = 1500): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/** Pull a JSON object out of free text, tolerating ```json fences or surrounding prose. */
export function parseJsonText(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first === -1 || last <= first) throw new Error('no JSON object found');
    return JSON.parse(candidate.slice(first, last + 1));
  }
}

/** Split REDLINE_CLAUDE_FLAGS / REDLINE_CODEX_FLAGS like a shell would for quoting, e.g. --allowedTools "Bash(npm test)". */
export function splitFlags(raw: string, name = 'REDLINE_CLAUDE_FLAGS'): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error(`${name} has an unclosed ${quote} quote.`);
  if (started || current) out.push(current);
  return out;
}

/** Whether `cmd` is an executable on PATH, like `which` / `where`, without spawning anything. */
export async function onPath(cmd: string, pathEnv?: string): Promise<boolean> {
  return findExecutable(cmd, pathEnv !== undefined ? { pathEnv } : {}) !== null;
}

const LOGIN_CHECK_TIMEOUT_MS = 5000;

/**
 * Run a CLI's own login-status command. Run from the OS temp dir, never the repo, and
 * read only for its exit code (and `isLoggedIn` on stdout): its output names the account,
 * which redline neither shows nor stores.
 */
export async function loginCheck(cmd: string, args: string[], isLoggedIn: (stdout: string) => boolean = () => true): Promise<boolean> {
  try {
    const res = await run(cmd, args, { cwd: tmpdir(), timeoutMs: LOGIN_CHECK_TIMEOUT_MS });
    return res.code === 0 && isLoggedIn(res.stdout);
  } catch {
    return false;
  }
}

/** Installed (on PATH) and logged in, checked together; logged in is false when not installed. */
export async function cliStatus(cmd: string, check: () => Promise<boolean>): Promise<{ installed: boolean; loggedIn: boolean }> {
  const installed = await onPath(cmd);
  return { installed, loggedIn: installed && (await check()) };
}
