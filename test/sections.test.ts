import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarginComment, SpecSection } from '../shared/types.js';
import { foldedFor, sectionOf, sectionSummary, toggleFolded, type Folded } from '../web/src/sections.js';

const clause = (id: string, edited = false) => ({ id, originalText: `was ${id}`, currentText: edited ? `now ${id}` : `was ${id}`, anchors: [] });
const comment = (id: string, clauseId: string): MarginComment => ({ id, author: 'a-reviewer', body: 'Why?', clauseId, status: 'open' });
const section = (id: string, clauses: ReturnType<typeof clause>[]): SpecSection => ({ id, title: id.toUpperCase(), clauses });

test('a folded section summarizes itself, leaving out counts of zero', () => {
  const untouched = section('s1', [clause('a'), clause('b'), clause('c'), clause('d'), clause('e')]);
  assert.equal(sectionSummary(untouched, []), '5 sentences');
  assert.equal(sectionSummary(section('s2', [clause('a')]), []), '1 sentence');

  const busy = section('s3', [clause('a', true), clause('b'), clause('c', true)]);
  assert.equal(sectionSummary(busy, [comment('x', 'a')]), '3 sentences · 2 edits · 1 comment');
  assert.equal(sectionSummary(busy, [comment('x', 'a'), comment('y', 'b')]), '3 sentences · 2 edits · 2 comments');
  assert.equal(sectionSummary(section('s4', [clause('a', true)]), [comment('x', 'elsewhere')]), '1 sentence · 1 edit', "another section's comments don't count");
  assert.equal(sectionSummary(section('s5', [clause('a'), clause('b')]), [comment('x', 'b')]), '2 sentences · 1 comment');
});

test('folding is view state only: it never touches the document that Sync reads', () => {
  const doc = { sections: [section('s1', [clause('a', true)]), section('s2', [clause('b')])] };
  const before = JSON.stringify(doc);
  let folded: Folded = { docId: null, ids: new Set() };
  folded = toggleFolded(folded, 'doc-1', 's1');
  assert.deepEqual([...foldedFor(folded, 'doc-1')], ['s1']);
  folded = toggleFolded(folded, 'doc-1', 's2');
  folded = toggleFolded(folded, 'doc-1', 's1');
  assert.deepEqual([...foldedFor(folded, 'doc-1')], ['s2'], 'a second click unfolds');
  assert.deepEqual([...foldedFor(toggleFolded(folded, 'doc-1', 's2', false), 'doc-1')], [], 'an explicit unfold (the Files jump)');
  assert.equal(JSON.stringify(doc), before, 'the spec, its edits and its comments are untouched');
});

test('a new spec (another PR, or Re-analyze) starts with every section open', () => {
  const folded = toggleFolded({ docId: null, ids: new Set() }, 'doc-1', 's1');
  assert.equal(foldedFor(folded, 'doc-2').size, 0, 'section ids of a new spec never inherit folds');
  assert.equal(foldedFor(folded, undefined).size, 0);
  assert.equal(foldedFor(toggleFolded(folded, 'doc-2', 's3'), 'doc-2').has('s1'), false, 'folding in the new spec starts fresh');
});

test('the Files jump finds the section that holds a sentence', () => {
  const sections = [section('s1', [clause('a')]), section('s2', [clause('b'), clause('c')])];
  assert.equal(sectionOf(sections, 'c')?.id, 's2');
  assert.equal(sectionOf(sections, 'zz'), undefined);
});
