import { join } from 'node:path';
import type {
  LoadTarget,
  MarginComment,
  PostedReply,
  PrListResponse,
  SessionInfo,
  SpecDocument,
  SpecView,
  SyncMode,
  SyncPlan,
  SyncResult,
} from '../shared/types.js';
import type { ActivityBus, Tracker } from './activity.js';
import { demoDocument } from './demo.js';
import { parseUnifiedDiff } from './diff.js';
import { currentBranch, diffAgainst, hasCommit, headCommit, isAncestor, isExcludedPath, resolveBaseRef } from './git.js';
import {
  fetchComments,
  findPullRequest,
  ghAvailable,
  listPullRequests,
  pullRequestDiff,
  type PullRequest,
} from './github.js';
import { generateSpec, modelLabel } from './spec.js';
import { buildPlan, executeSync, isSyncRunning, mergeEdits, postWrittenReplies, SyncBusyError, type SyncContext } from './sync.js';

export interface WorkspaceOptions {
  /** Repository root, or the current directory in demo mode (never written to). */
  root: string;
  artifactDir: string;
  /** Shown to the user: the root with the home directory shortened to ~. */
  displayRoot: string;
  base?: string;
  demo: boolean;
  dryRun: boolean;
  bus: ActivityBus;
}

interface Loaded {
  doc: SpecDocument;
  pr: PullRequest | null;
  /** The diff is the working tree's own, so Claude Code can apply edits here. */
  checkedOut: boolean;
  hasGh: boolean;
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';

/**
 * Everything redline has loaded, and the only way to change it. A spec can be
 * reloaded (after a run, or to switch PRs) without restarting the server.
 * Loading is read-only: git plumbing and gh reads only, nothing written to the repo.
 */
export class Workspace {
  private view: SpecView = { status: 'loading', label: 'Loading' };
  private loaded: Loaded | null = null;
  private target: LoadTarget = { kind: 'auto' };
  private loading: AbortController | null = null;
  private result: SyncResult | undefined;
  /** A real run succeeded against this spec id, so its CURRENT -> REQUIRED pairs are stale. */
  private appliedTo: string | null = null;
  private branch = '';

  constructor(private readonly opts: WorkspaceOptions) {}

  session(): SessionInfo {
    return {
      repo: this.opts.displayRoot,
      branch: this.branch,
      demo: this.opts.demo,
      dryRun: this.opts.dryRun,
      model: modelLabel(),
      artifactDir: this.opts.artifactDir,
    };
  }

  current(): SpecView {
    if (this.view.status !== 'ready') return this.view;
    return { ...this.view, ...(this.result ? { result: this.result } : {}) };
  }

  /**
   * Load `target` in the background; progress goes to the activity bus. A newer load
   * supersedes (and stops) an older one. Refused while Claude Code is editing files.
   */
  load(target: LoadTarget): void {
    if (isSyncRunning()) throw new SyncBusyError('Claude Code is still running. Wait for it to finish, then reload.');
    if (target.kind !== 'current') this.target = target;
    this.loading?.abort();
    const ctl = new AbortController();
    this.loading = ctl;
    this.view = { status: 'loading', label: this.label(this.target) };
    this.opts.bus.viewChanged();
    void this.run(this.target, ctl);
  }

  private label(target: LoadTarget): string {
    if (this.opts.demo) return 'demo PR';
    if (target.kind === 'pr') return `PR #${target.number}`;
    if (target.kind === 'local') return 'local changes';
    return 'this branch';
  }

