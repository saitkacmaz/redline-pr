import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChangedFile } from '../../../shared/types';
import { fileTree, flattenTree } from '../paths';

interface Props {
  files: ChangedFile[];
  /** Files at least one sentence points at; only those can be jumped to. */
  anchored: Set<string>;
  onJump: (path: string) => void;
}

const ROW = 'flex w-full min-w-0 items-baseline gap-3 py-1 pr-4 text-left font-mono text-[12.5px]';

/**
 * "N files": the diff's files by directory, indented like an outline, with their line
 * counts. Picking one scrolls to the first sentence about it.
 */
export function FilesMenu({ files, anchored, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const rows = flattenTree(fileTree(files));

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length > 0) {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  if (files.length === 0) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`cursor-pointer hover:text-ink ${open ? 'text-ink' : ''}`}
      >
        {files.length} {files.length === 1 ? 'file' : 'files'}
      </button>

      {open && (
        // Anchored to the top bar's content edge, not the button, so it always fits the window.
        <div
          ref={menu}
          role="menu"
          aria-label="Changed files"
          onKeyDown={onKey}
          className="absolute top-full right-4 z-30 mt-px max-h-[calc(100dvh-72px)] w-[min(380px,calc(100vw-32px))] overflow-y-auto overscroll-contain border border-rule bg-paper py-2 text-[12.5px] sm:right-6 wide:right-[26px]"
        >
          {rows.map((row) => {
            const indent = { paddingLeft: `${16 + row.depth * 16}px` };
            if (row.kind === 'dir') {
              return (
                <div key={`d:${row.depth}:${row.name}`} role="presentation" style={indent} className={`${ROW} text-faint [overflow-wrap:anywhere]`}>
                  {row.name}
                </div>
              );
            }
            const stats = (
              <span className="ml-auto shrink-0 tabular-nums">
                {row.additions > 0 && <span className="text-ins">+{row.additions}</span>}
                {row.deletions > 0 && <span className="ml-2 text-del">-{row.deletions}</span>}
              </span>
            );
            const name = <span className="min-w-0 [overflow-wrap:anywhere]">{row.name}</span>;
            return anchored.has(row.path) ? (
              <button
                key={row.path}
                type="button"
                role="menuitem"
                style={indent}
                onClick={() => {
                  setOpen(false);
                  onJump(row.path);
                }}
                className={`${ROW} cursor-pointer text-ink hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:outline-none`}
              >
                {name}
                {stats}
              </button>
            ) : (
              <div key={row.path} role="presentation" style={indent} title="No sentence in the spec points at this file." className={`${ROW} text-muted`}>
                {name}
                {stats}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
