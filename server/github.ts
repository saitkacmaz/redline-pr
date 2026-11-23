import { z } from 'zod';
import type { MarginComment, PostedReply, ReplyDraft } from '../shared/types.js';
import { run, runOk } from './exec.js';

const PrSchema = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string().optional(),
});
export type PullRequest = z.infer<typeof PrSchema>;

const UserSchema = z.object({ login: z.string(), type: z.string().optional() }).nullable();

const ReviewCommentSchema = z.object({
  id: z.number(),
  user: UserSchema,
  body: z.string(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  original_line: z.number().nullable().optional(),
  side: z.string().nullable().optional(),
  in_reply_to_id: z.number().optional(),
});

const IssueCommentSchema = z.object({
  id: z.number(),
  user: UserSchema,
  body: z.string(),
});

const ReviewSchema = z.object({
  id: z.number(),
  user: UserSchema,
  body: z.string().nullable(),
  state: z.string(),
});

export async function ghAvailable(cwd: string): Promise<boolean> {
  try {
    return (await run('gh', ['auth', 'status'], { cwd })).code === 0;
  } catch {
    return false;
  }
}

/** The PR for `prNumber`, or for the current branch when omitted. Null when none exists. */
export async function findPullRequest(cwd: string, prNumber?: number): Promise<PullRequest | null> {
  const args = ['pr', 'view', ...(prNumber ? [String(prNumber)] : []), '--json', 'number,title,headRefName,baseRefName,headRefOid'];
  const res = await run('gh', args, { cwd });
  if (res.code !== 0) {
    if (prNumber) throw new Error(`gh could not load PR #${prNumber}: ${res.stderr.trim()}`);
    return null;
  }
  return PrSchema.parse(JSON.parse(res.stdout));
}

const PrListSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    headRefName: z.string(),
    baseRefName: z.string(),
    headRefOid: z.string().optional(),
    author: z.object({ login: z.string() }).nullable().optional(),
  }),
);
export type PrListEntry = z.infer<typeof PrListSchema>[number];

/** Open PRs in this repo, newest first. Read-only. */
export async function listPullRequests(cwd: string): Promise<PrListEntry[]> {
  const out = await runOk('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,baseRefName,headRefOid,author'], { cwd });
  return PrListSchema.parse(JSON.parse(out));
}

/**
 * A PR's diff from GitHub, for a PR that isn't checked out. Read-only, and nothing is
 * fetched into .git (a `git fetch` would write to the repo).
 */
export async function pullRequestDiff(cwd: string, prNumber: number): Promise<string> {
  return runOk('gh', ['pr', 'diff', String(prNumber), '--color', 'never'], { cwd });
}

/** `gh api --paginate --jq '.[]'` emits one JSON object per line regardless of page count. */
async function apiList<T>(cwd: string, path: string, schema: z.ZodType<T>): Promise<T[]> {
  const out = await runOk('gh', ['api', '--paginate', path, '--jq', '.[]'], { cwd });
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}

const isHuman = (user: z.infer<typeof UserSchema>): user is { login: string; type?: string } =>
  user !== null && user.type !== 'Bot';

/**
 * Collect every human comment on the PR: inline review threads (with their
 * replies folded in), review summaries, and conversation comments.
 * `clauseId` is left empty; the spec generator assigns it.
 */
export async function fetchComments(cwd: string, prNumber: number): Promise<MarginComment[]> {
  const repo = 'repos/{owner}/{repo}';
  const [review, issue, reviews] = await Promise.all([
    apiList(cwd, `${repo}/pulls/${prNumber}/comments`, ReviewCommentSchema),
    apiList(cwd, `${repo}/issues/${prNumber}/comments`, IssueCommentSchema),
    apiList(cwd, `${repo}/pulls/${prNumber}/reviews`, ReviewSchema),
  ]);

  const comments: MarginComment[] = [];

  const roots = review.filter((c) => c.in_reply_to_id === undefined && isHuman(c.user));
  for (const root of roots) {
    const replies = review
      .filter((c) => c.in_reply_to_id === root.id && isHuman(c.user))
      .map((c) => `\n\n@${c.user?.login ?? 'unknown'}: ${c.body}`)
      .join('');
    // Only a current, new-side line is in the spec's coordinates. Outdated comments (line null;
    // original_line is from an older commit) and comments on removed lines (side LEFT) keep
    // their file but not a line number that would point at the wrong code.
    const line = root.side === 'LEFT' ? undefined : (root.line ?? undefined);
    comments.push({
      id: `rc-${root.id}`,
      author: root.user?.login ?? 'unknown',
      body: root.body + replies,
      ...(root.path ? { file: root.path } : {}),
      ...(line ? { line } : {}),
      clauseId: '',
      status: 'open',
    });
  }

  for (const r of reviews) {
    if (!r.body?.trim() || !isHuman(r.user)) continue;
    comments.push({ id: `rv-${r.id}`, author: r.user.login, body: r.body, clauseId: '', status: 'open' });
  }

  for (const c of issue) {
    if (!c.body.trim() || !isHuman(c.user)) continue;
    comments.push({ id: `ic-${c.id}`, author: c.user.login, body: c.body, clauseId: '', status: 'open' });
  }

  return comments;
}

function quote(text: string): string {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  return `> ${first.length > 140 ? `${first.slice(0, 140)}…` : first}`;
}

/** Post approved replies. Inline review comments get threaded replies; everything else becomes a quoted PR comment. */
export async function postReplies(cwd: string, prNumber: number, replies: ReplyDraft[]): Promise<PostedReply[]> {
  const results: PostedReply[] = [];
  for (const reply of replies) {
    const [kind, id] = reply.commentId.split('-');
    const args =
      kind === 'rc'
        ? ['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${prNumber}/comments/${id}/replies`, '-f', `body=${reply.body}`]
        : [
            'api',
            '-X',
            'POST',
            `repos/{owner}/{repo}/issues/${prNumber}/comments`,
            '-f',
            `body=${quote(reply.commentBody)}\n\n@${reply.author} ${reply.body}`,
          ];
    try {
      const res = await run('gh', args, { cwd });
      results.push(
        res.code === 0
          ? { commentId: reply.commentId, ok: true }
          : { commentId: reply.commentId, ok: false, error: res.stderr.trim() },
      );
    } catch (err) {
      results.push({ commentId: reply.commentId, ok: false, error: (err as Error).message });
    }
  }
  return results;
}
