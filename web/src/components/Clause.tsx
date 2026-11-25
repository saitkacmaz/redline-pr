import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { CodeAnchor, SpecClause } from '../../../shared/types';
import { lineRange } from '../paths';
import { isEdited } from '../state';
import { HunkPeek } from './HunkPeek';
import { InlineCode } from './InlineCode';
import { usePathName } from './PathName';

interface Props {
  clause: SpecClause;
  /** Its margin note is hovered or focused: mark the sentence so the pairing is unmistakable. */
  linked?: boolean;
  onEdit: (text: string) => void;
  onReset: () => void;
}

const anchorKey = (a: CodeAnchor): string => `${a.file}:${a.startLine}-${a.endLine}`;

/** Place the caret at a screen point, or at the end if the browser can't resolve it. */
function placeCaret(el: HTMLElement, point: { x: number; y: number } | null): void {
  const selection = window.getSelection();
  if (!selection) return;
  let range: Range | null = null;
  if (point) {
    const pos = document.caretPositionFromPoint?.(point.x, point.y);
    if (pos && el.contains(pos.offsetNode)) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function Clause({ clause, linked = false, onEdit, onReset }: Props) {
  const pathName = usePathName();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const editable = useRef<HTMLSpanElement>(null);
  const view = useRef<HTMLSpanElement>(null);
  const clickPoint = useRef<{ x: number; y: number } | null>(null);
  /** The text when editing began, so Escape can put it back. */
  const textBefore = useRef('');
  /** Return focus to the sentence after Enter/Escape, so the next Tab continues from here. */
  const refocus = useRef(false);
  const edited = isEdited(clause);

  useLayoutEffect(() => {
    if (!editing) {
      if (refocus.current) view.current?.focus();
      refocus.current = false;
      return;
    }
    const el = editable.current;
    if (!el) return;
    textBefore.current = clause.currentText;
    el.textContent = clause.currentText;
    el.focus();
    placeCaret(el, clickPoint.current);
    clickPoint.current = null;
    // Only seed text when entering edit mode; typing is uncontrolled.
  }, [editing]);

  const startEditing = (e?: MouseEvent): void => {
    if (e) clickPoint.current = { x: e.clientX, y: e.clientY };
    setEditing(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>): void => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') onEdit(textBefore.current);
    refocus.current = true;
    e.currentTarget.blur();
  };

  const openAnchor = clause.anchors.find((a) => anchorKey(a) === open);

  return (
    <div className="group">
      <p className="relative text-[16px] leading-[1.65] text-ink">
        {linked && <span aria-hidden className="absolute -left-3 top-[0.35em] bottom-[0.35em] w-px bg-ink" />}
        {(edited || editing) && (
          <span aria-hidden className={`absolute -left-5 top-[0.35em] bottom-[0.35em] w-[2px] ${edited ? 'bg-del' : 'bg-rule'}`} />
        )}
        {editing ? (
          <span
            key="edit"
            ref={editable}
            contentEditable="plaintext-only"
            suppressContentEditableWarning
            role="textbox"
            aria-label="Edit sentence. Enter to keep, Escape to cancel."
            spellCheck
            onInput={(e) => onEdit(e.currentTarget.textContent ?? '')}
            onKeyDown={onKeyDown}
            onBlur={() => setEditing(false)}
            className="cursor-text caret-del outline-none"
          />
        ) : (
          <span
            key="view"
            ref={view}
            tabIndex={0}
            onClick={(e) => {
              // Let people select and copy a sentence without dropping into edit mode.
              if (!window.getSelection()?.isCollapsed) return;
              startEditing(e);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                startEditing();
              }
            }}
            className="cursor-text"
          >
            <InlineCode text={clause.currentText} />
          </span>
        )}{' '}
        {clause.anchors.map((a) => {
          const key = anchorKey(a);
          const active = open === key;
          return (
            <button
              key={key}
              type="button"
              title={`${a.file} lines ${a.startLine}–${a.endLine}`}
              aria-expanded={active}
              onClick={() => setOpen(active ? null : key)}
              className={`mr-2 cursor-pointer whitespace-nowrap font-mono text-[12px] underline-offset-[3px] hover:underline ${
                active ? 'text-ink underline' : 'text-muted'
              }`}
            >
              {lineRange(pathName(a.file), a.startLine, a.endLine)}
            </button>
          );
        })}
        {clause.riskFlag && <em className="whitespace-nowrap text-[13px] text-ink">— {clause.riskFlag}</em>}
        {edited && (
          <button
            type="button"
            onClick={onReset}
            className="ml-2 cursor-pointer text-[12px] text-muted opacity-0 transition-opacity duration-150 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
          >
            reset
          </button>
        )}
      </p>

      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${openAnchor ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden">{openAnchor && <HunkPeek anchor={openAnchor} />}</div>
      </div>
    </div>
  );
}
