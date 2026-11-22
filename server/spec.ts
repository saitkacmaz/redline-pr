import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { MarginComment, SpecDocument, SpecSection } from '../shared/types.js';
import { findFile, hunkFor, numberedDiff, type ParsedFile } from './diff.js';
import { run } from './exec.js';
import { SPEC_SYSTEM_PROMPT, buildSpecUserPrompt } from './prompts.js';

/** Optional model override passed to `claude --model`; unset means the CLI's own default. */
export function resolveModel(): string | undefined {
  return process.env.REDLINE_MODEL?.trim() || undefined;
}

export function modelLabel(): string {
  return resolveModel() ?? 'claude CLI default model';
}

const SPEC_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * What the model writes: the SpecDocument's sections and clauses (without
 * hunks, which the server attaches from the real diff) plus the
 * comment -> clause mapping.
 */
const LlmSpecSchema = z.object({
  sections: z.array(
    z.object({
      title: z.string(),
      clauses: z.array(
        z.object({
          id: z.string(),
          text: z.string(),
          anchors: z.array(z.object({ file: z.string(), startLine: z.number(), endLine: z.number() })),
          riskFlag: z.string().nullable(),
        }),
      ),
    }),
  ),
  commentMap: z.array(z.object({ commentId: z.string(), clauseId: z.string() })),
});
type LlmSpec = z.infer<typeof LlmSpecSchema>;

// The claude CLI's validator doesn't resolve the draft 2020-12 meta-schema, so drop the `$schema` header.
const { $schema: _metaSchema, ...specJsonSchema } = z.toJSONSchema(LlmSpecSchema);
const SPEC_JSON_SCHEMA = JSON.stringify(specJsonSchema);

