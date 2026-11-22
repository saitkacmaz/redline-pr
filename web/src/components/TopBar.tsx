import type { Ref } from 'react';
import type { SessionInfo, SpecDocument } from '../../../shared/types';

interface Props {
  doc: SpecDocument;
  session: SessionInfo;
  edits: number;
  onSync: () => void;
  ref?: Ref<HTMLButtonElement>;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function TopBar({ doc, session, edits, onSync, ref }: Props) {
  const mode = session.demo ? 'demo' : session.dryRun ? 'dry run' : null;
  return (
    <header className="sticky top-0 z-10 border-b border-rule bg-paper">
      <div className="mx-auto flex h-12 max-w-[1120px] items-center gap-4 px-6 lg:px-0">
        <h1 className="truncate text-[14px] font-medium text-ink">
          {doc.prTitle}
          {doc.prNumber !== undefined && <span className="ml-1.5 font-normal text-muted">#{doc.prNumber}</span>}
        </h1>
        <span className="hidden shrink-0 font-mono text-[12px] text-muted sm:inline">
          {doc.branch}
          {mode && <span className="font-sans"> · {mode}</span>}
        </span>
        <span className="ml-auto shrink-0 text-[13px] text-muted tabular-nums">
          {plural(edits, 'edit')} · {plural(doc.comments.length, 'comment')}
        </span>
        <button
          ref={ref}
          type="button"
          onClick={onSync}
          className="h-8 shrink-0 cursor-pointer rounded-[3px] bg-ink px-4 text-[13px] font-medium text-paper hover:bg-ink/85"
        >
          Sync
        </button>
      </div>
    </header>
  );
}
