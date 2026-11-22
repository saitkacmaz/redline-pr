import type { MarginComment } from '../../../shared/types';
import { AutoTextarea } from './AutoTextarea';
import { InlineCode } from './InlineCode';

interface Props {
  comments: MarginComment[];
  onReply: (commentId: string, text: string) => void;
  onStatus: (commentId: string, status: MarginComment['status']) => void;
}

function Comment({ comment, onReply, onStatus }: { comment: MarginComment } & Omit<Props, 'comments'>) {
  const pushedBack = comment.status === 'pushed_back';
  const where = comment.file ? `${comment.file.split('/').pop() ?? comment.file}${comment.line ? `:${comment.line}` : ''}` : null;

  return (
    <div className="group/comment border-l border-transparent pl-4 transition-colors duration-150 focus-within:border-ink/70 hover:border-rule">
      <div className="flex items-baseline gap-2 text-[13.5px]">
        <span className="font-semibold text-ink">@{comment.author}</span>
        {where && <span className="font-mono text-[11.5px] text-muted">{where}</span>}
      </div>
      <p className="mt-0.5 whitespace-pre-line text-[14px] leading-[1.55] text-ink/90">
        <InlineCode text={comment.body} />
      </p>

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

export function Margin({ comments, onReply, onStatus }: Props) {
  if (comments.length === 0) return null;
  return (
    <div className="space-y-6">
      {comments.map((c) => (
        <Comment key={c.id} comment={c} onReply={onReply} onStatus={onStatus} />
      ))}
    </div>
  );
}
