export interface CodeAnchor {
  file: string;
  startLine: number;
  endLine: number;
  hunk: string; // raw unified diff hunk for inline peek
}

export interface ThreadReply {
  author: string;
  body: string;
}

/** An open review thread (or a PR-level comment): the opening comment plus its replies. */
export interface MarginComment {
  id: string;
  author: string;
  body: string;
  file?: string;
  line?: number;
  /** Later messages in the same thread, oldest first. */
  replies?: ThreadReply[];
  /** Replies GitHub has but that weren't fetched (very long threads). */
  omittedReplies?: number;
  /** The PR author wrote the last message: the thread is waiting on the reviewer. */
  replied?: boolean;
  clauseId: string; // maps to SpecClause.id
  replyDraft?: string;
  status: 'open' | 'resolved' | 'pushed_back';
}

/** A review thread left out of the margin and the prompt because GitHub marks it resolved or outdated. */
export interface HiddenThread {
  id: string;
  author: string;
  body: string;
  file?: string;
  reason: 'resolved' | 'outdated';
  replyCount: number;
}

export interface SpecClause {
  id: string;
  originalText: string;
  currentText: string; // mutated when user edits
  anchors: CodeAnchor[];
  riskFlag?: string; // optional 3-5 word subtle callout e.g. "silent error swallow"
}

export interface SpecSection {
  id: string;
  title: string; // e.g. "File Ingestion Flow"
  clauses: SpecClause[];
}

export interface SpecDocument {
  /** Identifies this loaded spec. Edits made against a different (older) spec are refused. */
  id: string;
  prTitle: string;
  prNumber?: number;
  branch: string;
  baseBranch: string;
  sections: SpecSection[];
  comments: MarginComment[];
  /** Resolved and outdated threads: counted and inspectable, never in the margin or the prompt. */
  hiddenThreads?: HiddenThread[];
}

/* ---- API contract (server <-> web) ---- */

export interface SessionInfo {
  /** Repository root, with the home directory shortened to ~. */
  repo: string;
  /** The branch checked out in the repo (as of the last load). */
  branch: string;
  demo: boolean;
  dryRun: boolean;
  model: string;
  /** Out-of-repo directory where plans, exports, and caches are written. */
  artifactDir: string;
}

/** What the server has loaded right now. */
export type SpecView =
  | { status: 'loading'; label: string }
  | {
      status: 'ready';
      doc: SpecDocument;
      canPostReplies: boolean;
      /** Why Run with Claude Code is unavailable for this spec, if it is. */
      runBlocked?: string;
      /** The last Run for this spec. After a real, successful one the spec is stale until re-analyzed. */
      result?: SyncResult;
    }
  | {
      status: 'empty';
      message: string;
      /** What to do next, in one sentence. */
      hint: string;
      /** GitHub works here, so the PR list is worth offering. */
      offerPrs: boolean;
    }
  | { status: 'error'; message: string };

export interface SpecResponse {
  session: SessionInfo;
  view: SpecView;
}

/** What to load: the current branch's PR (or its local diff), a specific PR, or the local diff. */
export type LoadTarget = { kind: 'auto' } | { kind: 'local' } | { kind: 'pr'; number: number } | { kind: 'current' };

export interface PrListItem {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  /** This PR's branch is what's checked out, so Claude Code can apply edits to it. */
  checkedOut: boolean;
}

export interface PrListResponse {
  prs: PrListItem[];
  branch: string;
  /** What's loaded now. */
  current: { kind: 'pr'; number: number } | { kind: 'local' } | null;
  /** Why the list is empty or incomplete, in one sentence. */
  note?: string;
}

/* ---- Live progress (Server-Sent Events on /api/events) ---- */

export interface Activity {
  id: number;
  kind: 'spec' | 'sync';
  state: 'running' | 'done' | 'error';
  /** The real current step, e.g. "Editing src/ingest.py". */
  step: string;
  startedAt: number;
  endedAt?: number;
}

export type ServerEvent =
  | { type: 'activity'; activity: Activity }
  | { type: 'log'; id: number; line: string }
  /** The loaded spec changed; refetch /api/spec. */
  | { type: 'view' };

/** One edited sentence in the surgical spec.diff. */
export interface SpecDiffEntry {
  clauseId: string;
  sectionTitle: string;
  before: string;
  after: string;
  anchors: CodeAnchor[];
  comments: MarginComment[];
}

/** A teammate comment the user chose to answer instead of changing code. */
export interface PushBack {
  comment: MarginComment;
  clauseText: string;
}

export interface ReplyDraft {
  commentId: string;
  author: string;
  commentBody: string;
  body: string;
}

export interface SyncPlan {
  entries: SpecDiffEntry[];
  pushBacks: PushBack[];
  replies: ReplyDraft[];
  targetFiles: string[];
  specDiff: string; // plain-text spec.diff
  prompt: string; // exact prompt that would be piped to `claude -p`
  markdown: string; // redline-sync.md export
}

export type SyncMode = 'run' | 'export';

export interface SyncRequest {
  doc: SpecDocument;
  mode: SyncMode;
}

/** Post the user's written replies. Separate from running code changes, and never automatic. */
export interface PostRepliesRequest {
  doc: SpecDocument;
  commentIds: string[];
}

export interface PostedReply {
  commentId: string;
  ok: boolean;
  error?: string;
}

/** What Claude Code changed in the working tree during a run. */
export interface WorkingTreeChange {
  /** Paths whose contents changed (tracked) or that appeared (untracked). */
  files: string[];
  /** Unified diff of the changed tracked files against HEAD. */
  diff: string;
}

export interface SyncResult {
  mode: SyncMode;
  /** What actually happened, in one sentence. */
  summary: string;
  ok: boolean;
  writtenFile?: string;
  claude?: {
    exitCode: number;
    output: string;
    /** The saved Claude Code session; `claude --resume <id>` in the repo picks it up. */
    sessionId?: string;
  };
  changes?: WorkingTreeChange;
  elapsedMs?: number;
}

export interface ApiError {
  error: string;
}
