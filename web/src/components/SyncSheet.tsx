import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PostedReply, SessionInfo, SpecDocument, SyncMode, SyncPlan, SyncResult } from '../../../shared/types';
import { api } from '../api';
import { AutoTextarea } from './AutoTextarea';
import { DiffLines } from './HunkPeek';
import { Redline } from './Redline';

interface Props {
  doc: SpecDocument;
  session: SessionInfo;
  /** The last run's result, kept by the app so closing the sheet doesn't lose it. */
  result: SyncResult | null;
  onResult: (result: SyncResult) => void;
  posted: Record<string, PostedReply>;
  onPosted: (replies: PostedReply[]) => void;
  onReply: (commentId: string, text: string) => void;
  onClose: () => void;
}

function Label({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted">{children}</h2>;
}

const anchorText = (a: { file: string; startLine: number; endLine: number }): string =>
  `${a.file}:${a.startLine}${a.endLine !== a.startLine ? `-${a.endLine}` : ''}`;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const PRIMARY =
  'h-9 cursor-pointer rounded-[3px] bg-ink px-4 text-[13.5px] font-medium text-paper hover:bg-ink/85 disabled:cursor-default disabled:opacity-35';
const SECONDARY =
  'h-9 cursor-pointer rounded-[3px] border border-rule px-4 text-[13.5px] text-ink hover:border-ink/40 disabled:cursor-default disabled:opacity-35';

export function SyncSheet({ doc, session, result, onResult, posted, onPosted, onReply, onClose }: Props) {
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SyncMode | 'post' | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

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
      if (e.key !== 'Escape' || busy) return;
      // Escape inside a reply leaves the field; a second Escape closes the sheet.
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'TEXTAREA') {
        target.blur();
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

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

  const ran = (result?.mode === 'run' && result.ok && !session.demo && !session.dryRun) || session.applied;
  const hasEdits = (plan?.entries.length ?? 0) > 0;
  const runNote = session.demo
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
    <div className="fixed inset-0 z-20 overflow-y-auto bg-paper" role="dialog" aria-modal="true" aria-labelledby="sync-title">
      <div className="sticky top-0 z-10 border-b border-rule bg-paper">
        <div className="mx-auto flex h-12 max-w-[760px] items-center px-6">
          <h1 id="sync-title" ref={heading} tabIndex={-1} className="text-[14px] font-medium outline-none">
            Sync review
          </h1>
          <span className="ml-3 font-mono text-[12px] text-muted">{doc.branch}</span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy !== null}
            className="ml-auto cursor-pointer text-[13px] text-muted hover:text-ink disabled:cursor-default disabled:opacity-40"
          >
            Close <span className="text-muted">esc</span>
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-[760px] px-6 pt-12 pb-32">
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
                    <button type="button" disabled={busy !== null || !hasEdits} onClick={() => void run()} className={PRIMARY}>
                      {busy === 'run' ? 'Running…' : 'Run with Claude Code'}
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
                  <p className="mt-3 text-[12.5px] text-muted">{busy === 'run' ? 'This can take several minutes. Keep this tab open.' : runNote}</p>
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

              {session.applied && result?.mode !== 'run' && (
                <p className="text-[15px] leading-[1.6]">
                  Claude Code already ran in this session, so this spec no longer matches the code. Restart redline to
                  read the updated spec.
                </p>
              )}
              {result?.mode === 'run' && (
                <div aria-live="polite" className={ran ? '' : 'mt-8'}>
                  <p className={`text-[15px] leading-[1.6] ${result.ok ? 'text-ink' : 'text-del'}`}>{result.summary}</p>
                  {result.changes && result.changes.diff && (
                    <div className="mt-5 border-l border-ink/80 pl-4">
                      <div className="mb-1.5 font-mono text-[11.5px] text-muted">{result.changes.files.join('  ')}</div>
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
                  {ran && result?.mode === 'run' && (
                    <p className="mt-5 text-[13px] text-muted">
                      Review it with <code className="font-mono text-[0.875em]">git diff</code>, then restart redline to read
                      the updated spec.
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
                    {session.canPostReplies ? (
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
      </div>
    </div>
  );
}
