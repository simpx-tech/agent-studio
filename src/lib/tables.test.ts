import { expect, it } from 'vitest';
import { TALLEST, columnWidths, columnWindow, numeric, rowWindow } from './tables';

it('aligns the cells that read as numbers', () => {
  for (const cell of [
    '42',
    '-3.5',
    '1,234,567.89',
    '1.234.567,89',
    '137,50',
    '1 234,5',
    '12%',
    '.5',
    '6.02e23',
    ' 7 ',
  ])
    expect(numeric(cell), cell).toBe(true);
  for (const cell of ['', 'North', '2026-10-21', '1.2.3', '12 kg', 'e5', '1,23,4'])
    expect(numeric(cell), cell).toBe(false);
});

it('sizes columns by what their first rows hold, within bounds', () => {
  const widths = columnWidths(
    [
      ['Region', 'Sales', ''],
      ['North', '1234.5', 'A long note about the quarter that keeps going past any column'],
    ],
    4,
  );
  expect(widths[0]).toBeGreaterThan(56);
  expect(widths[1]).toBeGreaterThan(56);
  // A long text stops at the widest column, and an empty column keeps the narrowest.
  expect(widths[2]).toBe(360);
  expect(widths[3]).toBe(56);
  // The longest cells the table's computer reports size the columns, rows still to come included.
  expect(columnWidths([['a', 'b']], 2, [3, 30])).toEqual([56, Math.round(30 * 7.4 + 22)]);
});

it('draws the rows in view, and maps a sheet too tall to scroll onto its rows', () => {
  const row = 28;
  // At the top, the first rows; scrolled, the rows under the view, a few past it.
  expect(rowWindow({ scrollTop: 0, viewport: 280, row, rows: 1000 })).toEqual({
    first: 0,
    last: 12,
    top: 0,
    height: 28_000,
  });
  const scrolled = rowWindow({ scrollTop: 2_800, viewport: 280, row, rows: 1000 });
  expect(scrolled).toMatchObject({ first: 100, top: 2_800 });
  // The last rows stop at the sheet's end.
  expect(rowWindow({ scrollTop: 27_720, viewport: 280, row, rows: 1000 }).last).toBe(999);
  expect(rowWindow({ scrollTop: 0, viewport: 280, row, rows: 0 })).toMatchObject({ last: -1 });
  // Ten million rows scroll the tallest height, the view standing for its share of them.
  const rows = 10_000_000;
  const start = rowWindow({ scrollTop: 0, viewport: 280, row, rows });
  expect(start).toMatchObject({ first: 0, top: 0, height: TALLEST });
  const middle = rowWindow({ scrollTop: (TALLEST - 280) / 2, viewport: 280, row, rows });
  expect(middle.first / rows).toBeCloseTo(0.5, 3);
  expect(middle.top).toBe((TALLEST - 280) / 2);
  const end = rowWindow({ scrollTop: TALLEST - 280, viewport: 280, row, rows });
  expect(end.last).toBe(rows - 1);
});

it('finds the columns in view among many thousands', () => {
  const offsets = Array.from({ length: 10_001 }, (_, index) => index * 100);
  expect(columnWindow({ scrollLeft: 0, viewport: 250, gutter: 40, offsets })).toEqual([0, 1, 2]);
  expect(columnWindow({ scrollLeft: 500_000, viewport: 250, gutter: 40, offsets })).toEqual([
    4999, 5000, 5001, 5002,
  ]);
  expect(columnWindow({ scrollLeft: 999_900, viewport: 250, gutter: 40, offsets }).at(-1)).toBe(
    9999,
  );
  expect(columnWindow({ scrollLeft: 0, viewport: 250, gutter: 40, offsets: [0] })).toEqual([]);
});
