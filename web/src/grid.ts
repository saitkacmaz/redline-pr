/*
 * One layout, three tiers, shared by the top bar, the spec, the margin and every row
 * that lines up with them:
 *
 *   < 860px      one column, max 680px; margin comments follow their sentence inline
 *   860-1119px   two fluid columns: minmax(0, 1fr) prose + a 240-300px margin, 32px apart
 *   >= 1120px    680px prose + 48px + 340px margin, centred
 *
 * Nothing is wider than the window at any size: columns are minmax(0, …) and wide
 * content (code, logs) scrolls inside itself.
 */

/** The page's horizontal frame: 680px of text in one column; at `wide`, 26px padding leaves exactly 680 + 48 + 340. */
export const SHELL =
  'mx-auto w-full max-w-[712px] px-4 sm:max-w-[728px] sm:px-6 split:max-w-none split:px-6 wide:max-w-[1120px] wide:px-[26px]';

/** The two columns, from `split` up; a plain block below it. */
export const COLUMNS =
  'split:grid split:grid-cols-[minmax(0,1fr)_minmax(240px,300px)] split:gap-x-8 wide:grid-cols-[680px_340px] wide:gap-x-12';

/** Where the margin rail is shown (and notes are placed beside the prose). Matches `split`. */
export const TWO_COLUMNS = '(min-width: 860px)';
