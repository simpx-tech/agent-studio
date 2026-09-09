import { expect, type Locator } from '@playwright/test';

export async function expectVisibleQuotaComparison(meter: Locator, overGuide: boolean) {
  await meter.scrollIntoViewIfNeeded();
  const paint = await meter.evaluate((element) => {
    const actual = element.querySelector('.quota-fill')!;
    const guide = element.querySelector('.recommended-fill')!;
    const a = actual.getBoundingClientRect();
    const g = guide.getBoundingClientRect();
    const y = a.top + a.height / 2;
    const shared = document.elementFromPoint(a.left + Math.min(a.width, g.width) / 2, y);
    const difference = document.elementFromPoint(a.left + (a.width + g.width) / 2, y);
    return {
      sharedIsGuide: shared === guide,
      differenceIsActual: difference === actual,
      guideColor: getComputedStyle(guide).backgroundColor,
      actualColor: getComputedStyle(actual).backgroundColor,
      markerContent: getComputedStyle(guide, '::after').content,
    };
  });
  expect(paint.sharedIsGuide).toBe(overGuide);
  expect(paint.guideColor).toBe(overGuide ? 'rgb(238, 177, 104)' : 'rgb(91, 120, 69)');
  if (overGuide) {
    expect(paint.differenceIsActual).toBe(true);
    expect(paint.actualColor).toBe('rgb(238, 130, 118)');
  }
  expect(paint.markerContent).toBe('none');
}
