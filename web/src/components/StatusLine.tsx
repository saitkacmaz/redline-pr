import { useEffect, useRef, useState } from 'react';
import type { Activity } from '../../../shared/types';

/** Re-render every second while `active`, so elapsed time is real time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

/** The current real step and elapsed seconds, in one quiet monospace line: "Editing ingest.py · 11s". */
export function StatusLine({ activity }: { activity: Activity }) {
  const running = activity.state === 'running';
  const now = useNow(running);
  const seconds = Math.max(0, Math.floor(((activity.endedAt ?? now) - activity.startedAt) / 1000));
  return (
    <p className={`font-mono text-[12.5px] leading-[1.6] ${activity.state === 'error' ? 'text-del' : 'text-ink'}`}>
      <span role="status">{activity.step}</span>
      <span className="text-muted" aria-hidden="true">
        {' '}
        · {seconds}s
      </span>
    </p>
  );
}

/** A collapsed "Show log" link over the raw stream of steps and Claude's notes. */
export function LogPeek({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (open && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [open, lines.length]);
  if (lines.length === 0) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer text-[12px] text-muted hover:text-ink"
      >
        {open ? 'Hide log' : 'Show log'}
      </button>
      {open && (
        <pre
          ref={pre}
          className="mt-3 max-h-[40vh] overflow-auto border-l border-rule pl-4 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-ink/80 [overflow-wrap:anywhere]"
        >
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
