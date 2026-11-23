import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LoadTarget, PrListResponse } from '../../../shared/types';
import { api } from '../api';

interface Props {
  title: string;
  prNumber?: number | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (target: LoadTarget) => void;
  disabled: boolean;
}

const ROW =
  'flex w-full cursor-pointer items-baseline gap-3 px-4 py-2 text-left text-[13.5px] text-ink hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:outline-none';

/** The PR title is the switcher: quiet until hovered, a flat list when opened. */
export function PrSwitcher({ title, prNumber, open, onOpenChange, onPick, disabled }: Props) {
  const [list, setList] = useState<PrListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    api
      .prs()
      .then((l) => live && setList(l))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    const outside = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('mousedown', outside);
    return () => {
      live = false;
      document.removeEventListener('mousedown', outside);
    };
  }, [open, onOpenChange]);

  // Focus the current entry (or the first) once the list is in.
  useEffect(() => {
    if (!open || !list) return;
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
    (items.find((b) => b.getAttribute('aria-current') === 'true') ?? items[0])?.focus();
  }, [open, list]);

  const close = (): void => {
    onOpenChange(false);
    trigger.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === 'Tab') {
      onOpenChange(false);
    }
  };

  const pick = (target: LoadTarget): void => {
    onOpenChange(false);
    onPick(target);
  };

  const current = list?.current;
  return (
    <div ref={wrap} className="relative min-w-0">
      <h1 className="min-w-0">
        <button
          ref={trigger}
          type="button"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="group flex max-w-full min-w-0 cursor-pointer items-baseline gap-1.5 text-left text-[14px] disabled:cursor-default"
        >
          <span className="truncate font-medium text-ink">{title}</span>
          {prNumber !== undefined && <span className="shrink-0 text-muted">#{prNumber}</span>}
          <span
            aria-hidden="true"
            className={`shrink-0 text-[11px] text-muted transition-opacity ${open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}
          >
            ▾
          </span>
        </button>
      </h1>

      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Load a pull request"
          onKeyDown={onKey}
          className="absolute top-[calc(100%+13px)] left-0 z-30 w-[min(520px,calc(100vw-48px))] border border-rule bg-paper py-1.5"
        >
          {!list && !error && <p className="px-4 py-2 text-[13px] text-muted">Loading pull requests…</p>}
          {error && <p className="px-4 py-2 text-[13px] text-del">{error}</p>}
          {list && (
            <>
              {list.branch && (
                <button
                  type="button"
                  role="menuitem"
                  aria-current={current?.kind === 'local'}
                  onClick={() => pick({ kind: 'local' })}
                  className={ROW}
                >
                  <span className={`min-w-0 flex-1 truncate ${current?.kind === 'local' ? 'font-medium' : ''}`}>Local branch diff</span>
                  <span className="shrink-0 font-mono text-[12px] text-muted">{list.branch}</span>
                </button>
              )}
              {list.prs.length > 0 && <div className="my-1.5 border-t border-rule" />}
              {list.prs.map((pr) => {
                const isCurrent = current?.kind === 'pr' && current.number === pr.number;
                return (
                  <button
                    key={pr.number}
                    type="button"
                    role="menuitem"
                    aria-current={isCurrent}
                    onClick={() => pick({ kind: 'pr', number: pr.number })}
                    className={ROW}
                  >
                    <span className="w-10 shrink-0 font-mono text-[12px] text-muted">#{pr.number}</span>
                    <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-medium' : ''}`}>{pr.title}</span>
                    {pr.checkedOut && <span className="shrink-0 text-[12px] text-muted">checked out</span>}
                    <span className="shrink-0 text-[12px] text-muted">@{pr.author}</span>
                  </button>
                );
              })}
              {list.note && <p className="px-4 py-2 text-[12.5px] text-muted">{list.note}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
