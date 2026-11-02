import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The module header (`.page-head`, used by every module page) must stay at the top while the page scrolls. It is one shared CSS class, so this
 * guards that rule against being dropped, made see-through, or layered above dialogs. The real behaviour is checked in the browser.
 */
const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
const rule = (selector: string) => {
  // the rule may share a line with others, so accept start-of-file, whitespace or a closing brace before the selector
  const m = css.match(new RegExp(`(?:^|[\\s}])${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`));
  return m ? m[1].replace(/\s+/g, ' ') : '';
};
const zIndexOf = (selector: string) => Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1] ?? NaN);

describe('shared sticky module header (.page-head)', () => {
  const head = rule('.page-head');

  it('is sticky at the very top of the page', () => {
    expect(head).toMatch(/position:\s*sticky/);
    expect(head).toMatch(/top:\s*0\b/);
  });

  it('is opaque, so scrolling content never shows through it', () => {
    expect(head).toMatch(/background:\s*var\(--bg\)/);
  });

  it('sits above page content but below the drawer, dialogs, image viewer and toasts', () => {
    const z = zIndexOf('.page-head');
    expect(z).toBeGreaterThan(1);
    for (const above of ['.drawer', '.overlay', '.lightbox', '.toasts']) expect(zIndexOf(above)).toBeGreaterThan(z);
  });

  it('does not move at rest: the negative top margin is cancelled by padding, and the bottom spacing is still 16px', () => {
    const num = (re: RegExp) => Number(re.exec(head)?.[1]);
    // margin: -8px <sides> 4px;  padding: 8px <sides> 12px;
    const margin = /margin:\s*(-?\d+)px\s+[^;]*?\s+(-?\d+)px;/.exec(head);
    const padding = /padding:\s*(\d+)px\s+[^;]*?\s+(\d+)px;/.exec(head);
    expect(margin && padding).toBeTruthy();
    expect(Number(margin![1]) + Number(padding![1])).toBe(0);
    expect(Number(margin![2]) + Number(padding![2])).toBe(16);
    expect(Number.isNaN(num(/z-index:\s*(\d+)/))).toBe(false);
  });

  it('reaches into the page padding on both sides, at desktop and phone widths, so its background covers the gutters', () => {
    expect(head).toMatch(/calc\(var\(--main-px\) \* -1\)/);
    expect(rule('.main')).toMatch(/--main-px:\s*26px/);
    expect(css).toMatch(/\.main \{ --main-px: 16px;/);
  });

  it('a header with a tab row (Settings) keeps the tabs inside the sticky block, with no change at rest', () => {
    const withTabs = rule('.page-head.with-tabs');
    expect(withTabs).toMatch(/flex-direction:\s*column/);
    expect(withTabs).toMatch(/gap:\s*16px/); // same title-to-tabs gap as before
    expect(withTabs).toMatch(/padding-bottom:\s*0/);
    expect(withTabs).toMatch(/margin-bottom:\s*16px/); // same space below the tabs as before
    expect(rule('.page-head.with-tabs .tabs')).toMatch(/margin-bottom:\s*0/);
    const page = readFileSync(join(__dirname, '..', 'app', '(app)', 'settings', 'page.tsx'), 'utf8');
    const head = page.indexOf('className="page-head with-tabs"');
    const tabs = page.indexOf('className="tabs"');
    const close = page.indexOf('{tab ===');
    expect(head).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(head); // the tab row is inside the header block, not after it
    expect(tabs).toBeLessThan(close);
  });
});
