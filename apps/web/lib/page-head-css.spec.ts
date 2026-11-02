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
    // margin: calc(var(--main-py) * -1) <sides> 0;  padding: var(--main-py) <sides> 16px;  -> it starts flush with the top of the page, so nothing above it scrolls away
    const margin = /margin:\s*calc\(var\(--main-py\) \* -1\)\s+[^;]*?\s+(-?\d+)(?:px)?;/.exec(head);
    const padding = /padding:\s*var\(--main-py\)\s+[^;]*?\s+(\d+)px;/.exec(head);
    expect(margin && padding).toBeTruthy();
    expect(Number(margin![1]) + Number(padding![1])).toBe(16);
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
    expect(withTabs).toMatch(/padding-bottom:\s*16px/);
    expect(withTabs).toMatch(/margin-bottom:\s*0/); // same space below the tabs as before
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

describe('sticky column headers for list tables', () => {
  /** The declaration block that follows an exact selector text, wherever it appears in the file. */
  const block = (selector: string) => {
    const at = css.indexOf(selector + ' {');
    if (at < 0) return '';
    return css.slice(at + selector.length + 2, css.indexOf('}', at)).replace(/\s+/g, ' ');
  };

  it('list cards clip instead of scrolling, so a header can stick to the page; a wide table falls back to sideways scrolling', () => {
    expect(block('.table-wrap.sticky-head')).toMatch(/overflow-x:\s*clip/);
    expect(block('.table-wrap.sticky-head.scroll-x')).toMatch(/overflow-x:\s*auto/);
  });

  it('the header cells stick directly under the sticky module header, opaque, and below it in layering', () => {
    const th = block('.table-wrap.sticky-head:not(.scroll-x) thead th');
    expect(th).toMatch(/position:\s*sticky/);
    expect(th).toMatch(/top:\s*var\(--page-head-h,\s*0px\)/);
    expect(th).toMatch(/background:\s*var\(--white\)/);
    const z = Number(/z-index:\s*(\d+)/.exec(th)?.[1]);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(zIndexOf('.page-head'));
  });

  it('every list table card opts in, and the layout runs the helper that sets --page-head-h', () => {
    const root = join(__dirname, '..');
    const read = (p: string) => readFileSync(join(root, p), 'utf8');
    for (const f of ['app/(app)/customers/page.tsx', 'app/(app)/quotes/page.tsx', 'app/(app)/platform/page.tsx', 'app/(app)/settings/page.tsx', 'components/TemplateBuilder.tsx', 'app/(app)/quotes/[id]/page.tsx', 'app/(app)/customers/[id]/page.tsx']) {
      expect(read(f)).toMatch(/table-wrap sticky-head/);
    }
    expect(read('app/(app)/layout.tsx')).toMatch(/<StickyTables \/>/);
    expect(read('components/StickyTables.tsx')).toMatch(/--page-head-h/);
  });
});

describe('sticky module footer (.module-footer)', () => {
  const footer = rule('.module-footer');

  it('is pinned to the bottom of the viewport, opaque, with a top line', () => {
    expect(footer).toMatch(/position:\s*sticky/);
    expect(footer).toMatch(/bottom:\s*0\b/);
    expect(footer).toMatch(/background:\s*var\(--bg\)/);
    expect(footer).toMatch(/border-top:/);
  });

  it('sits above page content, below the sticky header, and below dialogs, drawers and toasts', () => {
    const z = zIndexOf('.module-footer');
    expect(z).toBeGreaterThan(1);
    expect(z).toBeLessThan(zIndexOf('.page-head'));
    for (const above of ['.drawer', '.overlay', '.lightbox', '.toasts']) expect(zIndexOf(above)).toBeGreaterThan(z);
  });

  it('is flush with the page edges at the end of the page: it reaches into the side and bottom padding that the page defines', () => {
    expect(footer).toMatch(/calc\(var\(--main-px\) \* -1\)/);
    expect(footer).toMatch(/calc\(var\(--main-py\) \* -1\)/);
    expect(rule('.main')).toMatch(/--main-py:\s*22px/);
    expect(css).toMatch(/\.main \{ --main-px: 16px; --main-py: 14px;/);
  });

  it('the three modules that have a footer row use it, and no module gets an invented one', () => {
    const root = join(__dirname, '..');
    const read = (p: string) => readFileSync(join(root, p), 'utf8');
    for (const f of ['app/(app)/customers/page.tsx', 'app/(app)/quotes/page.tsx', 'app/(app)/dashboard/page.tsx']) expect(read(f)).toMatch(/className="row module-footer"/);
    for (const f of ['app/(app)/inbox/page.tsx', 'app/(app)/vehicles/page.tsx', 'app/(app)/settings/page.tsx', 'app/(app)/platform/page.tsx']) expect(read(f)).not.toMatch(/module-footer/);
  });
});