/** The single result object `claude -p --output-format json` prints. */
const ClaudeResultSchema = z.object({
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

export interface SpecInput {
  prTitle: string;
  prNumber?: number;
  branch: string;
  baseBranch: string;
  rawDiff: string;
  files: ParsedFile[];
  comments: MarginComment[];
  /** The repository root. Claude runs here with read-only tools. */
  repoRoot: string;
  cacheDir: string;
}

const SUBTYPES: Record<string, string> = {
  error_max_turns: 'Claude stopped at its turn limit before writing the spec.',
  error_during_execution: 'Claude Code stopped with an error while writing the spec.',
  error_max_structured_output_retries: 'Claude could not produce output matching the spec schema.',
};

/** Keep the end of long output: that's where CLIs put the actual error. */
function tail(text: string, max = 1500): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/** One actionable sentence (or two) for a failed `claude -p`, never a 2 MB dump. */
export function describeFailure(
  res: { code: number; stdout: string; stderr: string; timedOut: boolean },
  parsed: { subtype?: string | undefined; result?: string | undefined } | undefined,
): string {
  if (res.timedOut) {
    return `claude -p did not finish within ${SPEC_TIMEOUT_MS / 60000} minutes. A very large diff is the usual cause; try a closer --base.`;
  }
  const known = parsed?.subtype ? SUBTYPES[parsed.subtype] : undefined;
  let detail = known ?? (tail(parsed?.result ?? '') || tail(res.stderr) || tail(res.stdout) || `exit code ${res.code}`);
  // Usage-limit messages end in a raw epoch ("...|1764000000"); show when it resets.
  detail = detail.replace(/\|(\d{10})\b/, (_, epoch: string) => ` (resets ${new Date(Number(epoch) * 1000).toLocaleString()})`);
  const hint = /log ?in|auth|credential|api key|\/login/i.test(detail) ? ' Run `claude` once and log in, then retry.' : '';
  return `claude -p could not generate the spec: ${detail}${hint}`;
}

/** Rough prompt budget. Claude's context is ~200k tokens; leave room for the schema and the answer. */
const MAX_PROMPT_TOKENS = 150_000;
const tokensOf = (text: string): number => Math.ceil(text.length / 3.5);

/** Fail fast, naming the biggest files, instead of waiting minutes for "prompt is too long". */
export function checkBudget(files: ParsedFile[], prompt: string): void {
  const tokens = tokensOf(prompt);
  if (tokens <= MAX_PROMPT_TOKENS) return;
  const biggest = files
    .map((f) => ({ path: f.path, tokens: tokensOf(f.hunks.map((h) => h.raw).join('\n')) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map((f) => `  ${f.path} (~${Math.round(f.tokens / 1000)}k tokens)`)
    .join('\n');
  throw new Error(
    `This diff is too large to read in one pass (~${Math.round(tokens / 1000)}k tokens; the limit is ~${MAX_PROMPT_TOKENS / 1000}k).\n` +
      `Largest files:\n${biggest}\n` +
      'Diff against a closer --base, or mark generated files with linguist-generated in .gitattributes.',
  );
}

/** Pull a JSON object out of free text, tolerating ```json fences or surrounding prose. */
function parseJsonText(text: string): unknown {
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

/**
 * Read-only tools only. Bash is left out on purpose: even `git status`
 * rewrites .git/index, and a shell could write anywhere.
 */
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/**
 * Generate the spec with the local `claude` CLI, so it runs on the user's
 * existing Claude login. Claude gets the repo with read-only tools and decides
 * for itself what beyond the diff is worth reading: the code the diff calls,
 * tests, the project's docs and agent instructions.
 *
 * It starts in an empty temp dir with the repo added via --add-dir, not in the
 * repo: on startup Claude Code runs `git status` in its working directory,
 * which takes .git/index.lock and can rewrite a stale index. Nothing from the
 * repo's own Claude config is loaded (no settings, hooks, MCP servers, or
 * skills), since hooks can run commands and write files; session persistence
 * is off. The diff arrives over stdin.
 */
async function callModel(input: SpecInput): Promise<LlmSpec> {
  const model = resolveModel();
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    SPEC_JSON_SCHEMA,
    '--system-prompt',
    SPEC_SYSTEM_PROMPT,
    '--tools',
    READ_ONLY_TOOLS,
    '--allowedTools',
    READ_ONLY_TOOLS,
    '--add-dir',
    input.repoRoot,
    '--setting-sources',
    '',
    '--settings',
    '{"disableAllHooks":true}',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
  ];
  const prompt = buildSpecUserPrompt({
    prTitle: input.prTitle,
    branch: input.branch,
    baseBranch: input.baseBranch,
    numberedDiff: numberedDiff(input.files),
    comments: input.comments,
    repoRoot: input.repoRoot,
  });

  checkBudget(input.files, prompt);
  const scratch = await mkdtemp(join(tmpdir(), 'redline-pr-'));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  process.once('exit', cleanup); // Ctrl-C mid-generation exits before `finally` runs.
  const res = await run('claude', args, { cwd: scratch, input: prompt, timeoutMs: SPEC_TIMEOUT_MS }).finally(() => {
    process.off('exit', cleanup);
    cleanup();
  });

  let parsed: z.infer<typeof ClaudeResultSchema> | undefined;
  try {
    parsed = ClaudeResultSchema.parse(JSON.parse(res.stdout));
  } catch {
    parsed = undefined;
  }

  if (!parsed || res.code !== 0 || parsed.is_error) throw new Error(describeFailure(res, parsed));

  let output: unknown = parsed.structured_output;
  if (output === undefined || output === null) {
    if (!parsed.result) throw new Error(describeFailure(res, parsed));
    try {
      output = parseJsonText(parsed.result);
    } catch {
      throw new Error('claude -p returned a result that is not JSON. Is your claude CLI current enough for --json-schema?');
    }
  }

  const spec = LlmSpecSchema.safeParse(output);
  if (!spec.success) {
    throw new Error(`claude -p returned JSON that does not match the spec schema: ${spec.error.message}`);
  }
  return spec.data;
}

/** Turn the model's output into a SpecDocument, attaching real hunks and repairing comment mappings. */
function assemble(input: SpecInput, spec: LlmSpec): SpecDocument {
  const seen = new Set<string>();
  const sections: SpecSection[] = spec.sections.map((section, si) => ({
    id: `s${si + 1}`,
    title: section.title,
    clauses: section.clauses.map((clause, ci) => {
      let id = clause.id.trim();
      if (!id || seen.has(id)) id = `s${si + 1}-c${ci + 1}`;
      seen.add(id);
      return {
        id,
        originalText: clause.text,
        currentText: clause.text,
        anchors: clause.anchors.map((a) => {
          const startLine = Math.round(Math.min(a.startLine, a.endLine));
          const endLine = Math.round(Math.max(a.startLine, a.endLine));
          // Store the diff's own path so Sync targets the real file even if the model shortened it.
          const file = findFile(input.files, a.file)?.path ?? a.file;
          return { file, startLine, endLine, hunk: hunkFor(input.files, file, startLine, endLine) };
        }),
        ...(clause.riskFlag?.trim() ? { riskFlag: clause.riskFlag.trim() } : {}),
      };
    }),
  }));

  const clauses = sections.flatMap((s) => s.clauses);
  const firstId = clauses[0]?.id ?? '';
  const mapping = new Map(spec.commentMap.map((m) => [m.commentId, m.clauseId]));

  const comments = input.comments.map((comment) => {
    let clauseId = mapping.get(comment.id) ?? '';
    if (!seen.has(clauseId)) {
      // Fall back to the first clause anchored to the same file and nearest line.
      const sameFile = clauses.filter((c) => comment.file && c.anchors.some((a) => a.file === comment.file));
      const line = comment.line ?? 0;
      const nearest = sameFile.sort((a, b) => distance(a, line) - distance(b, line))[0];
      clauseId = nearest?.id ?? firstId;
    }
    return { ...comment, clauseId };
  });

  return {
    prTitle: input.prTitle,
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    branch: input.branch,
    baseBranch: input.baseBranch,
    sections,
    comments,
  };
}

function distance(clause: { anchors: { startLine: number; endLine: number }[] }, line: number): number {
  return Math.min(
    ...clause.anchors.map((a) => (line < a.startLine ? a.startLine - line : line > a.endLine ? line - a.endLine : 0)),
  );
}

/**
 * Generate the spec, reusing a cached copy when the diff, comments, and model are unchanged.
 * `onGenerate` runs only when claude -p is actually about to be called.
 */
export async function generateSpec(input: SpecInput, onGenerate: () => void = () => {}): Promise<SpecDocument> {
  const key = createHash('sha256')
    .update(modelLabel())
    .update(SPEC_JSON_SCHEMA)
    .update(SPEC_SYSTEM_PROMPT)
    .update(input.rawDiff)
    .update(JSON.stringify(input.comments.map((c) => [c.id, c.body])))
    .digest('hex')
    .slice(0, 16);
  const cacheFile = join(input.cacheDir, `spec-${key}.json`);

  try {
    return assemble(input, LlmSpecSchema.parse(JSON.parse(await readFile(cacheFile, 'utf8'))));
  } catch {
    // Cache miss or stale format; regenerate.
  }

  onGenerate();
  const spec = await callModel(input);
  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(cacheFile, JSON.stringify(spec, null, 2), { mode: 0o600 });
  return assemble(input, spec);
}
