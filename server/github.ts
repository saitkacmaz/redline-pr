import { z } from 'zod';
import type { HiddenThread, MarginComment, PostedReply, ReplyDraft } from '../shared/types.js';
import { run } from './exec.js';
import { hasRemote } from './git.js';

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

/** gh reads give up after this, so an unreachable host can't hold a load open. */
const GH_TIMEOUT_MS = 30_000;

/** gh's own words for "this repository isn't on a GitHub host it knows". */
const NOT_ON_GITHUB = /no git remotes found|none of the git remotes configured for this repository point to a known github host|could not determine (base|current) repo/i;

/** The repo's remotes aren't on GitHub (GitLab, Bitbucket, a plain git server...). Not a failure: there are no PRs. */
export class NotOnGitHubError extends Error {
  constructor() {
    super('This repository’s remotes aren’t on GitHub, so there are no pull requests here.');
  }
}

/** Run a read-only gh command; a non-GitHub repo throws NotOnGitHubError rather than gh's raw message. */
async function ghRead(cwd: string, args: readonly string[]): Promise<string> {
  const res = await run('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS });
  if (res.code === 0) return res.stdout;
  if (NOT_ON_GITHUB.test(res.stderr)) throw new NotOnGitHubError();
  const why = res.timedOut ? 'timed out' : res.stderr.trim().split('\n')[0] || `exit ${res.code}`;
  throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${why}`);
}

/** Whether GitHub features can work here, and in one calm sentence why not. Never throws. */
export type GitHubAccess = { ok: true } | { ok: false; reason: 'no-remote' | 'no-gh' | 'no-login' | 'not-github'; note: string };

export const NOT_GITHUB_ACCESS: GitHubAccess = { ok: false, reason: 'not-github', note: new NotOnGitHubError().message };

/**
 * Checked before any GitHub call: a repo with no remote never runs gh at all. A remote on
 * another host is only discovered when gh says so (see NotOnGitHubError).
 */
export async function githubAccess(cwd: string): Promise<GitHubAccess> {
  if (!(await hasRemote(cwd))) return { ok: false, reason: 'no-remote', note: 'This repository has no remote, so there are no pull requests here.' };
  let auth;
  try {
    auth = await run('gh', ['auth', 'status'], { cwd, timeoutMs: GH_TIMEOUT_MS });
  } catch {
    return { ok: false, reason: 'no-gh', note: 'Pull requests need the GitHub CLI: install gh and run `gh auth login`.' };
  }
  if (auth.code !== 0) return { ok: false, reason: 'no-login', note: 'Pull requests need gh to be logged in: run `gh auth login`.' };
  return { ok: true };
}

/** The PR for `prNumber`, or for the current branch when omitted. Null when the branch has none. */
export async function findPullRequest(cwd: string, prNumber?: number): Promise<PullRequest | null> {
  const args = ['pr', 'view', ...(prNumber ? [String(prNumber)] : []), '--json', 'number,title,headRefName,baseRefName,headRefOid'];
  try {
    return PrSchema.parse(JSON.parse(await ghRead(cwd, args)));
  } catch (err) {
    if (prNumber || err instanceof NotOnGitHubError) throw err;
    return null;
  }
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
  const out = await ghRead(cwd, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,baseRefName,headRefOid,author']);
  return PrListSchema.parse(JSON.parse(out));
}

/**
 * A PR's diff from GitHub, for a PR that isn't checked out. Read-only, and nothing is
 * fetched into .git (a `git fetch` would write to the repo).
 */
export async function pullRequestDiff(cwd: string, prNumber: number): Promise<string> {
  return ghRead(cwd, ['pr', 'diff', String(prNumber), '--color', 'never']);
}

/** `gh api --paginate --jq '.[]'` emits one JSON object per line regardless of page count. */
async function apiList<T>(cwd: string, path: string, schema: z.ZodType<T>): Promise<T[]> {
  const out = await ghRead(cwd, ['api', '--paginate', path, '--jq', '.[]']);
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}

const isHuman = (user: z.infer<typeof UserSchema>): user is { login: string; type?: string } =>
  user !== null && user.type !== 'Bot';

/* ---- Review threads (GraphQL): GitHub knows which are resolved or outdated ---- */

const GqlCommentSchema = z.object({
  databaseId: z.number().nullable(),
  author: z.object({ login: z.string(), __typename: z.string().optional() }).nullable(),
  body: z.string(),
  createdAt: z.string(),
});

const ThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  originalLine: z.number().nullable().optional(),
  diffSide: z.string().nullable().optional(),
  // The opening comment, and the latest ones: a long thread's newest reply is the one that matters.
  opening: z.object({ nodes: z.array(GqlCommentSchema) }),
  recent: z.object({ totalCount: z.number(), nodes: z.array(GqlCommentSchema) }),
});
export type ReviewThread = z.infer<typeof ThreadSchema>;

const ThreadsPageSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        author: z.object({ login: z.string() }).nullable(),
        reviewThreads: z.object({
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          nodes: z.array(ThreadSchema),
        }),
      }),
    }),
  }),
});

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { login }
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          opening: comments(first: 1) { nodes { databaseId author { login __typename } body createdAt } }
          recent: comments(last: 20) { totalCount nodes { databaseId author { login __typename } body createdAt } }
        }
      }
    }
  }
}`;

const MAX_THREAD_PAGES = 20;

/** Every review thread on the PR (paginated), plus the PR author. Read-only. */
export async function fetchReviewThreads(cwd: string, prNumber: number): Promise<{ threads: ReviewThread[]; prAuthor: string | undefined }> {
  const threads: ReviewThread[] = [];
  let prAuthor: string | undefined;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const out = await ghRead(cwd, [
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'name={repo}',
      '-F',
      `number=${prNumber}`,
      ...(cursor ? ['-f', `cursor=${cursor}`] : []),
      '-f',
      `query=${THREADS_QUERY}`,
    ]);
    const pr = ThreadsPageSchema.parse(JSON.parse(out)).data.repository.pullRequest;
    prAuthor ??= pr.author?.login;
    threads.push(...pr.reviewThreads.nodes);
    if (!pr.reviewThreads.pageInfo.hasNextPage || !pr.reviewThreads.pageInfo.endCursor) break;
    cursor = pr.reviewThreads.pageInfo.endCursor;
  }
  return { threads, prAuthor };
}

type GqlComment = z.infer<typeof GqlCommentSchema>;
const isHumanGql = (c: GqlComment): c is GqlComment & { author: { login: string } } =>
  c.author !== null && c.author.__typename !== 'Bot';

/**
 * Deterministic triage, no model involved: resolved and outdated threads are hidden
 * (counted, never in the margin or the prompt); each open thread becomes one margin item
 * with its replies, flagged `replied` when the PR author has the last word.
 */
export function triageThreads(threads: ReviewThread[], prAuthor: string | undefined): { comments: MarginComment[]; hidden: HiddenThread[] } {
  const comments: MarginComment[] = [];
  const hidden: HiddenThread[] = [];
  for (const thread of threads) {
    const seen = new Set<number>();
    const messages = [...thread.opening.nodes, ...thread.recent.nodes].filter((c) => {
      if (c.databaseId === null || seen.has(c.databaseId)) return false;
      seen.add(c.databaseId);
      return true;
    });
    const root = messages[0];
    // A bot-opened thread isn't review feedback; one we can't reply to (no id) can't be acted on.
    if (!root || !isHumanGql(root) || root.databaseId === null) continue;
    const id = `rc-${root.databaseId}`;
    const replies = messages.slice(1).filter(isHumanGql);
    if (thread.isResolved || thread.isOutdated) {
      hidden.push({
        id,
        author: root.author.login,
        body: root.body,
        ...(thread.path ? { file: thread.path } : {}),
        reason: thread.isResolved ? 'resolved' : 'outdated',
        replyCount: Math.max(0, thread.recent.totalCount - 1),
      });
      continue;
    }
    // Only a current, new-side line is in the spec's coordinates.
    const line = thread.diffSide === 'LEFT' ? undefined : (thread.line ?? undefined);
    const omitted = thread.recent.totalCount - messages.length;
    const last = replies.at(-1);
    comments.push({
      id,
      author: root.author.login,
      body: root.body,
      ...(thread.path ? { file: thread.path } : {}),
      ...(line ? { line } : {}),
      ...(replies.length > 0 ? { replies: replies.map((r) => ({ author: r.author.login, body: r.body })) } : {}),
      ...(omitted > 0 ? { omittedReplies: omitted } : {}),
      ...(last && prAuthor && last.author.login === prAuthor ? { replied: true } : {}),
      clauseId: '',
      status: 'open',
    });
  }
  return { comments, hidden };
}

/** REST review comments, for when GraphQL isn't available. No resolved/outdated information. */
async function restReviewComments(cwd: string, prNumber: number): Promise<MarginComment[]> {
  const review = await apiList(cwd, `repos/{owner}/{repo}/pulls/${prNumber}/comments`, ReviewCommentSchema);
  return review
    .filter((c) => c.in_reply_to_id === undefined && isHuman(c.user))
    .map((root) => {
      const replies = review.filter((c) => c.in_reply_to_id === root.id && isHuman(c.user));
      const line = root.side === 'LEFT' ? undefined : (root.line ?? undefined);
      return {
        id: `rc-${root.id}`,
        author: root.user?.login ?? 'unknown',
        body: root.body,
        ...(root.path ? { file: root.path } : {}),
        ...(line ? { line } : {}),
        ...(replies.length > 0 ? { replies: replies.map((r) => ({ author: r.user?.login ?? 'unknown', body: r.body })) } : {}),
        clauseId: '',
        status: 'open' as const,
      };
    });
}

export interface PrComments {
  comments: MarginComment[];
  hidden: HiddenThread[];
  /** Set when resolved/outdated filtering wasn't possible. */
  warning?: string;
}

/**
 * Every human comment that still needs attention: open review threads (from GraphQL,
 * so resolved and outdated ones are set aside), review summaries, and conversation comments.
 * `clauseId` is left empty; the spec generator assigns it.
 */
export async function fetchComments(cwd: string, prNumber: number): Promise<PrComments> {
  const repo = 'repos/{owner}/{repo}';
  const [threadResult, issue, reviews] = await Promise.all([
    fetchReviewThreads(cwd, prNumber).then(
      (r) => ({ ok: true as const, ...triageThreads(r.threads, r.prAuthor) }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    apiList(cwd, `${repo}/issues/${prNumber}/comments`, IssueCommentSchema),
    apiList(cwd, `${repo}/pulls/${prNumber}/reviews`, ReviewSchema),
  ]);

  let comments: MarginComment[];
  let hidden: HiddenThread[] = [];
  let warning: string | undefined;
  if (threadResult.ok) {
    comments = threadResult.comments;
    hidden = threadResult.hidden;
  } else {
    comments = await restReviewComments(cwd, prNumber);
    const why = threadResult.err instanceof Error ? threadResult.err.message.split('\n')[0] : String(threadResult.err);
    warning = `Could not read review threads over GraphQL, so resolved and outdated ones are shown too: ${why}`;
  }

  for (const r of reviews) {
    if (!r.body?.trim() || !isHuman(r.user)) continue;
    comments.push({ id: `rv-${r.id}`, author: r.user.login, body: r.body, clauseId: '', status: 'open' });
  }
  for (const c of issue) {
    if (!c.body.trim() || !isHuman(c.user)) continue;
    comments.push({ id: `ic-${c.id}`, author: c.user.login, body: c.body, clauseId: '', status: 'open' });
  }
  return { comments, hidden, ...(warning ? { warning } : {}) };
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
