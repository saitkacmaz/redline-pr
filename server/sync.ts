import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PostedReply,
  PushBack,
  ReplyDraft,
  SpecDiffEntry,
  SpecDocument,
  SyncMode,
  SyncPlan,
  SyncResult,
} from '../shared/types.js';
import type { Tracker } from './activity.js';
import { claudeStream } from './claude-stream.js';
import { run } from './exec.js';
import { changesBetween, treeState } from './git.js';
import { postReplies } from './github.js';
import { buildSyncPrompt } from './prompts.js';

export interface SyncContext {
  /** Repository root; `claude -p` and `gh` run here. redline itself never writes here. */
  workDir: string;
  /** Out-of-repo directory for sync plans and exports (see paths.ts). */
  artifactDir: string;
  demo: boolean;
  dryRun: boolean;
  canPostReplies: boolean;
}

const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Split REDLINE_CLAUDE_FLAGS like a shell would for quoting, e.g. --allowedTools "Bash(npm test)". */
export function splitFlags(raw: string): string[] {
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
  if (quote) throw new Error(`REDLINE_CLAUDE_FLAGS has an unclosed ${quote} quote.`);
  if (started || current) out.push(current);
  return out;
}

function claudeFlags(): string[] {
  const raw = process.env.REDLINE_CLAUDE_FLAGS;
  if (raw === undefined) return ['--permission-mode', 'acceptEdits'];
  return splitFlags(raw);
}

function computeEntries(doc: SpecDocument): SpecDiffEntry[] {
  const entries: SpecDiffEntry[] = [];
  for (const section of doc.sections) {
    for (const clause of section.clauses) {
      if (normalize(clause.currentText) === normalize(clause.originalText)) continue;
      entries.push({
        clauseId: clause.id,
        sectionTitle: section.title,
        before: normalize(clause.originalText),
        after: normalize(clause.currentText),
        anchors: clause.anchors,
        comments: doc.comments.filter((c) => c.clauseId === clause.id && c.status !== 'pushed_back'),
      });
    }
  }
  return entries;
}

function computePushBacks(doc: SpecDocument): PushBack[] {
  const clauseText = new Map(doc.sections.flatMap((s) => s.clauses).map((c) => [c.id, normalize(c.currentText)]));
  return doc.comments
    .filter((c) => c.status === 'pushed_back')
    .map((comment) => ({ comment, clauseText: clauseText.get(comment.clauseId) ?? '' }));
}

/**
 * Replies are only ever what the user wrote. Redline never drafts text that
 * would be posted under their name: a generated "Updated so that ..." could
 * claim a change Claude Code skipped.
 */
function computeReplies(doc: SpecDocument): ReplyDraft[] {
  return doc.comments.flatMap((c) => {
    const body = c.replyDraft?.trim();
    return body ? [{ commentId: c.id, author: c.author, commentBody: c.body, body }] : [];
  });
}

export function renderSpecDiff(entries: SpecDiffEntry[]): string {
  return entries
    .map((e) => {
      const anchors = e.anchors.map((a) => `${a.file}:${a.startLine}-${a.endLine}`).join(' ');
      return `@@ ${e.clauseId} · ${e.sectionTitle}${anchors ? ` · ${anchors}` : ''} @@\n- ${e.before}\n+ ${e.after}`;
    })
    .join('\n\n');
}

function renderMarkdown(doc: SpecDocument, plan: Omit<SyncPlan, 'markdown'>): string {
  const pr = doc.prNumber ? ` (#${doc.prNumber})` : '';
  const replies = plan.replies.length
    ? plan.replies.map((r) => `- **@${r.author}**: ${r.commentBody.split('\n')[0]}\n  - Reply: ${r.body}`).join('\n')
    : '_None._';
  return `# redline sync: ${doc.prTitle}${pr}

Branch \`${doc.branch}\` → \`${doc.baseBranch}\` · ${plan.entries.length} edited sentence${plan.entries.length === 1 ? '' : 's'}

## Target files

${plan.targetFiles.map((f) => `- \`${f}\``).join('\n') || '_None._'}

