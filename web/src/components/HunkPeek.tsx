import type { CodeAnchor } from '../../../shared/types';
import { PathLabel } from './PathLabel';

interface Line {
  kind: 'add' | 'del' | 'ctx' | 'header';
  text: string;
  number?: number;
}

function parseHunk(hunk: string): Line[] {
  const lines: Line[] = [];
  let next = 0;
  let inHunk = false;
  for (const raw of hunk.split('\n')) {
    if (raw === '') continue;
    if (raw.startsWith('diff --git ')) inHunk = false;
    if (!inHunk && !raw.startsWith('@@')) continue; // file headers of a full patch
    inHunk = true;
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      next = Number(header[1]);
      lines.push({ kind: 'header', text: raw });
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), number: next++ });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1) });
    } else if (raw.startsWith('\\')) {
      lines.push({ kind: 'header', text: raw });
    } else {
      lines.push({ kind: 'ctx', text: raw.slice(1), number: next++ });
    }
  }
  return lines;
}

const tone: Record<Line['kind'], string> = {
  add: 'text-ins',
  del: 'text-del line-through decoration-del/40',
  ctx: 'text-muted',
  header: 'text-muted',
};

const mark: Record<Line['kind'], string> = { add: '+', del: '−', ctx: ' ', header: ' ' };

/** Unified-diff lines with new-side numbers; lines in `highlight` render in full ink. */
export function DiffLines({ hunk, highlight }: { hunk: string; highlight?: { start: number; end: number } }) {
  return (
    <pre className="overflow-x-auto font-mono text-[12.5px] leading-[1.6]">
      {parseHunk(hunk).map((line, i) => {
        const inRange =
          highlight !== undefined && line.number !== undefined && line.number >= highlight.start && line.number <= highlight.end;
        return (
          <div key={i} className={`flex ${inRange ? 'text-ink' : ''}`}>
            <span className="w-9 shrink-0 select-none pr-3 text-right text-muted">{line.number ?? ''}</span>
            <span className="w-3 shrink-0 select-none text-muted">{mark[line.kind]}</span>
            <span className={inRange && line.kind !== 'del' ? (line.kind === 'add' ? 'text-ins' : 'text-ink') : tone[line.kind]}>
              {line.text || ' '}
            </span>
          </div>
        );
      })}
    </pre>
  );
}

export function HunkPeek({ anchor }: { anchor: CodeAnchor }) {
  return (
    <div className="mt-3 mb-1 border-l border-ink/80 pl-4">
      <div className="mb-1.5 font-mono text-[11.5px] text-muted">
        <PathLabel path={anchor.file} startLine={anchor.startLine} endLine={anchor.endLine} />
      </div>
      {anchor.hunk.trim() === '' ? (
        <div className="font-mono text-[12.5px] text-muted">No diff lines for this range.</div>
      ) : (
        <DiffLines hunk={anchor.hunk} highlight={{ start: anchor.startLine, end: anchor.endLine }} />
      )}
    </div>
  );
}