  private async run(target: LoadTarget, ctl: AbortController): Promise<void> {
    const track = this.opts.bus.start('spec', this.opts.demo ? 'Loading the demo PR' : 'Reading the diff');
    try {
      const loaded = this.opts.demo ? this.demo() : await this.resolve(target, track, ctl.signal);
      if (ctl.signal.aborted) return;
      if ('empty' in loaded) {
        this.loaded = null;
        this.view = { status: 'empty', message: loaded.empty };
        track.done('Nothing to review');
        return;
      }
      this.loaded = loaded;
      this.result = undefined;
      this.view = {
        status: 'ready',
        doc: loaded.doc,
        canPostReplies: loaded.pr !== null && loaded.hasGh && !this.opts.demo && !this.opts.dryRun,
        ...(loaded.checkedOut
          ? {}
          : {
              runBlocked: `PR #${loaded.pr?.number} isn’t checked out here, so Claude Code can’t edit it. Run \`gh pr checkout ${loaded.pr?.number}\`, then Refresh.`,
            }),
      };
      const count = loaded.doc.sections.reduce((n, s) => n + s.clauses.length, 0);
      track.done(`Ready · ${count} sentence${count === 1 ? '' : 's'}`);
    } catch (err) {
      if (ctl.signal.aborted) return;
      this.loaded = null;
      this.view = { status: 'error', message: err instanceof Error ? err.message : String(err) };
      track.fail(firstLine(err));
    } finally {
      if (this.loading === ctl) this.loading = null;
      if (!ctl.signal.aborted) this.opts.bus.viewChanged();
    }
  }

  private demo(): Loaded {
    this.branch = 'feat/s3-ingest-pipeline';
    return { doc: demoDocument(), pr: null, checkedOut: true, hasGh: false };
  }

  /** The PR's head is this branch's own work, not some other branch (or one already merged into the base). */
  private async sameWork(pr: PullRequest, baseRef: string): Promise<boolean> {
    const root = this.opts.root;
    if (pr.headRefOid === undefined || !(await hasCommit(root, pr.headRefOid))) return pr.headRefName === this.branch;
    return (await isAncestor(root, pr.headRefOid, 'HEAD')) && !(await isAncestor(root, pr.headRefOid, baseRef));
  }

  private async resolve(target: LoadTarget, track: Tracker, signal: AbortSignal): Promise<Loaded | { empty: string }> {
    const root = this.opts.root;
    this.branch = await currentBranch(root);
    const hasGh = await ghAvailable(root);
    if (target.kind === 'pr' && !hasGh) throw new Error('Loading a PR needs the GitHub CLI. Install gh and run `gh auth login`.');
    const pr =
      target.kind === 'pr' ? await findPullRequest(root, target.number) : target.kind === 'auto' && hasGh ? await findPullRequest(root) : null;
    const baseRef = await resolveBaseRef(root, this.opts.base ?? pr?.baseRefName, this.branch);
    const checkedOut = pr ? await this.sameWork(pr, baseRef.ref) : true;

    let rawDiff: string;
    if (checkedOut) {
      track.phase(`Reading the diff of ${this.branch} against ${baseRef.ref}`);
      rawDiff = await diffAgainst(root, baseRef.ref);
    } else {
      track.phase(`Downloading the diff of PR #${pr?.number}`);
      rawDiff = await pullRequestDiff(root, pr!.number);
    }
    const files = parseUnifiedDiff(rawDiff).filter((f) => !isExcludedPath(f.path));
    if (files.length === 0) {
      if (pr) throw new Error(`PR #${pr.number} has no reviewable changes.`);
      return { empty: `No changes on ${this.branch} against ${baseRef.name}.` };
    }

    let comments: MarginComment[] = [];
    if (pr) {
      track.phase(`Fetching comments on PR #${pr.number}`);
      try {
        comments = await fetchComments(root, pr.number);
      } catch (err) {
        track.log(`Could not load comments, continuing without them: ${firstLine(err)}`);
      }
    }
    if (signal.aborted) throw new Error('Stopped.');

    const doc = await generateSpec(
      {
        prTitle: pr?.title ?? this.branch,
        ...(pr ? { prNumber: pr.number } : {}),
        branch: pr?.headRefName ?? this.branch,
        baseBranch: baseRef.name,
        rawDiff,
        files,
        comments,
        repoRoot: root,
        ...(checkedOut
          ? {}
          : {
              contextNote: `The repository on disk has ${this.branch} checked out, not this PR's branch (${pr?.headRefName}). Files outside the diff may differ from the PR's version; when they conflict, the diff is the truth.`,
            }),
        cacheDir: join(this.opts.artifactDir, 'cache'),
      },
      {
        onGenerate: () => track.phase(`Drafting behavioral spec · ${files.length} file${files.length === 1 ? '' : 's'}`),
        onStep: (step) => track.step(step),
        onLog: (line) => track.log(line),
        signal,
      },
    );
    return { doc, pr, checkedOut, hasGh };
  }

