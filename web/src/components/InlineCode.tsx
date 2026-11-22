import { Fragment, type ReactNode } from 'react';

/** Render `backtick` spans as inline code; everything else stays plain text. */
export function InlineCode({ text }: { text: string }): ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
      <code key={i} className="font-mono text-[0.875em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
