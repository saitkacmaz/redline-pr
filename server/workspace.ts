import type {
  AgentName,
  ProviderStatuses,
  HiddenThread,
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
import { currentBranch, diffAgainst, hasCommit, headCommit, isAncestor, isExcludedPath, NoBaseBranchError, resolveBaseRef } from './git.js';
import {
  fetchComments,
  findPullRequest,
  githubAccess,
  listPullRequests,
  NOT_GITHUB_ACCESS,
  NotOnGitHubError,
  pullRequestDiff,
  type GitHubAccess,
  type PullRequest,
} from './github.js';
import { detectProviders, PROVIDERS } from './providers/index.js';
import { generateSpec } from './spec.js';
import { assertSyncFree, buildPlan, executeSync, isSyncRunning, mergeEdits, postWrittenReplies, SyncBusyError, type SyncContext } from './sync.js';

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
  /** Chosen at launch: writes every spec this session, and runs Sync unless the page asks for the other. */
  agent: AgentName;
  /** Each agent's install and login state at launch; re-checked on every load. */
  providers: ProviderStatuses;
  /** --model / REDLINE_MODEL: meant for the launch agent, so a Claude model name never reaches Codex. */
  model?: string;
}

/** Nothing to review, and what to do about it. */
interface Empty {
  empty: string;
  hint: string;
  github: GitHubAccess;
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
  private providers: ProviderStatuses;

  constructor(private readonly opts: WorkspaceOptions) {
    this.providers = opts.providers;
  }

  /** Re-check logins (someone may have run `codex login` meanwhile). Never blocks a load. */
  private async refreshProviders(): Promise<void> {
    if (this.opts.demo) return;
    const next = await detectProviders().catch(() => this.providers);
    if (JSON.stringify(next) === JSON.stringify(this.providers)) return;
    this.providers = next;
    this.opts.bus.viewChanged();
  }

  /** The model for `agent`: the override applies only to the agent it was given for. */
  private modelFor(agent: AgentName): string | undefined {
    return agent === this.opts.agent ? this.opts.model : undefined;
  }

  session(): SessionInfo {
    return {
      repo: this.opts.displayRoot,
      branch: this.branch,
      demo: this.opts.demo,
      dryRun: this.opts.dryRun,
      model: this.opts.model ?? `${PROVIDERS[this.opts.agent].label} default model`,
      artifactDir: this.opts.artifactDir,
      activeAgent: this.opts.agent,
      providers: this.providers,
    };
  }

  current(): SpecView {
    if (this.view.status !== 'ready') return this.view;
    return { ...this.view, ...(this.result ? { result: this.result } : {}) };
  }

  /**
   * Load `target` in the background; progress goes to the activity bus. A newer load
   * supersedes (and stops) an older one. Refused while an agent is editing files.
   */
  load(target: LoadTarget): void {
    if (isSyncRunning()) throw new SyncBusyError('A Sync is still running. Wait for it to finish, then reload.');
    if (target.kind !== 'current') this.target = target;
    void this.refreshProviders();
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
        this.view = { status: 'empty', message: loaded.empty, hint: loaded.hint, offerPrs: loaded.github.ok };
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
              runBlocked: `PR #${loaded.pr?.number} isn’t checked out here, so its code can’t be edited. Run \`gh pr checkout ${loaded.pr?.number}\`, then Refresh.`,
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

  private async resolve(target: LoadTarget, track: Tracker, signal: AbortSignal): Promise<Loaded | Empty> {
    const root = this.opts.root;
    let github = await githubAccess(root);
    if (!(await hasCommit(root, 'HEAD'))) {
      this.branch = '';
      return { empty: 'This repository has no commits yet.', hint: 'Commit some work on a branch, then Refresh.', github };
    }
    this.branch = await currentBranch(root);
    if (target.kind === 'pr' && !github.ok) {
      throw new Error(`Can’t load PR #${target.number}. ${github.note} The local branch diff works: pick it from the title above.`);
    }

    // Without GitHub this is simply a local review: no PR, no comments, no error.
    let pr: PullRequest | null = null;
    if (github.ok && target.kind !== 'local') {
      try {
        pr = await findPullRequest(root, target.kind === 'pr' ? target.number : undefined);
      } catch (err) {
        if (!(err instanceof NotOnGitHubError)) throw err;
        if (target.kind === 'pr') throw new Error(`Can’t load PR #${target.number}. ${err.message} The local branch diff works: pick it from the title above.`);
        github = NOT_GITHUB_ACCESS;
      }
    }
    const hasGh = github.ok;

    let baseRef: { name: string; ref: string };
    try {
      baseRef = await resolveBaseRef(root, this.opts.base ?? pr?.baseRefName, this.branch);
    } catch (err) {
      if (!(err instanceof NoBaseBranchError)) throw err;
      return { empty: err.message, hint: 'Run `redline --base <branch>` with the branch this work started from.', github };
    }
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
      return {
        empty: `No changes on ${this.branch} against ${baseRef.name}.`,
        hint: github.ok ? 'Pick a pull request from the title above, or make a change and Refresh.' : 'Make a change and Refresh.',
        github,
      };
    }

    let comments: MarginComment[] = [];
    let hiddenThreads: HiddenThread[] = [];
    if (pr) {
      track.phase(`Fetching comments on PR #${pr.number}`);
      try {
        const fetched = await fetchComments(root, pr.number);
        comments = fetched.comments;
        hiddenThreads = fetched.hidden;
        if (fetched.warning) track.log(fetched.warning);
        if (hiddenThreads.length > 0) track.log(`Set aside ${hiddenThreads.length} resolved or outdated thread${hiddenThreads.length === 1 ? '' : 's'}`);
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
        artifactDir: this.opts.artifactDir,
        agent: PROVIDERS[this.opts.agent],
        ...(this.opts.model ? { model: this.opts.model } : {}),
      },
      {
        onGenerate: () => track.phase(`Drafting behavioral spec · ${files.length} file${files.length === 1 ? '' : 's'}`),
        onStep: (step) => track.step(step),
        onLog: (line) => track.log(line),
        signal,
      },
    );
    return { doc: hiddenThreads.length > 0 ? { ...doc, hiddenThreads } : doc, pr, checkedOut, hasGh };
  }

