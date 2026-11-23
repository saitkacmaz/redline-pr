import type { MarginComment, SpecDocument } from '../../shared/types';

export type Action =
  | { type: 'load'; doc: SpecDocument | null }
  | { type: 'editClause'; clauseId: string; text: string }
  | { type: 'resetClause'; clauseId: string }
  | { type: 'reply'; commentId: string; text: string }
  | { type: 'status'; commentId: string; status: MarginComment['status'] };

export function reducer(doc: SpecDocument | null, action: Action): SpecDocument | null {
  if (action.type === 'load') return action.doc;
  if (!doc) return doc;

  switch (action.type) {
    case 'editClause':
    case 'resetClause':
      return {
        ...doc,
        sections: doc.sections.map((s) => ({
          ...s,
          clauses: s.clauses.map((c) =>
            c.id === action.clauseId
              ? { ...c, currentText: action.type === 'editClause' ? action.text : c.originalText }
              : c,
          ),
        })),
      };
    case 'reply':
      return {
        ...doc,
        comments: doc.comments.map((c) => (c.id === action.commentId ? { ...c, replyDraft: action.text } : c)),
      };
    case 'status':
      return {
        ...doc,
        comments: doc.comments.map((c) => (c.id === action.commentId ? { ...c, status: action.status } : c)),
      };
  }
}

export const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const isEdited = (clause: { originalText: string; currentText: string }): boolean =>
  normalize(clause.originalText) !== normalize(clause.currentText);

/* ---- Local draft persistence: survive reloads without touching the server ---- */

interface Draft {
  clauses: Record<string, string>;
  comments: Record<string, Pick<MarginComment, 'status' | 'replyDraft'>>;
}

function draftKey(doc: SpecDocument): string {
  const fingerprint = doc.sections
    .flatMap((s) => s.clauses.map((c) => `${c.id}:${c.originalText.length}`))
    .join('|');
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) hash = (hash * 31 + fingerprint.charCodeAt(i)) | 0;
  return `redline:${doc.branch}:${hash >>> 0}`;
}

export function saveDraft(doc: SpecDocument): void {
  const draft: Draft = { clauses: {}, comments: {} };
  for (const clause of doc.sections.flatMap((s) => s.clauses)) {
    if (isEdited(clause)) draft.clauses[clause.id] = clause.currentText;
  }
  for (const c of doc.comments) {
    if (c.status !== 'open' || c.replyDraft) {
      draft.comments[c.id] = { status: c.status, ...(c.replyDraft ? { replyDraft: c.replyDraft } : {}) };
    }
  }
  try {
    localStorage.setItem(draftKey(doc), JSON.stringify(draft));
  } catch {
    // Storage full or disabled; drafts just won't persist.
  }
}

/** Forget a spec's redlines, e.g. once Claude Code has applied them. */
export function clearDraft(doc: SpecDocument): void {
  try {
    localStorage.removeItem(draftKey(doc));
  } catch {
    // Storage disabled; nothing to clear.
  }
}

export function restoreDraft(doc: SpecDocument): SpecDocument {
  let draft: Draft;
  try {
    const raw = localStorage.getItem(draftKey(doc));
    if (!raw) return doc;
    draft = JSON.parse(raw) as Draft;
  } catch {
    return doc;
  }
  return {
    ...doc,
    sections: doc.sections.map((s) => ({
      ...s,
      clauses: s.clauses.map((c) => {
        const text = draft.clauses[c.id];
        return text === undefined ? c : { ...c, currentText: text };
      }),
    })),
    comments: doc.comments.map((c) => {
      const saved = draft.comments[c.id];
      return saved ? { ...c, ...saved } : c;
    }),
  };
}
