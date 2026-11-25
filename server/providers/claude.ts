import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_LABEL } from '../../shared/types.js';
import { run } from '../exec.js';
import { claudeStream, type ClaudeResult } from './claude-stream.js';
import { cliStatus, loginCheck, parseJsonText, splitFlags, tail } from './steps.js';
import type { AgentProvider, AgentRun, RunRequest, SpecRequest } from './types.js';
import type { StreamHandlers } from './steps.js';

const SUBTYPES: Record<string, string> = {
  error_max_turns: 'Claude stopped at its turn limit before writing the spec.',
  error_during_execution: 'Claude Code stopped with an error while writing the spec.',
  error_max_structured_output_retries: 'Claude could not produce output matching the spec schema.',
};

/** One actionable sentence (or two) for a failed `claude -p`, never a 2 MB dump. */
export function describeFailure(
  res: { code: number; stdout: string; stderr: string; timedOut: boolean },
  parsed: { subtype?: string | undefined; result?: string | undefined } | undefined,
  timeoutMs = 20 * 60 * 1000,
): string {
  if (res.timedOut) {
    return `claude -p did not finish within ${timeoutMs / 60000} minutes. A very large diff is the usual cause; try a closer --base.`;
  }
  const known = parsed?.subtype ? SUBTYPES[parsed.subtype] : undefined;
  let detail = known ?? (tail(parsed?.result ?? '') || tail(res.stderr) || tail(res.stdout) || `exit code ${res.code}`);
  // Usage-limit messages end in a raw epoch ("...|1764000000"); show when it resets.
  detail = detail.replace(/\|(\d{10})\b/, (_, epoch: string) => ` (resets ${new Date(Number(epoch) * 1000).toLocaleString()})`);
  const hint = /log ?in|auth|credential|api key|\/login/i.test(detail) ? ' Run `claude` once and log in, then retry.' : '';
  return `claude -p could not generate the spec: ${detail}${hint}`;
}

/**
 * Read-only tools only. Bash is left out on purpose: even `git status`
 * rewrites .git/index, and a shell could write anywhere.
 */
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/** `claude auth status` prints JSON; exit 0 alone is enough for older versions that print text. */
export function claudeLoggedIn(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    return parsed.loggedIn !== false && parsed.authMethod !== 'none';
  } catch {
    return true;
  }
}

function syncFlags(): string[] {
  const raw = process.env.REDLINE_CLAUDE_FLAGS;
  if (raw === undefined) return ['--permission-mode', 'acceptEdits'];
  return splitFlags(raw);
}

/** Claude Code, through `claude -p` and the user's existing Claude login. */
export const claudeProvider: AgentProvider = {
  name: 'claude',
  label: AGENT_LABEL.claude,

  status: () => cliStatus('claude', () => loginCheck('claude', ['auth', 'status'], claudeLoggedIn)),

  unavailable: (status) =>
    status.installed
      ? 'Claude Code is not logged in. Run "claude auth login" and try again.'
      : 'Claude Code is not installed. Install it from https://claude.com/claude-code, log in, and try again.',

  /**
   * Claude gets the repo with read-only tools and decides for itself what beyond the diff
   * is worth reading. It starts in an empty temp dir with the repo added via --add-dir, not
   * in the repo: on startup Claude Code runs `git status` in its working directory, which
   * takes .git/index.lock and can rewrite a stale index. Nothing from the repo's own Claude
   * config is loaded (no settings, hooks, MCP servers, or skills), since hooks can run
   * commands and write files; session persistence is off. The diff arrives over stdin.
   */
  async generateSpec(req: SpecRequest, handlers: StreamHandlers): Promise<unknown> {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(req.schema),
      '--system-prompt',
      req.system,
      '--tools',
      READ_ONLY_TOOLS,
      '--allowedTools',
      READ_ONLY_TOOLS,
      '--add-dir',
      req.repoRoot,
      '--setting-sources',
      '',
      '--settings',
      '{"disableAllHooks":true}',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      ...(req.model ? ['--model', req.model] : []),
    ];
    const scratch = await mkdtemp(join(tmpdir(), 'redline-pr-'));
    const cleanup = () => rmSync(scratch, { recursive: true, force: true });
    process.once('exit', cleanup); // Ctrl-C mid-generation exits before `finally` runs.
    const stream = claudeStream(req.repoRoot, handlers);
    const res = await run('claude', args, {
      cwd: scratch,
      input: req.prompt,
      timeoutMs: req.timeoutMs,
      onStdout: (chunk) => stream.push(chunk),
      ...(req.signal ? { signal: req.signal } : {}),
    }).finally(() => {
      process.off('exit', cleanup);
      cleanup();
    });
    if (req.signal?.aborted) throw new Error('Stopped.');

    const parsed: ClaudeResult | undefined = stream.result(res.stdout);
    if (!parsed || res.code !== 0 || parsed.is_error) throw new Error(describeFailure(res, parsed, req.timeoutMs));
    if (parsed.structured_output !== undefined && parsed.structured_output !== null) return parsed.structured_output;
    if (!parsed.result) throw new Error(describeFailure(res, parsed, req.timeoutMs));
    try {
      return parseJsonText(parsed.result);
    } catch {
      throw new Error('claude -p returned a result that is not JSON. Is your claude CLI current enough for --json-schema?');
    }
  },

  /** Like typing `claude` in the repo yourself: its settings load, and the session is saved for --resume. */
  async executeSync(req: RunRequest, handlers: StreamHandlers): Promise<AgentRun> {
    const stream = claudeStream(req.cwd, handlers);
    const res = await run('claude', ['-p', '--output-format', 'stream-json', '--verbose', ...syncFlags(), ...(req.model ? ['--model', req.model] : [])], {
      cwd: req.cwd,
      input: req.prompt,
      timeoutMs: req.timeoutMs,
      onStdout: (chunk) => stream.push(chunk),
    });
    const final = stream.result(res.stdout);
    const sessionId = stream.sessionId();
    // Claude's closing message is the readable output; stderr only matters when something broke.
    const output = [final?.result?.trim() ?? (final ? '' : res.stdout.trim()), res.stderr.trim()].filter(Boolean).join('\n\n');
    const ok = res.code === 0 && final?.is_error !== true;
    const error = ok ? undefined : res.stderr.trim().split('\n').at(-1) || (final?.is_error ? final.result?.trim().split('\n')[0] : undefined);
    return { exitCode: res.code, ok, timedOut: res.timedOut, output, ...(error ? { error } : {}), ...(sessionId ? { sessionId } : {}) };
  },

  resumeCommand: (sessionId) => `claude --resume ${sessionId}`,
};
