import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AGENT_LABEL } from '../../shared/types.js';
import { run } from '../exec.js';
import { codexStream } from './codex-stream.js';
import { cliStatus, loginCheck, parseJsonText, splitFlags, tail, type StreamHandlers } from './steps.js';
import type { AgentProvider, AgentRun, RunRequest, SpecRequest } from './types.js';

type Json = Record<string, unknown>;

/**
 * OpenAI's strict structured outputs: every object closed (`additionalProperties: false`)
 * and every property listed in `required` (optional values are expressed as nullable).
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema as Json)) {
    if (key === '$schema') continue;
    out[key] = strictSchema(value);
  }
  if (typeof out.properties === 'object' && out.properties !== null) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

/**
 * Where the spec schema lives: `~/.cache/redline-pr/schemas/`, beside the per-repo
 * directories, never in the repo. Written atomically, so two redlines can share it.
 */
export async function writeSchema(artifactDir: string, schema: unknown): Promise<string> {
  const dir = join(dirname(artifactDir), 'schemas');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'spec-schema.json');
  const temp = `${path}.${randomBytes(4).toString('hex')}`;
  await writeFile(temp, JSON.stringify(strictSchema(schema), null, 2), { mode: 0o600 });
  await rename(temp, path);
  return path;
}

/** One actionable sentence for a failed `codex exec`. */
export function describeCodexFailure(res: { code: number; stderr: string; timedOut: boolean }, failure: string | undefined, timeoutMs: number): string {
  if (res.timedOut) {
    return `codex exec did not finish within ${timeoutMs / 60000} minutes. A very large diff is the usual cause; try a closer --base.`;
  }
  const detail = failure ?? (tail(res.stderr) || `exit code ${res.code}`);
  const hint = /log ?in|auth|unauthori[sz]ed|401|credential/i.test(detail) ? ' Run `codex login`, then retry.' : '';
  return `codex exec could not generate the spec: ${detail}${hint}`;
}

function syncFlags(): string[] {
  const raw = process.env.REDLINE_CODEX_FLAGS;
  if (raw === undefined) return ['--sandbox', 'workspace-write'];
  return splitFlags(raw, 'REDLINE_CODEX_FLAGS');
}

/** OpenAI's Codex CLI, through `codex exec` and the user's existing Codex (ChatGPT) login. */
export const codexProvider: AgentProvider = {
  name: 'codex',
  label: AGENT_LABEL.codex,

  status: () => cliStatus('codex', () => loginCheck('codex', ['login', 'status'])),

  unavailable: (status) =>
    status.installed
      ? 'Codex CLI is not logged in. Run "codex login" and try again.'
      : 'Codex CLI is not installed. Install it from https://developers.openai.com/codex/cli, run "codex login", and try again.',

  /**
   * Read-only sandbox, from an empty scratch directory under ~/.cache/redline-pr/ (so the
   * repo's AGENTS.md and .codex/ config aren't loaded as instructions, and no git command
   * runs in the repo). The user's own Codex config, rules and hooks are left out too, and
   * the session isn't saved. The repo is reached by path, which the sandbox lets it read.
   * The answer is the last message, written by Codex to a file beside the scratch dir.
   */
  async generateSpec(req: SpecRequest, handlers: StreamHandlers): Promise<unknown> {
    const schemaPath = await writeSchema(req.artifactDir, req.schema);
    await mkdir(req.artifactDir, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(join(req.artifactDir, 'codex-'));
    const work = join(scratch, 'work');
    const answer = join(scratch, 'last-message.json');
    await mkdir(work);
    const cleanup = () => rmSync(scratch, { recursive: true, force: true });
    process.once('exit', cleanup);

    const args = [
      'exec',
      '--json',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      answer,
      '--cd',
      work,
      ...(req.model ? ['--model', req.model] : []),
      '-',
    ];
    const stream = codexStream(req.repoRoot, handlers);
    try {
      const res = await run('codex', args, {
        cwd: work,
        input: `${req.system}\n\n---\n\n${req.prompt}`,
        timeoutMs: req.timeoutMs,
        onStdout: (chunk) => stream.push(chunk),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (req.signal?.aborted) throw new Error('Stopped.');
      const outcome = stream.finish();
      if (res.code !== 0 || outcome.failure) throw new Error(describeCodexFailure(res, outcome.failure, req.timeoutMs));

      const text = (await readFile(answer, 'utf8').catch(() => '')).trim() || outcome.lastMessage;
      if (!text) throw new Error(describeCodexFailure(res, 'Codex finished without an answer.', req.timeoutMs));
      try {
        return parseJsonText(text);
      } catch {
        throw new Error('codex exec returned an answer that is not JSON. Is your codex CLI current enough for --output-schema?');
      }
    } finally {
      process.off('exit', cleanup);
      cleanup();
    }
  },

  /**
   * In the repo, inside Codex's workspace-write sandbox: it can edit files and run
   * commands there (tests, for example), but by default not write outside the repo or
   * reach the network. The user's Codex config applies, as if they ran `codex` themselves, and the
   * session is saved for `codex resume`.
   */
  async executeSync(req: RunRequest, handlers: StreamHandlers): Promise<AgentRun> {
    const stream = codexStream(req.cwd, handlers);
    const res = await run('codex', ['exec', '--json', '--color', 'never', ...syncFlags(), ...(req.model ? ['--model', req.model] : []), '-'], {
      cwd: req.cwd,
      input: req.prompt,
      timeoutMs: req.timeoutMs,
      onStdout: (chunk) => stream.push(chunk),
    });
    const outcome = stream.finish();
    const ok = res.code === 0 && !outcome.failure;
    const output = [outcome.lastMessage ?? '', ok ? '' : res.stderr.trim()].filter(Boolean).join('\n\n');
    const error = ok ? undefined : outcome.failure ?? (res.stderr.trim().split('\n').at(-1) || undefined);
    return {
      exitCode: res.code,
      ok,
      timedOut: res.timedOut,
      output,
      ...(error ? { error } : {}),
      ...(outcome.threadId ? { sessionId: outcome.threadId } : {}),
    };
  },

  resumeCommand: (sessionId) => `codex resume ${sessionId}`,
};
