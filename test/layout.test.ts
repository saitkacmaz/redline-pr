import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutNotes } from '../web/src/layout.js';

const GAP = 16;

test('notes sit level with their sentence when there is room', () => {
  assert.deepEqual(layoutNotes([{ want: 0, height: 80 }, { want: 200, height: 60 }], GAP), [0, 200]);
});

test('a tall note pushes the next one down, never into it', () => {
  const tops = layoutNotes([{ want: 0, height: 300 }, { want: 40, height: 50 }, { want: 60, height: 50 }], GAP);
  assert.deepEqual(tops, [0, 316, 382]);
});

test('notes are placed in sentence order, whatever order they come in', () => {
  const boxes = [{ want: 500, height: 40 }, { want: 0, height: 40 }, { want: 20, height: 40 }];
  assert.deepEqual(layoutNotes(boxes, GAP), [500, 0, 56]);
});

test('no overlaps and no note above its sentence, for any input', () => {
  let seed = 7;
  const rand = (n: number): number => ((seed = (seed * 16807) % 2147483647) % n);
  for (let run = 0; run < 200; run++) {
    const boxes = Array.from({ length: 1 + rand(30) }, () => ({ want: rand(3000), height: 20 + rand(400) }));
    const tops = layoutNotes(boxes, GAP);
    const placed = boxes.map((b, i) => ({ ...b, top: tops[i]! })).sort((a, b) => a.top - b.top);
    for (const [i, note] of placed.entries()) {
      assert.ok(note.top >= note.want, 'a note never sits above its sentence');
      const prev = placed[i - 1];
      if (prev) assert.ok(note.top >= prev.top + prev.height + GAP, 'notes never overlap');
    }
  }
});

test('the result only depends on the notes: the prose is an input, never an output', () => {
  // Same sentence positions with a much taller note: the sentences don't move, only notes do.
  const short = layoutNotes([{ want: 0, height: 40 }, { want: 100, height: 40 }], GAP);
  const tall = layoutNotes([{ want: 0, height: 900 }, { want: 100, height: 40 }], GAP);
  assert.equal(short[0], tall[0]);
  assert.equal(tall[1], 916);
});
