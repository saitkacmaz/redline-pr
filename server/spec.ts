import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { MarginComment, SpecDocument, SpecSection } from '../shared/types.js';
import { findFile, hunkFor, numberedDiff, type ParsedFile } from './diff.js';
import { SPEC_SYSTEM_PROMPT, buildSpecUserPrompt, threadText } from './prompts.js';
import type { StreamHandlers } from './providers/steps.js';
import type { AgentProvider } from './providers/types.js';

export { describeFailure } from './providers/claude.js';

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
export const SPEC_SCHEMA: Record<string, unknown> = specJsonSchema;
const SPEC_JSON_SCHEMA = JSON.stringify(specJsonSchema);


export interface SpecInput {
  prTitle: string;
  prNumber?: number;
  branch: string;
  baseBranch: string;
  rawDiff: string;
  files: ParsedFile[];
  comments: MarginComment[];
  /** The repository root. The agent reads it, read-only. */
  repoRoot: string;
  /** Set when the files on disk are not the code this diff produces (a PR that isn't checked out). */
  contextNote?: string;
  /** This repo's directory under ~/.cache/redline-pr/; specs are cached in its cache/ folder. */
  artifactDir: string;
  agent: AgentProvider;
  /** Passed to the agent's --model; unset means its CLI's own default. */
  model?: string;
}

export interface SpecHooks extends StreamHandlers {
  /** Runs only when the agent is actually about to be called (not on a cache hit). */
  onGenerate?: () => void;
  signal?: AbortSignal;
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

/** Ask the agent for the spec and hold its answer to the schema, whichever agent wrote it. */
async function callModel(input: SpecInput, hooks: SpecHooks): Promise<LlmSpec> {
  const prompt = buildSpecUserPrompt({
    prTitle: input.prTitle,
    branch: input.branch,
    baseBranch: input.baseBranch,
    numberedDiff: numberedDiff(input.files),
    comments: input.comments,
    repoRoot: input.repoRoot,
    ...(input.contextNote ? { contextNote: input.contextNote } : {}),
  });

  checkBudget(input.files, prompt);
  const output = await input.agent.generateSpec(
    {
      system: SPEC_SYSTEM_PROMPT,
      prompt,
      schema: SPEC_SCHEMA,
      repoRoot: input.repoRoot,
      artifactDir: input.artifactDir,
      ...(input.model ? { model: input.model } : {}),
      timeoutMs: SPEC_TIMEOUT_MS,
      ...(hooks.signal ? { signal: hooks.signal } : {}),
    },
    hooks,
  );
  const spec = LlmSpecSchema.safeParse(output);
  if (!spec.success) {
    throw new Error(`${input.agent.label} returned JSON that does not match the spec schema: ${spec.error.message}`);
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
    id: randomBytes(8).toString('hex'),
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

/** Generate the spec, reusing a cached copy when the diff, comments, agent, model, and prompt are unchanged. */
export async function generateSpec(input: SpecInput, hooks: SpecHooks = {}): Promise<SpecDocument> {
  const key = createHash('sha256')
    .update(`${input.agent.name}\0${input.model ?? ''}`)
    .update(SPEC_JSON_SCHEMA)
    .update(SPEC_SYSTEM_PROMPT)
    .update(input.contextNote ?? '')
    .update(input.rawDiff)
    .update(JSON.stringify(input.comments.map((c) => [c.id, threadText(c)])))
    .digest('hex')
    .slice(0, 16);
  const cacheDir = join(input.artifactDir, 'cache');
  const cacheFile = join(cacheDir, `spec-${key}.json`);

  try {
    return assemble(input, LlmSpecSchema.parse(JSON.parse(await readFile(cacheFile, 'utf8'))));
  } catch {
    // Cache miss or stale format; regenerate.
  }

  hooks.onGenerate?.();
  const spec = await callModel(input, hooks);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(cacheFile, JSON.stringify(spec, null, 2), { mode: 0o600 });
  return assemble(input, spec);
}
