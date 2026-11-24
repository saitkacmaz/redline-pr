import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Activity, PostedReply, SessionInfo, SpecDocument, SyncMode, SyncPlan, SyncResult } from '../../../shared/types';
import { api } from '../api';
import { AutoTextarea } from './AutoTextarea';
import { Hairline } from './Hairline';
import { DiffLines } from './HunkPeek';
import { Redline } from './Redline';
import { LogPeek, StatusLine } from './StatusLine';

interface Props {
  doc: SpecDocument;
  session: SessionInfo;
  canPostReplies: boolean;
  /** Why Run is unavailable for this spec (e.g. the PR isn't checked out). */
  runBlocked?: string | undefined;
  /** The last run's result, kept by the app (and the server) so closing the sheet doesn't lose it. */
  result: SyncResult | null;
  onResult: (result: SyncResult) => void;
  activity: Activity | null;
  log: string[];
  posted: Record<string, PostedReply>;
  onPosted: (replies: PostedReply[]) => void;
  onReply: (commentId: string, text: string) => void;
  onReanalyze: () => void;
  /** Back to the spec (browser history back). */
  onBack: () => void;
}

function Label({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted">{children}</h2>;
}

const anchorText = (a: { file: string; startLine: number; endLine: number }): string =>
  `${a.file}:${a.startLine}${a.endLine !== a.startLine ? `-${a.endLine}` : ''}`;

const shellQuote = (path: string): string => (/^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`);

/** The run's Claude Code session, one paste away from continuing it by hand. */
function ResumeLine({ repo, sessionId }: { repo: string; sessionId: string }) {
  const [copied, setCopied] = useState(false);
  const command = `cd ${shellQuote(repo)} && claude --resume ${sessionId}`;
  return (
    <div className="mt-6">
      <p className="text-[12.5px] text-muted">Continue this Claude Code session in your terminal</p>
      <div className="mt-1 flex items-baseline gap-3">
        <code className="min-w-0 font-mono text-[12.5px] break-all text-ink">{command}</code>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(command).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
          className="shrink-0 cursor-pointer text-[12px] text-muted hover:text-ink"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const PRIMARY =
  'h-9 cursor-pointer rounded-[3px] bg-ink px-4 text-[13.5px] font-medium text-paper hover:bg-ink/85 disabled:cursor-default disabled:opacity-35';
const SECONDARY =
  'h-9 cursor-pointer rounded-[3px] border border-rule px-4 text-[13.5px] text-ink hover:border-ink/40 disabled:cursor-default disabled:opacity-35';

/**
 * The Sync page: a view of its own at #sync, so the browser's Back button (or Esc, or
 * "Back to spec") returns to the spec with every edit and reply intact.
 */
export function SyncView(props: Props) {
  const { doc, session, canPostReplies, runBlocked, result, onResult, activity, log, posted, onPosted, onReply, onReanalyze, onBack } = props;
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SyncMode | 'post' | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const syncActivity = activity?.kind === 'sync' ? activity : null;
  const running = busy === 'run' || syncActivity?.state === 'running';

  useEffect(() => heading.current?.focus(), []);

  // Re-plan only when sentences or push-backs change, not on every keystroke in a reply.
  const planKey = JSON.stringify([
    doc.sections.flatMap((s) => s.clauses.map((c) => c.currentText)),
    doc.comments.map((c) => c.status),
  ]);
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    let live = true;
    api
      .plan(docRef.current)
      .then((p) => live && setPlan(p))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [planKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || busy || running) return;
      // Escape inside a reply leaves the field; a second Escape goes back to the spec.
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'TEXTAREA') {
        target.blur();
        return;
      }
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, running, onBack]);

  const attempt = async (what: SyncMode | 'post', fn: () => Promise<void>): Promise<void> => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const run = (): Promise<void> => attempt('run', async () => onResult(await api.sync({ doc, mode: 'run' })));
  const exportDiff = (): Promise<void> =>
    attempt('export', async () => {
      const copied = plan ? await navigator.clipboard.writeText(plan.markdown).then(() => true, () => false) : false;
      const res = await api.sync({ doc, mode: 'export' });
      setExported(`${copied ? 'Copied to the clipboard and saved' : 'Saved'} to ${res.writtenFile ?? 'the cache'}.`);
    });

  // Every comment the user started a reply to stays listed, even if they clear it while editing.
  const replies = doc.comments.filter((c) => c.replyDraft !== undefined || posted[c.id]);
  const unposted = replies.filter((c) => c.replyDraft?.trim() && !posted[c.id]?.ok);
  const postReplies = (): Promise<void> =>
    attempt('post', async () => onPosted(await api.replies(doc, unposted.map((c) => c.id))));

  // A run that finished cleanly leaves this spec describing code that no longer exists: re-analyze next.
  const ran = result?.mode === 'run' && result.ok;
  const hasEdits = (plan?.entries.length ?? 0) > 0;
  const runNote = runBlocked
    ? runBlocked
    : session.demo
    ? 'Demo: Run writes the plan to sync-plan.md in redline’s cache instead of running Claude Code.'
    : session.dryRun
      ? 'Dry run: Run writes the plan to sync-plan.md in redline’s cache instead of running Claude Code.'
      : `Claude Code edits files in ${session.repo} without asking before each change. Nothing is committed or pushed.`;
  const postOff = session.demo
    ? 'Posting is off in the demo.'
    : session.dryRun
      ? 'Posting is off with --dry-run.'
      : 'No pull request is linked to this branch, so replies can’t be posted.';

  return (
    <div data-view="sync" aria-labelledby="sync-title">
      <header className="sticky top-0 z-10 border-b border-rule bg-paper">
        <div className="mx-auto flex h-12 max-w-[760px] items-center gap-4 px-6">
          <button
            type="button"
            onClick={onBack}
            disabled={busy !== null || running}
            className="cursor-pointer text-[13px] text-muted hover:text-ink disabled:cursor-default disabled:opacity-40"
          >
            ← Back to spec
          </button>
          <h1 id="sync-title" ref={heading} tabIndex={-1} className="text-[14px] font-medium outline-none">
            Sync review
          </h1>
          <span className="font-mono text-[12px] text-muted">{doc.branch}</span>
        </div>
        <Hairline activity={syncActivity} />
      </header>

      <main className="mx-auto max-w-[760px] px-6 pt-12 pb-32">
        {!plan && !error && <p className="text-[15px] text-muted">Preparing…</p>}
        {error && (
          <p role="alert" className="mb-8 text-[15px] text-del">
            {error}
          </p>
        )}

        {plan && (
          <>
            <section className="mb-14">
              <Label>spec.diff · {plural(plan.entries.length, 'sentence', 'sentences')}</Label>
              {!hasEdits ? (
                <p className="text-[15px] text-muted">
                  No sentences edited. Click any sentence in the spec to rewrite what the code should do.
                </p>
              ) : (
                <div className="space-y-8">
                  {plan.entries.map((e) => (
                    <div key={e.clauseId}>
                      <div className="mb-1 text-[12px] text-muted">{e.sectionTitle}</div>
                      <Redline before={e.before} after={e.after} />
                      <div className="mt-1.5 font-mono text-[12px] text-muted">{e.anchors.map(anchorText).join('  ')}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {plan.pushBacks.length > 0 && (
              <section className="mb-14">
                <Label>Pushed back · Claude Code is told not to act on these</Label>
                <div className="space-y-4">
                  {plan.pushBacks.map((p) => (
                    <p key={p.comment.id} className="text-[14.5px] leading-[1.6]">
                      <span className="font-semibold">@{p.comment.author}</span> <span className="text-muted">{p.comment.body}</span>
                    </p>
                  ))}
                </div>
              </section>
            )}

            <section className="mb-14 border-t border-rule pt-8">
              {!ran && (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={busy !== null || running || !hasEdits || runBlocked !== undefined}
                      onClick={() => void run()}
                      className={PRIMARY}
                    >
                      {running ? 'Running…' : 'Run with Claude Code'}
                    </button>
                    <button type="button" disabled={busy !== null} onClick={() => void exportDiff()} className={SECONDARY}>
                      {busy === 'export' ? 'Exporting…' : 'Copy / Export Spec Diff'}
                    </button>
                    <button
                      type="button"
                      aria-expanded={showPrompt}
                      onClick={() => setShowPrompt((v) => !v)}
                      className="ml-auto cursor-pointer text-[12.5px] text-muted hover:text-ink"
                    >
                      {showPrompt ? 'hide prompt' : 'show prompt'}
                    </button>
                  </div>
                  {running && syncActivity ? (
                    <div className="mt-5">
                      <StatusLine activity={syncActivity} />
                      <LogPeek lines={log} />
                    </div>
                  ) : (
                    <p className="mt-3 text-[12.5px] text-muted">{runNote}</p>
                  )}
                  {exported && (
                    <p aria-live="polite" className="mt-2 text-[12.5px] text-ink">
                      {exported}
                    </p>
                  )}
                  {showPrompt && (
                    <pre className="mt-6 max-h-[480px] overflow-auto border-l border-rule pl-4 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-ink/85">
                      {plan.prompt}
                    </pre>
                  )}
                </>
              )}

              {result?.mode === 'run' && !running && (
                <div aria-live="polite" className={ran ? '' : 'mt-8'}>
                  <p className={`leading-[1.5] ${ran ? 'text-[17px] font-medium text-ink' : 'text-[15px] text-del'}`}>{result.summary}</p>
                  {result.changes && result.changes.files.length > 0 && (
                    <ul className="mt-2 font-mono text-[12.5px] leading-[1.7] text-ink">
                      {result.changes.files.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                  {ran && (
                    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <button type="button" onClick={onReanalyze} className={PRIMARY}>
                        Re-analyze diff
                      </button>
                      <span className="text-[12.5px] text-muted">
                        Reads the updated code and writes a fresh spec. These redlines are cleared.
                      </span>
                    </div>
                  )}
                  {result.claude?.sessionId && <ResumeLine repo={session.repo} sessionId={result.claude.sessionId} />}
                  {syncActivity && <LogPeek lines={log} />}
                  {result.changes && result.changes.diff && (
                    <div className="mt-8 border-l border-ink/80 pl-4">
                      <DiffLines hunk={result.changes.diff} />
                    </div>
                  )}
                  {result.claude?.output && (
                    <details className="mt-5">
                      <summary className="cursor-pointer text-[12.5px] text-muted hover:text-ink">Claude Code’s notes</summary>
                      <pre className="mt-3 max-h-[520px] overflow-auto font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap">
                        {result.claude.output}
                      </pre>
                    </details>
                  )}
                  {ran && !session.demo && !session.dryRun && (
                    <p className="mt-5 text-[13px] text-muted">
                      Nothing was committed. Review it with <code className="font-mono text-[0.875em]">git diff</code>.
                    </p>
                  )}
                </div>
              )}
            </section>

            {doc.comments.length > 0 && (
              <section className="border-t border-rule pt-8">
                <Label>Your replies{doc.prNumber !== undefined ? ` · posted as you on #${doc.prNumber}` : ''}</Label>
                {replies.length === 0 ? (
                  <p className="text-[15px] text-muted">None yet. Write one in the margin beside a comment.</p>
                ) : (
                  <div className="space-y-7">
                    {replies.map((c) => {
                      const status = posted[c.id];
                      return (
                        <div key={c.id}>
                          <p className="text-[13.5px] leading-[1.55] text-muted">
                            <span className="font-semibold text-ink">@{c.author}</span> {c.body.split('\n')[0]}
                          </p>
                          <div className="mt-2 border-l border-rule pl-4 focus-within:border-ink/70">
                            <AutoTextarea
                              value={c.replyDraft ?? ''}
                              onChange={(text) => onReply(c.id, text)}
                              readOnly={status?.ok === true}
                              placeholder="Empty replies are not posted."
                              aria-label={`Reply to ${c.author}`}
                              className="text-[15px] leading-[1.6] text-ink"
                            />
                          </div>
                          {status && (
                            <p className={`mt-1.5 ml-4 text-[12px] ${status.ok ? 'text-muted' : 'text-del'}`}>
                              {status.ok ? 'Posted.' : `Not posted: ${status.error ?? 'unknown error'}`}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {replies.length > 0 && (
                  <div className="mt-8">
                    {canPostReplies ? (
                      <>
                        <button
                          type="button"
                          disabled={busy !== null || unposted.length === 0}
                          onClick={() => void postReplies()}
                          className={SECONDARY}
                        >
                          {busy === 'post'
                            ? 'Posting…'
                            : unposted.length === 0
                              ? 'All replies posted'
                              : `Post ${plural(unposted.length, 'reply', 'replies')} to GitHub`}
                        </button>
                        <p className="mt-3 text-[12.5px] text-muted">Posted publicly as you. GitHub comments can’t be unsent from here.</p>
                      </>
                    ) : (
                      <p className="text-[12.5px] text-muted">{postOff}</p>
                    )}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