## spec.diff

\`\`\`diff
${plan.specDiff || '# no sentence edits'}
\`\`\`

## Your replies

${replies}

## Execution prompt

Pipe this to \`claude -p\` from the repo root:

\`\`\`\`text
${plan.prompt}
\`\`\`\`
`;
}

export function buildPlan(doc: SpecDocument): SyncPlan {
  const entries = computeEntries(doc);
  const pushBacks = computePushBacks(doc);
  const replies = computeReplies(doc);
  const targetFiles = [...new Set(entries.flatMap((e) => e.anchors.map((a) => a.file)))].sort();
  const specDiff = renderSpecDiff(entries);
  const prompt = buildSyncPrompt({
    prTitle: doc.prTitle,
    branch: doc.branch,
    baseBranch: doc.baseBranch,
    specDiff,
    entries,
    pushBacks,
  });
  const partial = { entries, pushBacks, replies, targetFiles, specDiff, prompt };
  return { ...partial, markdown: renderMarkdown(doc, partial) };
}

/**
 * The browser sends its whole document, but only the user's edits are taken
 * from it: sentence text, comment status, and reply drafts. Everything the
 * prompt trusts (original sentences, anchors, hunks, comment bodies) comes
 * from the server's own copy.
 */
export function mergeEdits(server: SpecDocument, client: SpecDocument): SpecDocument {
  const text = new Map(client.sections.flatMap((s) => s.clauses).map((c) => [c.id, c.currentText]));
  const comments = new Map(client.comments.map((c) => [c.id, c]));
  return {
    ...server,
    sections: server.sections.map((s) => ({
      ...s,
      clauses: s.clauses.map((c) => ({ ...c, currentText: text.get(c.id) ?? c.originalText })),
    })),
    comments: server.comments.map((c) => {
      const edit = comments.get(c.id);
      const replyDraft = edit?.replyDraft;
      return {
        ...c,
        status: edit?.status ?? c.status,
        ...(replyDraft !== undefined ? { replyDraft } : {}),
      };
    }),
  };
}

