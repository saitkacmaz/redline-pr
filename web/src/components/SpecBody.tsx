import { useLayoutEffect, useRef, useState } from 'react';
import type { MarginComment, SpecDocument } from '../../../shared/types';
import { layoutNotes } from '../layout';
import type { Action } from '../state';
import { Clause } from './Clause';
import { Margin } from './Margin';

interface Props {
  doc: SpecDocument;
  dispatch: (action: Action) => void;
  onReply: (commentId: string, text: string) => void;
  onStatus: (commentId: string, status: MarginComment['status']) => void;
}

const GAP = 16;
const WIDE = '(min-width: 1024px)';

/**
 * The whole spec as one continuous column of sentences, with one margin beside it.
 * Notes are positioned against the prose (level with their sentence, cascading down
 * past each other), so nothing in the margin can ever open a gap in the text. On
 * narrow screens comments follow their sentence inline.
 */
export function SpecBody({ doc, dispatch, onReply, onStatus }: Props) {
  const prose = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [linked, setLinked] = useState<string | null>(null);

  const byClause = new Map<string, MarginComment[]>();
  for (const c of doc.comments) byClause.set(c.clauseId, [...(byClause.get(c.clauseId) ?? []), c]);
  const noted = doc.sections.flatMap((s) => s.clauses).filter((c) => byClause.has(c.id));

  useLayoutEffect(() => {
    const proseEl = prose.current;
    const railEl = rail.current;
    if (!proseEl || !railEl) return;
    const wide = window.matchMedia(WIDE);

    const place = (): void => {
      if (!wide.matches) return;
      const base = proseEl.getBoundingClientRect().top;
      const notes = [...railEl.querySelectorAll<HTMLElement>('[data-for]')];
      const boxes = notes.map((note) => {
        const sentence = proseEl.querySelector<HTMLElement>(`[data-clause="${CSS.escape(note.dataset.for ?? '')}"]`);
        return { want: sentence ? sentence.getBoundingClientRect().top - base : 0, height: note.offsetHeight };
      });
      const tops = layoutNotes(boxes, GAP);
      notes.forEach((note, i) => (note.style.top = `${tops[i]}px`));
      // Only the end of the page can grow, if the last notes run past the last sentence.
      railEl.style.minHeight = `${Math.max(0, ...boxes.map((b, i) => (tops[i] ?? 0) + b.height))}px`;
    };

    place();
    // Re-place when a sentence is edited, a code peek opens, a thread expands, or the window resizes.
    const observer = new ResizeObserver(place);
    observer.observe(proseEl);
    for (const note of railEl.querySelectorAll('[data-for]')) observer.observe(note);
    wide.addEventListener('change', place);
    return () => {
      observer.disconnect();
      wide.removeEventListener('change', place);
    };
  }, [doc]);

  const link = (id: string) => ({
    onMouseEnter: () => setLinked(id),
    onMouseLeave: () => setLinked((cur) => (cur === id ? null : cur)),
    onFocus: () => setLinked(id),
    onBlur: () => setLinked((cur) => (cur === id ? null : cur)),
  });

  return (
    <div className="lg:grid lg:grid-cols-[680px_340px] lg:gap-x-[100px]">
      <div ref={prose}>
        {doc.sections.map((section) => (
          <section key={section.id} className="mb-9">
            <h2 className="mb-4 text-[13px] font-semibold uppercase tracking-[0.07em] text-ink">{section.title}</h2>
            <div className="space-y-5">
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
                      <aside className="mt-4 lg:hidden">
                        <Margin comments={own} onReply={onReply} onStatus={onStatus} />
                      </aside>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <div ref={rail} className="relative hidden lg:block">
        {noted.map((clause) => (
          <aside key={clause.id} data-for={clause.id} className="absolute inset-x-0 pt-0.5" {...link(clause.id)}>
            <Margin comments={byClause.get(clause.id) ?? []} linked={linked === clause.id} onReply={onReply} onStatus={onStatus} />
          </aside>
        ))}
      </div>
    </div>
  );
}
