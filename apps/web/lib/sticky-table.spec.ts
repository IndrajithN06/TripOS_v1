import { needsHorizontalScroll, SCROLL_X_CLASS } from './sticky-table';

describe('needsHorizontalScroll', () => {
  it('a table that fits its card keeps sticky headers', () => {
    expect(needsHorizontalScroll(800, 800)).toBe(false);
    expect(needsHorizontalScroll(700, 800)).toBe(false);
  });
  it('sub-pixel rounding does not trigger a scrollbar', () => expect(needsHorizontalScroll(801, 800)).toBe(false));
  it('a table wider than its card scrolls sideways instead of being cut off', () => {
    expect(needsHorizontalScroll(802, 800)).toBe(true);
    expect(needsHorizontalScroll(1200, 400)).toBe(true);
  });
  it('uses one class name that the stylesheet also knows', () => expect(SCROLL_X_CLASS).toBe('scroll-x'));
});