  async pullRequests(): Promise<PrListResponse> {
    const current = this.loaded ? (this.loaded.pr ? { kind: 'pr' as const, number: this.loaded.pr.number } : { kind: 'local' as const }) : null;
    if (this.opts.demo) {
      return { prs: [], branch: this.branch, current: null, note: 'The demo has one PR. Run redline in a repository to switch between PRs.' };
    }
    const root = this.opts.root;
    if (!(await ghAvailable(root))) {
      return { prs: [], branch: this.branch, current, note: 'Install gh and run `gh auth login` to list pull requests.' };
    }
    try {
      const [list, head] = await Promise.all([listPullRequests(root), headCommit(root).catch(() => '')]);
      return {
        prs: list.map((p) => ({
          number: p.number,
          title: p.title,
          author: p.author?.login ?? 'unknown',
          headRefName: p.headRefName,
          checkedOut: p.headRefName === this.branch || (p.headRefOid !== undefined && p.headRefOid === head),
        })),
        branch: this.branch,
        current,
        ...(list.length === 0 ? { note: 'No open pull requests in this repository.' } : {}),
      };
    } catch (err) {
      return { prs: [], branch: this.branch, current, note: `gh could not list pull requests: ${firstLine(err)}` };
    }
  }

  /** The loaded spec with the browser's edits on top. Refuses edits made against an older spec. */
  private edited(client: SpecDocument): { doc: SpecDocument; loaded: Loaded } {
    if (this.view.status !== 'ready' || !this.loaded) throw new SyncBusyError('The spec is reloading. Try again when it’s ready.');
    if (client.id !== this.loaded.doc.id) throw new SyncBusyError('This page shows an older spec. Reload the page.');
    return { doc: mergeEdits(this.loaded.doc, client), loaded: this.loaded };
  }

  private context(loaded: Loaded): SyncContext {
    return {
      workDir: this.opts.root,
      artifactDir: this.opts.artifactDir,
      demo: this.opts.demo,
      dryRun: this.opts.dryRun,
      canPostReplies: loaded.pr !== null && loaded.hasGh && !this.opts.demo && !this.opts.dryRun,
    };
  }

  plan(client: SpecDocument): SyncPlan {
    return buildPlan(this.edited(client).doc);
  }

  async sync(client: SpecDocument, mode: SyncMode): Promise<SyncResult> {
    const { doc, loaded } = this.edited(client);
    const real = mode === 'run' && !this.opts.demo && !this.opts.dryRun;
    if (real && !loaded.checkedOut && this.view.status === 'ready') throw new SyncBusyError(this.view.runBlocked ?? 'This PR is not checked out.');
    if (real && this.appliedTo === doc.id) {
      throw new SyncBusyError('These edits were already applied, so this spec no longer matches the code. Re-analyze the diff first.');
    }
    const result = await executeSync(doc, mode, this.context(loaded), () => this.opts.bus.start('sync', 'Starting Claude Code'));
    if (mode === 'run' && this.loaded?.doc.id === doc.id) {
      this.result = result;
      if (real && result.ok) this.appliedTo = doc.id;
      this.opts.bus.viewChanged();
    }
    return result;
  }

  postReplies(client: SpecDocument, commentIds: string[]): Promise<PostedReply[]> {
    const { doc, loaded } = this.edited(client);
    return postWrittenReplies(doc, commentIds, this.context(loaded));
  }
}