async function writeArtifact(ctx: SyncContext, name: string, contents: string): Promise<string> {
  await mkdir(ctx.artifactDir, { recursive: true, mode: 0o700 });
  const path = join(ctx.artifactDir, name);
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

/** One Claude Code run at a time: a second click or tab must not apply the same edits twice. */
let running = false;

export const isSyncRunning = (): boolean => running;

/** A request that conflicts with what redline is doing or has loaded (HTTP 409). */
export class SyncBusyError extends Error {}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * Run (or export) the edited sentences. A real run streams its steps to `track`.
 * The caller refuses a second run against a spec that a run already made stale.
 */
export async function executeSync(doc: SpecDocument, mode: SyncMode, ctx: SyncContext, track?: () => Tracker): Promise<SyncResult> {
  const plan = buildPlan(doc);

  if (mode === 'export') {
    const writtenFile = await writeArtifact(ctx, 'redline-sync.md', plan.markdown);
    return { mode, ok: true, summary: `Saved to ${writtenFile}.`, writtenFile };
  }

  if (plan.entries.length === 0) {
    return { mode, ok: false, summary: 'Nothing to run: no sentences were edited.' };
  }

  if (ctx.demo || ctx.dryRun) {
    const writtenFile = await writeArtifact(ctx, 'sync-plan.md', plan.markdown);
    const why = ctx.demo ? 'Demo mode' : 'Dry run';
    return { mode, ok: true, summary: `${why}: wrote the plan to ${writtenFile} instead of running Claude Code.`, writtenFile };
  }

  if (running) throw new SyncBusyError('Claude Code is already running for this spec.');
  running = true;
  const started = Date.now();
  const tracker = track?.();
  try {
    const before = await treeState(ctx.workDir);
    const stream = claudeStream(ctx.workDir, {
      onStep: (step) => tracker?.step(step),
      onLog: (line) => tracker?.log(line),
    });
    const res = await run('claude', ['-p', '--output-format', 'stream-json', '--verbose', ...claudeFlags()], {
      cwd: ctx.workDir,
      input: plan.prompt,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      onStdout: (chunk) => stream.push(chunk),
    });
    const final = stream.result(res.stdout);
    const changes = await changesBetween(ctx.workDir, before, await treeState(ctx.workDir));
    const elapsedMs = Date.now() - started;
    // Claude's closing message is the readable output; stderr only matters when something broke.
    const output = [final?.result?.trim() ?? (final ? '' : res.stdout.trim()), res.stderr.trim()].filter(Boolean).join('\n\n');
    const ok = res.code === 0 && final?.is_error !== true;
    const files = plural(changes.files.length, 'file');
    const summary = res.timedOut
      ? `Claude Code was stopped after ${CLAUDE_TIMEOUT_MS / 60000} minutes. It changed ${files} before that.`
      : ok
        ? changes.files.length > 0
          ? `Synced — ${files} modified in ${seconds(elapsedMs)}`
          : `Claude Code finished in ${seconds(elapsedMs)} without changing any files.`
        : `Claude Code exited with code ${res.code} after changing ${files}.`;
    if (ok) tracker?.done(summary);
    else tracker?.fail(`${summary}${res.stderr.trim() ? ` ${res.stderr.trim().split('\n').at(-1)}` : ''}`);
    await writeArtifact(ctx, 'last-run.md', `# ${summary}\n\n## Output\n\n${output}\n\n## Changes\n\n\`\`\`diff\n${changes.diff}\`\`\`\n`);
    return { mode, ok, summary, claude: { exitCode: res.code, output }, changes, elapsedMs };
  } catch (err) {
    tracker?.fail(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    running = false;
  }
}

/* ---- Replies: posted only on an explicit click, never twice ---- */

const ledgerFile = (ctx: SyncContext): string => join(ctx.artifactDir, 'posted-replies.json');
const replyKey = (prNumber: number, r: ReplyDraft): string =>
  createHash('sha256').update(`${prNumber}\0${r.commentId}\0${r.body}`).digest('hex');

async function readLedger(ctx: SyncContext): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ledgerFile(ctx), 'utf8'));
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Reply posting is serialized: two tabs posting at once must not both see an empty ledger. */
let postQueue: Promise<unknown> = Promise.resolve();

/** Post the user's written replies for `commentIds`, skipping any identical reply already posted. */
export function postWrittenReplies(doc: SpecDocument, commentIds: string[], ctx: SyncContext): Promise<PostedReply[]> {
  const next = postQueue.then(() => postSerially(doc, commentIds, ctx));
  postQueue = next.catch(() => undefined);
  return next;
}

async function postSerially(doc: SpecDocument, commentIds: string[], ctx: SyncContext): Promise<PostedReply[]> {
  const prNumber = doc.prNumber;
  if (!ctx.canPostReplies || prNumber === undefined) throw new Error('Posting replies is off for this session.');
  const wanted = new Set(commentIds);
  const replies = buildPlan(doc).replies.filter((r) => wanted.has(r.commentId));
  const ledger = await readLedger(ctx);

  const results: PostedReply[] = [];
  for (const reply of replies) {
    const key = replyKey(prNumber, reply);
    if (ledger.has(key)) {
      results.push({ commentId: reply.commentId, ok: true });
      continue;
    }
    const [result] = await postReplies(ctx.workDir, prNumber, [reply]);
    if (!result) continue;
    results.push(result);
    if (result.ok) {
      // Record each post as it lands, so a later failure can't cause a re-post.
      ledger.add(key);
      await writeArtifact(ctx, 'posted-replies.json', JSON.stringify([...ledger]));
    }
  }
  return results;
}
