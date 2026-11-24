/** A margin note: where its sentence starts (relative to the prose) and how tall the note is. */
export interface NoteBox {
  want: number;
  height: number;
}

/**
 * Margin note positions, like sidenotes on a printed page: each note sits level with
 * its sentence when it can, and otherwise just below the note above it, never
 * overlapping. Notes are placed in order of their sentence's position; the result is
 * in input order. Only the margin moves: the prose is never pushed apart.
 */
export function layoutNotes(boxes: readonly NoteBox[], gap: number): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.want - boxes[b]!.want || a - b);
  const tops = new Array<number>(boxes.length);
  let floor = Number.NEGATIVE_INFINITY;
  for (const i of order) {
    const box = boxes[i]!;
    const top = Math.max(box.want, floor);
    tops[i] = top;
    floor = top + box.height + gap;
  }
  return tops;
}
