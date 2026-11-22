import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { MarginComment, PostedReply, SessionInfo, SyncResult } from '../../shared/types';
import { api } from './api';
import { Margin } from './components/Margin';
import { Section } from './components/Section';
import { SyncSheet } from './components/SyncSheet';
import { TopBar } from './components/TopBar';
import { isEdited, reducer, restoreDraft, saveDraft } from './state';

const ROW = 'lg:grid lg:grid-cols-[680px_340px] lg:gap-x-[100px]';

export function App() {
  const [doc, dispatch] = useReducer(reducer, null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [posted, setPosted] = useState<Record<string, PostedReply>>({});
  const syncButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api
      .spec()
      .then(({ doc: loaded, session: s }) => {
        setSession(s);
        dispatch({ type: 'load', doc: restoreDraft(loaded) });
        document.title = `redline · ${loaded.prTitle}`;
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (doc) saveDraft(doc);
  }, [doc]);

  const onReply = useCallback((commentId: string, text: string) => dispatch({ type: 'reply', commentId, text }), []);
  const onStatus = useCallback(
    (commentId: string, status: MarginComment['status']) => dispatch({ type: 'status', commentId, status }),
    [],
  );
  const closeSync = useCallback(() => {
    setSyncing(false);
    requestAnimationFrame(() => syncButton.current?.focus());
  }, []);
  const onPosted = useCallback(
    (replies: PostedReply[]) => setPosted((prev) => ({ ...prev, ...Object.fromEntries(replies.map((r) => [r.commentId, r])) })),
    [],
  );

  if (error) {
    return (
      <main className="mx-auto max-w-[680px] px-6 pt-24">
        <p className="text-[16px] leading-[1.65] text-del">{error}</p>
      </main>
    );
  }
  if (!doc || !session) {
    return (
      <main className="mx-auto max-w-[680px] px-6 pt-24">
        <p className="text-[15px] text-muted">Loading spec…</p>
      </main>
    );
  }

  const clauses = doc.sections.flatMap((s) => s.clauses);
  const edits = clauses.filter(isEdited).length;
  const clauseIds = new Set(clauses.map((c) => c.id));
  const orphans = doc.comments.filter((c) => !clauseIds.has(c.clauseId));

  return (
    <>
      {/* Everything behind the sheet is inert, so Tab and screen readers stay inside it. */}
      <div inert={syncing}>
        <TopBar ref={syncButton} doc={doc} session={session} edits={edits} onSync={() => setSyncing(true)} />

        <main className="mx-auto max-w-[1120px] px-6 pt-14 pb-40 lg:px-0">
          <div className={`${ROW} mb-12`}>
            <div>
              <p className="text-[13px] text-muted">
                Behavioral spec of <span className="font-mono text-[12px]">{doc.branch}</span> against{' '}
                <span className="font-mono text-[12px]">{doc.baseBranch}</span>. Edit any sentence to say what the code
                should do.
              </p>
            </div>
          </div>

          {doc.sections.map((section) => (
            <Section
              key={section.id}
              section={section}
              comments={doc.comments}
              dispatch={dispatch}
              onReply={onReply}
              onStatus={onStatus}
            />
          ))}

          {orphans.length > 0 && (
            <section className={`${ROW} border-t border-rule pt-8`}>
              <p className="text-[13px] text-muted">Comments not tied to a sentence</p>
              <aside className="mt-4 lg:mt-0">
                <Margin comments={orphans} onReply={onReply} onStatus={onStatus} />
              </aside>
            </section>
          )}
        </main>
      </div>

      {syncing && (
        <SyncSheet
          doc={doc}
          session={session}
          result={result}
          onResult={setResult}
          posted={posted}
          onPosted={onPosted}
          onReply={onReply}
          onClose={closeSync}
        />
      )}
    </>
  );
}
