/**
 * How a table a reply shows is laid out in its grid: which rows and columns are in view, and how
 * wide each column starts. Only those in view are drawn, so a sheet of any size scrolls at once.
 */

/** A cell that reads as a number, which a table aligns to the right. */
export const numeric = (cell: string) =>
  // Thousands grouped by a comma, a point, a space or an apostrophe, and a decimal point or
  // comma, as spreadsheets write numbers in either convention; or a number in scientific form.
  /^[-+]?(\d{1,3}([,.' ]\d{3})+|\d+)([.,]\d+)?%?$|^[-+]?\d*\.\d+(e[-+]?\d+)?$|^[-+]?\d+(\.\d+)?e[-+]?\d+$/i.test(
    cell.trim(),
  );

/**
 * How wide each column starts: from the longest cell of each column, as the computer keeping the
 * table reports it, so a long value further down is never cut; else from what its first rows hold.
 */
export function columnWidths(rows: string[][], columns: number, lengths?: number[]): number[] {
  const longest = Array<number>(columns).fill(0);
  if (lengths) lengths.forEach((length, column) => (longest[column] = length));
  else
    for (const row of rows)
      row.forEach((cell, column) => {
        if (column < columns) longest[column] = Math.max(longest[column], cell.length);
      });
  return longest.map((length) =>
    Math.min(360, Math.max(56, Math.round(Math.min(length, 48) * 7.4 + 22))),
  );
}

/**
 * Past this height a sheet's scroll stands for its rows in proportion: browsers cap how tall an
 * element can be, about 33 million pixels in Chromium and WebKit, which a million rows pass.
 */
export const TALLEST = 8_000_000;

/**
 * The rows of a sheet's body in view, below its header row: `first` and `last` count from the
 * first row below the header, `top` is where the first is drawn below the header, and `height`
 * is how tall the body scrolls. A body taller than `TALLEST` scrolls `TALLEST` pixels, each
 * standing for its share of the rows, and its rows are drawn where the view stands.
 */
export function rowWindow({
  scrollTop,
  viewport,
  row,
  rows,
}: {
  scrollTop: number;
  /** The height of the body's view, below the header. */
  viewport: number;
  row: number;
  rows: number;
}): { first: number; last: number; top: number; height: number } {
  if (rows <= 0) return { first: 0, last: -1, top: 0, height: 0 };
  const fits = Math.max(1, Math.ceil(Math.max(0, viewport) / row) + 1);
  const full = rows * row;
  const scaled = full > TALLEST;
  const height = scaled ? TALLEST : full;
  const travel = Math.max(1, height - viewport);
  const at = scaled
    ? Math.floor((Math.min(scrollTop, travel) / travel) * Math.max(0, rows - fits + 1))
    : Math.floor(scrollTop / row);
  const first = Math.min(Math.max(0, at), rows - 1);
  return {
    first,
    last: Math.min(rows - 1, first + fits + 1),
    top: scaled ? Math.min(Math.max(0, scrollTop), height) : first * row,
    height,
  };
}

/** The columns in view: those whose span meets the view, given where each starts. */
export function columnWindow({
  scrollLeft,
  viewport,
  gutter,
  offsets,
}: {
  scrollLeft: number;
  viewport: number;
  /** The width of the row numbers, which come before the first column. */
  gutter: number;
  /** Where each column starts, and after the last one where the columns end. */
  offsets: number[];
}): number[] {
  const columns: number[] = [];
  const end = scrollLeft + Math.max(viewport, 1);
  // The first column in view, found by halving: a sheet may have many thousands.
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (gutter + offsets[middle + 1] < scrollLeft) low = middle + 1;
    else high = middle;
  }
  for (let column = low; column < offsets.length - 1; column++) {
    if (gutter + offsets[column] > end) break;
    columns.push(column);
  }
  return columns;
}
