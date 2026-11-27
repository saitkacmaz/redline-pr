import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Activity, LoadTarget, MarginComment, PostedReply, SessionInfo, SpecView, SyncResult } from '../../shared/types';
import { api, subscribe } from './api';
import { HiddenThreads, Margin } from './components/Margin';
import { SpecBody } from './components/SpecBody';
import { LogPeek, StatusLine } from './components/StatusLine';
import { SyncView } from './components/SyncView';
import { TopBar } from './components/TopBar';
import { COLUMNS as ROW, SHELL } from './grid';
import { foldedFor, sectionOf, toggleFolded, type Folded } from './sections';
import { clearDraft, isEdited, reducer, restoreDraft, saveDraft } from './state';


const MAX_LOG_LINES = 400;

/** The server's current activity and its log, live over /api/events. Calls `onView` when the loaded spec changes. */
function useActivity(onView: () => void): { activity: Activity | null; log: string[]; connected: boolean } {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [connected, setConnected] = useState(true);
  const logFor = useRef<number | null>(null);
  const viewRef = useRef(onView);
  viewRef.current = onView;

  useEffect(
    () =>
      subscribe(
        (event) => {
          if (event.type === 'view') viewRef.current();
          else if (event.type === 'activity') {
            if (logFor.current !== event.activity.id) {
              logFor.current = event.activity.id;
              setLog([]);
            }
            setActivity(event.activity);
          } else if (event.id === logFor.current) {
            setLog((lines) => [...lines.slice(-(MAX_LOG_LINES - 1)), event.line]);
          }
        },
        setConnected,
      ),
    [],
  );
  return { activity, log, connected };
}

type Route = 'spec' | 'sync';
const routeOf = (): Route => (window.location.hash === '#sync' ? 'sync' : 'spec');

/**
 * Spec and Sync are two views in the browser's history (#sync), so Back and Forward
 * move between them like pages, and the spec's scroll position comes back with it.
 */
