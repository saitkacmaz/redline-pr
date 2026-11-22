import { useLayoutEffect, useRef } from 'react';
import type { MarginComment, SpecSection } from '../../../shared/types';
import type { Action } from '../state';
import { Clause } from './Clause';
import { Margin } from './Margin';

interface Props {
  section: SpecSection;
  comments: MarginComment[];
  dispatch: (action: Action) => void;
  onReply: (commentId: string, text: string) => void;
  onStatus: (commentId: string, status: MarginComment['status']) => void;
}

const GAP = 24;
const WIDE = '(min-width: 1024px)';

/**
 * A section reads as one continuous column of sentences. On wide screens each
 * sentence's comments sit in the margin, top-aligned with it and pushed down
 * only when the previous note would overlap, like notes on a printed page, so a
 * long comment never opens a hole in the prose. On narrow screens comments
 * follow their sentence inline.
 */
export function Section({ section, comments, dispatch, onReply, onStatus }: Props) {
  const prose = useRef<HTMLDivElement>(null);
  const margin = useRef<HTMLDivElement>(null);
  const noted = section.clauses.filter((c) => comments.some((m) => m.clauseId === c.id));

  useLayoutEffect(() => {
    const proseEl = prose.current;
    const marginEl = margin.current;
    if (!proseEl || !marginEl) return;
    const wide = window.matchMedia(WIDE);

    const place = (): void => {
      if (!wide.matches) return;
      const base = proseEl.getBoundingClientRect().top;
      let floor = 0;
      for (const note of marginEl.querySelectorAll<HTMLElement>('[data-for]')) {
        const sentence = proseEl.querySelector<HTMLElement>(`[data-clause="${note.dataset.for}"]`);
        const want = sentence ? sentence.getBoundingClientRect().top - base : floor;
        const top = Math.max(want, floor);
        note.style.top = `${top}px`;
        floor = top + note.offsetHeight + GAP;
      }
      marginEl.style.minHeight = `${Math.max(floor - GAP, 0)}px`;
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(proseEl);
    for (const note of marginEl.querySelectorAll('[data-for]')) observer.observe(note);
    wide.addEventListener('change', place);
    return () => {
      observer.disconnect();
      wide.removeEventListener('change', place);
    };
  });

  return (
    <section className="mb-14 lg:grid lg:grid-cols-[680px_340px] lg:gap-x-[100px]">
      <h2 className="mb-5 text-[13px] font-semibold uppercase tracking-[0.07em] text-ink lg:col-span-2">{section.title}</h2>
      <div ref={prose} className="space-y-5">
        {section.clauses.map((clause) => {
          const own = comments.filter((c) => c.clauseId === clause.id);
          return (
            <div key={clause.id} data-clause={clause.id}>
              <Clause
                clause={clause}
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
      <div ref={margin} className="relative hidden lg:block">
        {noted.map((clause) => (
          <aside key={clause.id} data-for={clause.id} className="absolute inset-x-0 pt-0.5">
            <Margin comments={comments.filter((c) => c.clauseId === clause.id)} onReply={onReply} onStatus={onStatus} />
          </aside>
        ))}
      </div>
    </section>
  );
}
