export interface CodeAnchor {
  file: string;
  startLine: number;
  endLine: number;
  hunk: string; // raw unified diff hunk for inline peek
}

export interface MarginComment {
  id: string;
  author: string;
  body: string;
  file?: string;
  line?: number;
  clauseId: string; // maps to SpecClause.id
  replyDraft?: string;
  status: 'open' | 'resolved' | 'pushed_back';
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
  prTitle: string;
  prNumber?: number;
  branch: string;
  baseBranch: string;
  sections: SpecSection[];
  comments: MarginComment[];
}

/* ---- API contract (server <-> web) ---- */

export interface SessionInfo {
  /** Repository root, with the home directory shortened to ~. */
  repo: string;
  demo: boolean;
  dryRun: boolean;
  canPostReplies: boolean;
  model: string;
  /** Out-of-repo directory where plans, exports, and caches are written. */
  artifactDir: string;
  /** A Claude Code run already succeeded in this session; the spec is stale until restart. */
  applied: boolean;
}

export interface SpecResponse {
  session: SessionInfo;
  doc: SpecDocument;
}

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
  };
  changes?: WorkingTreeChange;
}

export interface ApiError {
  error: string;
}
