import { useLayoutEffect, useRef, useState } from 'react';
import type { MarginComment, SpecDocument } from '../../../shared/types';
import { COLUMNS, TWO_COLUMNS } from '../grid';
import { layoutNotes } from '../layout';
import { sectionSummary } from '../sections';
import type { Action } from '../state';
import { Clause } from './Clause';
import { Margin } from './Margin';

interface Props {
  doc: SpecDocument;
  dispatch: (action: Action) => void;
  onReply: (commentId: string, text: string) => void;
  onStatus: (commentId: string, status: MarginComment['status']) => void;
  /** Sections folded away. Only the view: their sentences, edits and replies are all still synced. */
  folded: ReadonlySet<string>;
  onToggle: (sectionId: string) => void;
}

const GAP = 16;

/**
 * The whole spec as one continuous column of sentences, with one margin beside it.
 * Notes are positioned against the prose (level with their sentence, cascading down
 * past each other), so nothing in the margin can ever open a gap in the text. Below
 * 860px comments follow their sentence inline, under a quiet hairline.
 */
export function SpecBody({ doc, dispatch, onReply, onStatus, folded, onToggle }: Props) {
  const prose = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [linked, setLinked] = useState<string | null>(null);

  const byClause = new Map<string, MarginComment[]>();
  for (const c of doc.comments) byClause.set(c.clauseId, [...(byClause.get(c.clauseId) ?? []), c]);
  const noted = doc.sections.flatMap((s) => s.clauses).filter((c) => byClause.has(c.id));
  const foldedClauses = new Set(doc.sections.filter((s) => folded.has(s.id)).flatMap((s) => s.clauses.map((c) => c.id)));
  const placeNow = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const proseEl = prose.current;
    const railEl = rail.current;
    if (!proseEl || !railEl) return;
    const wide = window.matchMedia(TWO_COLUMNS);

    const place = (): void => {
      if (!wide.matches) return;
      const base = proseEl.getBoundingClientRect().top;
      // A folded section's notes are hidden and take no room.
      const notes = [...railEl.querySelectorAll<HTMLElement>('[data-for]')].filter((note) => !note.hidden);
      const boxes = notes.map((note) => {
        const sentence = proseEl.querySelector<HTMLElement>(`[data-clause="${CSS.escape(note.dataset.for ?? '')}"]`);
        return { want: sentence ? sentence.getBoundingClientRect().top - base : 0, height: note.offsetHeight };
      });
      const tops = layoutNotes(boxes, GAP);
      notes.forEach((note, i) => (note.style.top = `${tops[i]}px`));
      // Only the end of the page can grow, if the last notes run past the last sentence.
      railEl.style.minHeight = `${Math.max(0, ...boxes.map((b, i) => (tops[i] ?? 0) + b.height))}px`;
    };

    placeNow.current = place;

    // At most once a frame: a window drag fires many resizes, and each placement reads the
    // final layout of that frame (every sentence's new top), so notes don't drift or jitter.
    let frame = 0;
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };

    place();
    // Re-place when a sentence is edited, a code peek opens, a thread expands, or the window resizes
    // (the prose reflows, the margin narrows, and notes change height).
    const observer = new ResizeObserver(schedule);
    observer.observe(proseEl);
    observer.observe(railEl);
    for (const note of railEl.querySelectorAll('[data-for]')) observer.observe(note);
    wide.addEventListener('change', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      wide.removeEventListener('change', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [doc]);

  // Folding moves every sentence below it at once: re-place before the browser paints, so the
  // notes never show a frame in their old spots.
  const foldKey = [...folded].sort().join(' ');
  useLayoutEffect(() => placeNow.current(), [foldKey]);

  const link = (id: string) => ({
    onMouseEnter: () => setLinked(id),
    onMouseLeave: () => setLinked((cur) => (cur === id ? null : cur)),
    onFocus: () => setLinked(id),
    onBlur: () => setLinked((cur) => (cur === id ? null : cur)),
  });

  return (
    <div className={COLUMNS}>
      <div ref={prose} className="min-w-0 [overflow-wrap:break-word]">
        {doc.sections.map((section) => (
          <section key={section.id} className={folded.has(section.id) ? 'mb-4' : 'mb-9'}>
            <h2 className={folded.has(section.id) ? '' : 'mb-4'}>
              <button
                type="button"
                aria-expanded={!folded.has(section.id)}
                aria-controls={`section-${section.id}`}
                onClick={() => onToggle(section.id)}
                className="group flex w-full cursor-pointer flex-wrap items-baseline gap-x-3 text-left"
              >
                <span className="flex min-w-0 items-baseline gap-2 text-[13px] font-semibold uppercase tracking-[0.07em] text-ink">
                  <span aria-hidden="true" className="w-3 shrink-0 text-[11px] text-faint group-hover:text-muted">
                    {folded.has(section.id) ? '▸' : '▾'}
                  </span>
                  {section.title}
                </span>
                {folded.has(section.id) && <span className="text-[12.5px] text-muted tabular-nums">{sectionSummary(section, doc.comments)}</span>}
              </button>
            </h2>
            {/* Hidden, not unmounted: a half-typed edit, an open peek, or a reply draft survives folding. */}
            <div id={`section-${section.id}`} hidden={folded.has(section.id)} className="space-y-5">
              {section.clauses.map((clause) => {
                const own = byClause.get(clause.id) ?? [];
                return (
                  <div key={clause.id} data-clause={clause.id} {...(own.length > 0 ? link(clause.id) : {})}>
                    <Clause
                      clause={clause}
                      linked={linked === clause.id}
                      onEdit={(text) => dispatch({ type: 'editClause', clauseId: clause.id, text })}
                      onReset={() => dispatch({ type: 'resetClause', clauseId: clause.id })}
                    />
                    {own.length > 0 && (
                      <aside className="mt-4 border-l-2 border-rule pl-4 split:hidden">
                        <Margin comments={own} inline onReply={onReply} onStatus={onStatus} />
                      </aside>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <div ref={rail} className="relative hidden min-w-0 split:block">
        {noted.map((clause) => (
          <aside key={clause.id} data-for={clause.id} hidden={foldedClauses.has(clause.id)} className="absolute inset-x-0 pt-0.5" {...link(clause.id)}>
            <Margin comments={byClause.get(clause.id) ?? []} linked={linked === clause.id} onReply={onReply} onStatus={onStatus} />
          </aside>
        ))}
      </div>
    </div>
  );
}
