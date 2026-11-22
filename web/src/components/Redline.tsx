import { readableDiff } from '../../../shared/wordDiff';
import { InlineCode } from './InlineCode';

/** Old → new English as a word-level redline: struck crimson deletions, underlined green insertions. */
export function Redline({ before, after }: { before: string; after: string }) {
  return (
    <p className="text-[16px] leading-[1.65] text-ink">
      {readableDiff(before, after).map((part, i) =>
        part.op === 'delete' ? (
          <del key={i} className="text-del decoration-del/70">
            <InlineCode text={part.text} />
          </del>
        ) : part.op === 'insert' ? (
          <ins key={i} className="text-ins underline decoration-ins/60 underline-offset-[3px]">
            <InlineCode text={part.text} />
          </ins>
        ) : (
          <span key={i}>
            <InlineCode text={part.text} />
          </span>
        ),
      )}
    </p>
  );
}
