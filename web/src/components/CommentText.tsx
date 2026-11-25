import type { ReactNode } from 'react';
import { parseMarkdown, type Token } from '../markdown';

function render(tokens: Token[]): ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'text':
        return t.text;
      case 'code':
        return (
          <code key={i} className="font-mono text-[0.875em]">
            {t.text}
          </code>
        );
      case 'block':
        // A <code> styled as a block, so it can sit inside the comment's <p>.
        return (
          <code key={i} className="my-1.5 block overflow-x-auto whitespace-pre font-mono text-[12.5px] leading-[1.5] text-ink">
            {t.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={i} className="font-semibold">
            {render(t.children)}
          </strong>
        );
      case 'em':
        return <em key={i}>{render(t.children)}</em>;
      case 'link':
        return (
          <a key={i} href={t.href} target="_blank" rel="noopener noreferrer" className="underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink">
            {render(t.children)}
          </a>
        );
    }
  });
}

/** A GitHub comment body: its inline markdown rendered, never its HTML. */
export function CommentText({ text }: { text: string }): ReactNode {
  return render(parseMarkdown(text));
}
