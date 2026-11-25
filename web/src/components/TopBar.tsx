import type { Ref } from 'react';
import type { Activity, LoadTarget } from '../../../shared/types';
import { SHELL } from '../grid';
import { Hairline } from './Hairline';
import { PrSwitcher } from './PrSwitcher';

interface Props {
  title: string;
  prNumber?: number | undefined;
  branch: string;
  mode: string | null;
  /** Edit and comment counts, once a spec is loaded. */
  counts: { edits: number; comments: number } | null;
  /** Something is running; reloading and syncing wait for it. */
  busy: boolean;
  canSync: boolean;
  activity: Activity | null;
  switcherOpen: boolean;
  onSwitcherOpen: (open: boolean) => void;
  onPick: (target: LoadTarget) => void;
  onRefresh: () => void;
  onSync: () => void;
  ref?: Ref<HTMLButtonElement>;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function TopBar(props: Props) {
  const { counts, busy } = props;
  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-paper">
      {/* The title gives way first (it truncates); below 640px the branch and counts go before it does. */}
      <div className={`${SHELL} flex min-h-12 items-center gap-3 sm:gap-4`}>
        <PrSwitcher
          title={props.title}
          prNumber={props.prNumber}
          open={props.switcherOpen}
          onOpenChange={props.onSwitcherOpen}
          onPick={props.onPick}
          disabled={busy && props.activity?.kind === 'sync'}
        />
        {props.branch && (
          <span className="hidden shrink-0 font-mono text-[12px] text-muted sm:inline">
            {props.branch}
            {props.mode && <span className="font-sans"> · {props.mode}</span>}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-4 text-[13px] text-muted tabular-nums">
          <button
            type="button"
            onClick={props.onRefresh}
            disabled={busy}
            className="cursor-pointer hover:text-ink disabled:cursor-default disabled:opacity-40"
          >
            Refresh
          </button>
          {counts && (
            <span className="hidden sm:inline">
              {plural(counts.edits, 'edit')} · {plural(counts.comments, 'comment')}
            </span>
          )}
        </span>
        <button
          ref={props.ref}
          type="button"
          onClick={props.onSync}
          disabled={!props.canSync}
          className="h-8 shrink-0 cursor-pointer rounded-[3px] bg-ink px-4 text-[13px] font-medium text-paper hover:bg-ink/85 disabled:cursor-default disabled:opacity-35"
        >
          Sync
        </button>
      </div>
      <Hairline activity={props.activity} />
    </header>
  );
}
