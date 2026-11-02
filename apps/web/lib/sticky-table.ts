/**
 * Sticky column headers for list tables.
 *
 * A header can only stick to the page while its table card is NOT a scroll container, so list cards use `overflow-x: clip`. A table wider than
 * its card would then be cut off, so such a table is switched back to the normal sideways scroll (`.scroll-x`) and its headers scroll with it.
 */
export const SCROLL_X_CLASS = 'scroll-x';

/** Whether a table is wider than the card that holds it. A 1px tolerance absorbs sub-pixel rounding. */
export function needsHorizontalScroll(contentWidth: number, cardWidth: number): boolean {
  return contentWidth > cardWidth + 1;
}