function useRoute(): { route: Route; openSync: () => void; back: () => void } {
  const [route, setRoute] = useState<Route>(routeOf);
  const specScroll = useRef(0);

  useEffect(() => {
    // The browser would restore scroll on Back while the short Sync page is still showing; we do it instead.
    window.history.scrollRestoration = 'manual';
    const onPop = (): void => setRoute(routeOf());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useLayoutEffect(() => {
    window.scrollTo(0, route === 'spec' ? specScroll.current : 0);
  }, [route]);

  const openSync = useCallback(() => {
    specScroll.current = window.scrollY;
    window.history.pushState({ redline: 'sync' }, '', '#sync');
    setRoute('sync');
  }, []);
  const back = useCallback(() => {
    // Opened from the spec: step back in history. Landed on #sync directly: replace it.
    if ((window.history.state as { redline?: string } | null)?.redline === 'sync') window.history.back();
    else {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setRoute('spec');
    }
  }, []);
  return { route, openSync, back };
}

export function App() {
  const [doc, dispatch] = useReducer(reducer, null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [view, setView] = useState<SpecView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { route, openSync, back } = useRoute();
  const [switcher, setSwitcher] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [posted, setPosted] = useState<Record<string, PostedReply>>({});
  const [foldState, setFoldState] = useState<Folded>({ docId: null, ids: new Set() });
  const syncButton = useRef<HTMLButtonElement>(null);
  const docId = useRef<string | null>(null);
  const seq = useRef(0);
  const everReady = useRef(false);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await api.spec();
      if (mine !== seq.current) return; // a newer refresh is on its way
      setSession(res.session);
      setView(res.view);
      setNotice(null);
      const v = res.view;
      if (v.status === 'ready') {
        everReady.current = true;
        if (v.doc.id !== docId.current) {
          docId.current = v.doc.id;
          dispatch({ type: 'load', doc: restoreDraft(v.doc) });
          setPosted({});
        }
        setResult(v.result ?? null);
        document.title = `redline · ${v.doc.prTitle}`;
      } else if (v.status !== 'loading') {
        docId.current = null;
        dispatch({ type: 'load', doc: null });
        setResult(null);
        // Nothing to show on launch: offer the PRs, if GitHub has any. After the user picked something, don't pop it open again.
        if (v.status === 'empty' && v.offerPrs && !everReady.current) setSwitcher(true);
      }
    } catch (e) {
      if (mine === seq.current) setNotice(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const { activity, log, connected } = useActivity(() => void refresh());
  useEffect(() => void refresh(), [refresh]);

  useEffect(() => {
    if (doc) saveDraft(doc);
  }, [doc]);

  const onReply = useCallback((commentId: string, text: string) => dispatch({ type: 'reply', commentId, text }), []);
  const onStatus = useCallback(
    (commentId: string, status: MarginComment['status']) => dispatch({ type: 'status', commentId, status }),
    [],
  );
  const backToSpec = back;
  // However Sync was left (link, Esc, the browser's Back button), focus lands back on Sync.
  const lastRoute = useRef(route);
  useEffect(() => {
    if (route === 'spec' && lastRoute.current === 'sync') syncButton.current?.focus();
    lastRoute.current = route;
  }, [route]);
  const onPosted = useCallback(
    (replies: PostedReply[]) => setPosted((prev) => ({ ...prev, ...Object.fromEntries(replies.map((r) => [r.commentId, r])) })),
    [],
  );
  const load = useCallback((target: LoadTarget) => {
    setNotice(null);
    api.load(target).catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
  }, []);
  /** After a run: read the changed code again and start a fresh spec. The applied redlines are done with. */
  const reanalyze = useCallback(() => {
    if (doc) clearDraft(doc);
    backToSpec();
    load({ kind: 'current' });
  }, [doc, load, backToSpec]);

  if (!session || !view) {
    return (
      <main className="mx-auto max-w-[680px] px-4 pt-24 sm:px-6">
        <p className={`text-[15px] ${notice ? 'text-del' : 'text-muted'}`}>{notice ?? 'Connecting…'}</p>
      </main>
    );
  }

  const loading = view.status === 'loading';
  const ready = view.status === 'ready' ? view : null;
  const specActivity = activity?.kind === 'spec' ? activity : null;
  const busy = loading || activity?.state === 'running';
  const clauses = doc?.sections.flatMap((s) => s.clauses) ?? [];
  const clauseIds = new Set(clauses.map((c) => c.id));
  const orphans = doc?.comments.filter((c) => !clauseIds.has(c.clauseId)) ?? [];
  const mode = session.demo ? 'demo' : session.dryRun ? 'dry run' : null;
  // #sync shows the Sync view only once there's a spec to sync; otherwise the spec view explains why not.
  const onSync = route === 'sync' && doc !== null && ready !== null;
  const anchored = new Set(clauses.flatMap((c) => c.anchors.map((a) => a.file)));
  const folded = foldedFor(foldState, doc?.id);
  const toggleSection = (sectionId: string, fold?: boolean): void => {
    if (doc) setFoldState((f) => toggleFolded(f, doc.id, sectionId, fold));
  };

  /** From the Files list: bring the first sentence about `path` into view and mark it briefly. */
  const jumpToFile = (path: string): void => {
    const clause = clauses.find((c) => c.anchors.some((a) => a.file === path));
    const section = clause && doc && sectionOf(doc.sections, clause.id);
    // Open its section first, synchronously, so there is a sentence to scroll to.
    if (section && folded.has(section.id)) flushSync(() => toggleSection(section.id, false));
    const el = clause && document.querySelector<HTMLElement>(`[data-clause="${CSS.escape(clause.id)}"]`);
    if (!el) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    el.querySelector<HTMLElement>(`[data-file="${CSS.escape(path)}"]`)?.focus({ preventScroll: true });
    (el.querySelector('p') ?? el).animate([{ backgroundColor: 'rgb(20 20 19 / 0.06)' }, { backgroundColor: 'rgb(20 20 19 / 0)' }], {
      duration: still ? 900 : 1800,
      delay: still ? 0 : 300,
      easing: 'ease-out',
      fill: 'backwards',
    });
  };

  return (
    <>
      {/* The spec stays mounted while Sync is open, so open code peeks and expanded threads survive Back. */}
      <div hidden={onSync}>
        <TopBar
          ref={syncButton}
          title={doc?.prTitle ?? (loading ? `Loading ${view.label}…` : session.branch || 'redline')}
          prNumber={doc?.prNumber}
          branch={doc?.branch ?? session.branch}
          mode={mode}
          counts={doc ? { edits: clauses.filter(isEdited).length, comments: doc.comments.length } : null}
          files={ready?.files ?? []}
          anchored={anchored}
          onJump={jumpToFile}
          busy={busy}
          canSync={ready !== null && doc !== null && !loading}
          activity={activity}
          switcherOpen={switcher}
          onSwitcherOpen={setSwitcher}
          onPick={load}
          onRefresh={() => load({ kind: 'current' })}
          onSync={openSync}
        />

        <main className={`${SHELL} pt-10 pb-40 split:pt-14`}>
          <div className={`${ROW} mb-12`}>
            <div aria-live="polite">
              {!connected && (
                <p className="mb-3 text-[13px] text-del">Lost the connection to redline. Is it still running in your terminal?</p>
              )}
              {notice && <p className="mb-3 text-[13px] text-del">{notice}</p>}
              {loading ? (
                specActivity ? (
                  <>
                    <StatusLine activity={specActivity} />
                    <LogPeek lines={log} />
                  </>
                ) : (
                  <p className="font-mono text-[12.5px] text-muted">Starting…</p>
                )
              ) : view.status === 'error' ? (
                <>
                  <p className="text-[15px] leading-[1.6] whitespace-pre-line text-del">{view.message}</p>
                  <LogPeek lines={specActivity ? log : []} />
                </>
              ) : view.status === 'empty' ? (
                <>
                  <p className="text-[15px] leading-[1.6] text-ink">{view.message}</p>
                  <p className="mt-1 text-[13px] text-muted">{view.hint}</p>
                </>
              ) : (
                doc && (
                  <p className="text-[13px] text-muted">
                    Behavioral spec of <span className="font-mono text-[12px]">{doc.branch}</span> against{' '}
                    <span className="font-mono text-[12px]">{doc.baseBranch}</span>. Edit any sentence to say what the code
                    should do.
                  </p>
                )
              )}
            </div>
          </div>

          {doc && (
            // While a new spec loads, the old one stays visible for reference but can't be edited.
            <div inert={loading} className={`transition-opacity duration-300 ${loading ? 'opacity-40' : ''}`}>
              <SpecBody doc={doc} dispatch={dispatch} onReply={onReply} onStatus={onStatus} folded={folded} onToggle={toggleSection} />

              {orphans.length > 0 && (
                <section className={`${ROW} border-t border-rule pt-8`}>
                  <p className="text-[13px] text-muted">Comments not tied to a sentence</p>
                  <aside className="mt-4 min-w-0 split:mt-0">
                    <Margin comments={orphans} onReply={onReply} onStatus={onStatus} />
                  </aside>
                </section>
              )}

              {(doc.hiddenThreads?.length ?? 0) > 0 && (
                <div className={`${ROW} mt-10`}>
                  <div />
                  <HiddenThreads threads={doc.hiddenThreads ?? []} />
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {onSync && doc && ready && (
        <SyncView
          doc={doc}
          session={session}
          canPostReplies={ready.canPostReplies}
          runBlocked={ready.runBlocked}
          result={result}
          onResult={setResult}
          activity={activity}
          log={log}
          posted={posted}
          onPosted={onPosted}
          onReply={onReply}
          onReanalyze={reanalyze}
          onBack={backToSpec}
        />
      )}
    </>
  );
}
