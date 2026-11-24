import { useLayoutEffect, useRef, useState } from 'react';
import type { HiddenThread, MarginComment, ThreadReply } from '../../../shared/types';
import { AutoTextarea } from './AutoTextarea';
import { InlineCode } from './InlineCode';

interface Props {
  comments: MarginComment[];
  /** Its sentence is hovered or focused. */
  linked?: boolean;
  onReply: (commentId: string, text: string) => void;
  onStatus: (commentId: string, status: MarginComment['status']) => void;
}

const BODY = 'whitespace-pre-line text-[14px] leading-[1.55] text-ink/90';
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function Reply({ reply, clamp, ref }: { reply: ThreadReply; clamp: boolean; ref?: React.Ref<HTMLParagraphElement> }) {
  return (
    <div className="mt-2.5">
      <span className="text-[13px] font-semibold text-ink">@{reply.author}</span>
      <p ref={ref} className={`mt-0.5 ${BODY} ${clamp ? 'line-clamp-4' : ''}`}>
        <InlineCode text={reply.body} />
      </p>
    </div>
  );
}

/**
 * One thread, kept compact: the opening comment and the latest reply, each clamped,
 * with a plain toggle to read the whole thread in place.
 */
function Comment({ comment, linked, onReply, onStatus }: { comment: MarginComment; linked: boolean } & Omit<Props, 'comments' | 'linked'>) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  const reply = useRef<HTMLParagraphElement>(null);
  const pushedBack = comment.status === 'pushed_back';
  const where = comment.file ? `${comment.file.split('/').pop() ?? comment.file}${comment.line ? `:${comment.line}` : ''}` : null;
  const replies = comment.replies ?? [];
  const latest = replies.at(-1);

  useLayoutEffect(() => {
    if (open) return;
    setClamped([body.current, reply.current].some((el) => el !== null && el.scrollHeight > el.clientHeight + 1));
  }, [open, comment.body, latest?.body]);

  const expandable = replies.length > 1 || clamped || (comment.omittedReplies ?? 0) > 0;
  const toggle = open ? 'less' : replies.length > 1 ? plural(replies.length, 'reply', 'replies') : 'more';

  return (
    <div
      className={`group/comment border-l pl-4 transition-colors duration-150 ${linked ? 'border-ink' : 'border-transparent hover:border-rule'} focus-within:border-ink/70`}
    >
      <div className="flex items-baseline gap-2 text-[13.5px]">
        <span className="font-semibold text-ink">@{comment.author}</span>
        {where && <span className="font-mono text-[11.5px] text-muted">{where}</span>}
        {comment.replied && (
          <span className="text-[12px] text-muted" title="You replied last; waiting on the reviewer.">
            replied
          </span>
        )}
      </div>
      <p ref={body} className={`mt-0.5 ${BODY} ${open ? '' : 'line-clamp-5'}`}>
        <InlineCode text={comment.body} />
      </p>
      {open ? replies.map((r, i) => <Reply key={i} reply={r} clamp={false} />) : latest && <Reply ref={reply} reply={latest} clamp />}
      {open && (comment.omittedReplies ?? 0) > 0 && (
        <p className="mt-2 text-[12.5px] text-muted">{plural(comment.omittedReplies ?? 0, 'earlier reply', 'earlier replies')} on GitHub</p>
      )}
      {expandable && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-1 cursor-pointer text-[12px] text-muted hover:text-ink"
        >
          {toggle}
        </button>
      )}

      <AutoTextarea
        value={comment.replyDraft ?? ''}
        onChange={(text) => onReply(comment.id, text)}
        placeholder="Reply…"
        aria-label={`Reply to ${comment.author}`}
        className="mt-2 text-[14px] leading-[1.55] text-ink"
      />

      <button
        type="button"
        aria-pressed={pushedBack}
        title="Claude Code will be told not to act on this comment."
        onClick={() => onStatus(comment.id, pushedBack ? 'open' : 'pushed_back')}
        className={`mt-1.5 cursor-pointer text-[12px] hover:text-ink focus-visible:opacity-100 ${
          pushedBack ? 'text-ink' : 'text-muted opacity-0 transition-opacity duration-150 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100'
        }`}
      >
        {pushedBack ? 'pushed back · undo' : 'push back'}
      </button>
    </div>
  );
}

export function Margin({ comments, linked = false, onReply, onStatus }: Props) {
  if (comments.length === 0) return null;
  return (
    <div className="space-y-6">
      {comments.map((c) => (
        <Comment key={c.id} comment={c} linked={linked} onReply={onReply} onStatus={onStatus} />
      ))}
    </div>
  );
}

/** Resolved and outdated threads: one muted line, expandable only if you want to look. */
export function HiddenThreads({ threads }: { threads: HiddenThread[] }) {
  const [open, setOpen] = useState(false);
  if (threads.length === 0) return null;
  return (
    <div className="pl-4">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="cursor-pointer text-[12.5px] text-muted hover:text-ink">
        {threads.length} resolved/outdated hidden
      </button>
      {open && (
        <ul className="mt-4 space-y-4">
          {threads.map((t) => (
            <li key={t.id} className="-ml-4 border-l border-rule pl-4 text-[13.5px] leading-[1.55] text-muted">
              <span className="font-semibold">@{t.author}</span>
              {t.file && <span className="ml-2 font-mono text-[11.5px]">{t.file.split('/').pop()}</span>}
              <span className="ml-2 text-[12px]">
                {t.reason}
                {t.replyCount > 0 ? ` · ${plural(t.replyCount, 'reply', 'replies')}` : ''}
              </span>
              <p className="mt-0.5 line-clamp-3 whitespace-pre-line">{t.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
