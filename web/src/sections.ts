import type { MarginComment, SpecSection } from '../../shared/types';
import { isEdited } from './state';

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What a folded section still tells you: `5 sentences · 1 edit · 2 comments`, zeros left out. */
export function sectionSummary(section: SpecSection, comments: MarginComment[]): string {
  const ids = new Set(section.clauses.map((c) => c.id));
  const edits = section.clauses.filter(isEdited).length;
  const notes = comments.filter((c) => ids.has(c.clauseId)).length;
  return [
    count(section.clauses.length, 'sentence', 'sentences'),
    ...(edits > 0 ? [count(edits, 'edit', 'edits')] : []),
    ...(notes > 0 ? [count(notes, 'comment', 'comments')] : []),
  ].join(' · ');
}

/** The section holding a sentence, if any. */
export function sectionOf(sections: SpecSection[], clauseId: string): SpecSection | undefined {
  return sections.find((s) => s.clauses.some((c) => c.id === clauseId));
}

/** Folded sections belong to one loaded spec; a new spec starts with every section open. */
export interface Folded {
  docId: string | null;
  ids: ReadonlySet<string>;
}

export function foldedFor(folded: Folded, docId: string | undefined): ReadonlySet<string> {
  return folded.docId === docId ? folded.ids : new Set();
}

export function toggleFolded(folded: Folded, docId: string, sectionId: string, fold?: boolean): Folded {
  const ids = new Set(foldedFor(folded, docId));
  if (fold ?? !ids.has(sectionId)) ids.add(sectionId);
  else ids.delete(sectionId);
  return { docId, ids };
}
