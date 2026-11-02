'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { needsHorizontalScroll, SCROLL_X_CLASS } from '@/lib/sticky-table';

/**
 * Keeps list-table column headers under the sticky module header (see `.page-head`). It renders nothing. It maintains two things:
 *  - `--page-head-h` on <html>: the current height of the module header, which is where column headers stick (0 on pages without one);
 *  - the `.scroll-x` class on a table card that is wider than the card: such a table scrolls sideways as before (its headers then scroll with it)
 *    instead of being clipped, because a header cannot stick inside a scroll container.
 * It only reads layout and sets one CSS variable and one class; nothing else about a page is touched.
 */
export function StickyTables() {
  const path = usePathname();
  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.main');
    if (!main) return;
    const root = document.documentElement;
    let frame = 0;
    const ro = new ResizeObserver(() => schedule());

    function update() {
      frame = 0;
      const head = main!.querySelector<HTMLElement>('.page-head');
      // rounded DOWN: the header is usually fractional (e.g. 57.9px), and rounding up would leave a hairline gap where row text shows through
      root.style.setProperty('--page-head-h', `${head ? Math.floor(head.getBoundingClientRect().height) : 0}px`);
      main!.querySelectorAll<HTMLElement>('.table-wrap.sticky-head').forEach((card) => {
        const table = card.querySelector('table');
        if (table) card.classList.toggle(SCROLL_X_CLASS, needsHorizontalScroll(table.scrollWidth, card.clientWidth));
      });
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(update); }
    function observe() {
      ro.disconnect();
      ro.observe(main!);
      main!.querySelectorAll('.page-head, .table-wrap.sticky-head, .table-wrap.sticky-head table').forEach((el) => ro.observe(el));
      schedule();
    }

    // pages render their header and tables after data arrives, so watch for new nodes as well
    const mo = new MutationObserver(observe);
    mo.observe(main, { childList: true, subtree: true });
    observe();
    return () => { mo.disconnect(); ro.disconnect(); if (frame) cancelAnimationFrame(frame); root.style.removeProperty('--page-head-h'); };
  }, [path]);
  return null;
}