  async pullRequests(): Promise<PrListResponse> {
    const current = this.loaded ? (this.loaded.pr ? { kind: 'pr' as const, number: this.loaded.pr.number } : { kind: 'local' as const }) : null;
    if (this.opts.demo) {
      return { prs: [], branch: this.branch, current: null, note: 'The demo has one PR. Run redline in a repository to switch between PRs.' };
    }
    const root = this.opts.root;
    const github = await githubAccess(root);
    if (!github.ok) return { prs: [], branch: this.branch, current, note: github.note };
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
      const note = err instanceof NotOnGitHubError ? err.message : `Couldn’t list pull requests from GitHub (${firstLine(err)}). The local branch diff still works.`;
      return { prs: [], branch: this.branch, current, note };
    }
  }

  /** The loaded spec with the browser's edits on top. Refuses edits made against an older spec. */
  private edited(client: SpecDocument): { doc: SpecDocument; loaded: Loaded } {
    if (this.view.status !== 'ready' || !this.loaded) throw new SyncBusyError('The spec is reloading. Try again when it’s ready.');
    if (client.id !== this.loaded.doc.id) throw new SyncBusyError('This page shows an older spec. Reload the page.');
    return { doc: mergeEdits(this.loaded.doc, client), loaded: this.loaded };
  }

  private context(loaded: Loaded, agent: AgentName = this.opts.agent): SyncContext {
    return {
      workDir: this.opts.root,
      artifactDir: this.opts.artifactDir,
      demo: this.opts.demo,
      dryRun: this.opts.dryRun,
      canPostReplies: loaded.pr !== null && loaded.hasGh && !this.opts.demo && !this.opts.dryRun,
      agent: PROVIDERS[agent],
      ...(this.modelFor(agent) ? { model: this.modelFor(agent) } : {}),
    };
  }

  plan(client: SpecDocument): SyncPlan {
    return buildPlan(this.edited(client).doc);
  }

  /** Run (or export) with `agent`, the launch agent by default. One run at a time, whichever agent. */
  async sync(client: SpecDocument, mode: SyncMode, agent: AgentName = this.opts.agent): Promise<SyncResult> {
    // First, before anything can await: a second request while one runs is a 409, whatever else is wrong with it.
    if (mode === 'run') assertSyncFree();
    const { doc, loaded } = this.edited(client);
    const real = mode === 'run' && !this.opts.demo && !this.opts.dryRun;
    const status = this.providers[agent];
    if (real && !(status.installed && status.loggedIn)) throw new SyncBusyError(PROVIDERS[agent].unavailable(status));
    if (real && !loaded.checkedOut && this.view.status === 'ready') throw new SyncBusyError(this.view.runBlocked ?? 'This PR is not checked out.');
    if (real && this.appliedTo === doc.id) {
      throw new SyncBusyError('These edits were already applied, so this spec no longer matches the code. Re-analyze the diff first.');
    }
    const result = await executeSync(doc, mode, this.context(loaded, agent), () => this.opts.bus.start('sync', `Starting ${PROVIDERS[agent].label}`));
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
