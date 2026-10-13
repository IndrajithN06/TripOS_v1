import {
  buildSendParts, compile, extractVariables, formatInr, renderPreview, requiredVariables, resolveValues, sanitizeParam, TemplateSpec, toMetaComponents, toNamedBody,
  validateTemplate, VARIABLES,
} from './template-spec';

const spec = (over: Partial<TemplateSpec> = {}): TemplateSpec => ({
  purpose: 'quotation', header: { type: 'none' },
  body: 'Hello {{customer_name}}, thank you for choosing {{agency_name}}.\nDestination: {{destination}}\nTotal: {{quote_total}}',
  footer: 'Golden Travels | +91 98450 12345', buttons: [], ...over,
});
const meta = (s: TemplateSpec, over: Partial<{ name: string; language: string; category: string }> = {}) => ({ name: 'quote_premium', language: 'en', category: 'UTILITY', spec: s, ...over });
const errs = (s: TemplateSpec, over = {}) => validateTemplate(meta(s, over)).errors.map((e) => `${e.field}: ${e.message}`);

describe('variables', () => {
  it('extracts unique names in order and reports invalid ones', () => {
    expect(extractVariables('Hi {{customer_name}} {{ destination }} {{customer_name}}')).toEqual(['customer_name', 'destination']);
    expect(extractVariables('x {{Bad Name}} {{1}}')).toEqual(['Bad Name', '1']);
    expect(extractVariables(undefined)).toEqual([]);
  });
  it('the catalogue covers every variable named in the product brief', () => {
    for (const k of ['customer_name', 'agency_name', 'destination', 'travel_dates', 'passenger_count', 'vehicle_type', 'quote_total', 'quote_link']) expect(VARIABLES[k]).toBeDefined();
  });
});

describe('validation against Meta limits', () => {
  it('accepts the premium quotation example', () => {
    const s = spec({ header: { type: 'image', source: 'logo' }, buttons: [{ type: 'url', text: 'View Quotation', url: 'https://app.example.com/q/{{quote_token}}' }, { type: 'phone', text: 'Contact Us', phone: '+919845012345' }] });
    expect(errs(s)).toEqual([]);
  });
  it.each([
    ['name with spaces', {}, { name: 'Quote Premium' }, /name/],
    ['bad language', {}, { language: 'English' }, /language/],
    ['authentication category', {}, { category: 'AUTHENTICATION' }, /category/],
  ])('rejects %s', (_n, s, over, re) => { expect(errs(spec(s as any), over).join('|')).toMatch(re); });
  it('enforces header rules', () => {
    expect(errs(spec({ header: { type: 'text', text: 'x'.repeat(61) } })).join()).toMatch(/at most 60/);
    expect(errs(spec({ header: { type: 'text', text: '{{agency_name}} {{destination}}' } })).join()).toMatch(/only one variable/);
    expect(errs(spec({ header: { type: 'text', text: '' } })).join()).toMatch(/required/);
    expect(errs(spec({ header: { type: 'image' } })).join()).toMatch(/header image/);
    expect(errs(spec({ header: { type: 'document', source: 'logo' } })).join()).toMatch(/quotation PDF/);
    expect(errs(spec({ header: { type: 'text', text: 'Your quote from {{agency_name}}' } }))).toEqual([]);
  });
  it('enforces body and footer rules (variables ARE allowed anywhere in the body)', () => {
    expect(errs(spec({ body: '' })).join()).toMatch(/body is required/);
    expect(errs(spec({ body: 'x'.repeat(1025) })).join()).toMatch(/1024/);
    expect(errs(spec({ body: '{{Bad Name}} hi' })).join()).toMatch(/not a valid variable/);
    expect(errs(spec({ body: '{{customer_name}}' }))).toEqual([]);
    expect(errs(spec({ footer: 'x'.repeat(61) })).join()).toMatch(/at most 60/);
    expect(errs(spec({ footer: 'Call {{agency_phone}}' })).join()).toMatch(/footer/);
  });
  it('enforces button rules', () => {
    const url = (u: string, t = 'View') => spec({ buttons: [{ type: 'url', text: t, url: u }] });
    expect(errs(url('http://insecure.example.com'))).toHaveLength(1);
    expect(errs(url('https://x.com/{{quote_token}}/more')).join()).toMatch(/very end/);
    expect(errs(url('https://x.com/{{a}}/{{b}}')).join()).toMatch(/only one variable/);
    expect(errs(url('https://x.com/q/{{quote_token}}'))).toEqual([]);
    expect(errs(url('https://x.com/q', 'x'.repeat(26))).join()).toMatch(/at most 25/);
    expect(errs(spec({ buttons: [{ type: 'phone', text: 'Call', phone: '98450' }] })).join()).toMatch(/international format/);
    expect(errs(spec({ buttons: [{ type: 'quick_reply', text: 'Yes' }, { type: 'quick_reply', text: 'yes' }] })).join()).toMatch(/different/);
    const three = (['a', 'b', 'c'] as const).map((n) => ({ type: 'url' as const, text: n, url: `https://x.com/${n}` }));
    expect(errs(spec({ buttons: three })).join()).toMatch(/At most 2 URL/);
    const two = [{ type: 'phone' as const, text: 'A', phone: '+919845012345' }, { type: 'phone' as const, text: 'B', phone: '+919845012346' }];
    expect(errs(spec({ buttons: two })).join()).toMatch(/one phone/);
    expect(errs(spec({ buttons: Array.from({ length: 11 }, (_, i) => ({ type: 'quick_reply' as const, text: `q${i}` })) })).join()).toMatch(/at most 10/);
  });
  it('warns (without blocking) on marketing category, mixed button order and missing total', () => {
    const v = validateTemplate(meta(spec({ body: 'Hello {{customer_name}}', buttons: [{ type: 'quick_reply', text: 'A' }, { type: 'url', text: 'B', url: 'https://x.com' }, { type: 'quick_reply', text: 'C' }] }), { category: 'MARKETING' }));
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((w) => w.field).sort()).toEqual(['body', 'buttons', 'category']);
  });
});

describe('compilation to Meta format', () => {
  it('converts names to positional numbers and keeps the mapping, reusing a number for a repeated name', () => {
    const c = compile(spec({ body: 'Hi {{customer_name}}, {{agency_name}} here. Bye {{customer_name}}.' }));
    expect(c.body).toBe('Hi {{1}}, {{2}} here. Bye {{1}}.');
    expect(c.bodyVariables).toEqual(['customer_name', 'agency_name']);
  });
  it('builds the components Meta expects, with example values from the catalogue', () => {
    const c = compile(spec({
      header: { type: 'text', text: 'Quote for {{customer_name}}' }, footer: 'Golden Travels',
      buttons: [{ type: 'url', text: 'View Quotation', url: 'https://app.example.com/q/{{quote_token}}' }, { type: 'phone', text: 'Contact Us', phone: '+919845012345' }],
    }));
    expect(toMetaComponents(c)).toEqual([
      { type: 'HEADER', format: 'TEXT', text: 'Quote for {{1}}', example: { header_text: ['Rahul Shetty'] } },
      { type: 'BODY', text: c.body, example: { body_text: [['Rahul Shetty', 'Golden Travels', 'Coorg', '₹21,000.00']] } },
      { type: 'FOOTER', text: 'Golden Travels' },
      { type: 'BUTTONS', buttons: [
        { type: 'URL', text: 'View Quotation', url: 'https://app.example.com/q/{{1}}', example: ['https://app.example.com/q/AbC123xyz'] },
        { type: 'PHONE_NUMBER', text: 'Contact Us', phone_number: '+919845012345' },
      ] },
    ]);
  });
  it('media headers need an uploaded example handle', () => {
    const c = compile(spec({ header: { type: 'image', source: 'logo' } }));
    expect(() => toMetaComponents(c)).toThrow(/example/);
    expect(toMetaComponents(c, { headerHandle: '4::abc' })[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::abc'] } });
    expect(toMetaComponents(compile(spec({ header: { type: 'document', source: 'quote_pdf' } })), { headerHandle: '4::pdf' })[0]).toMatchObject({ format: 'DOCUMENT' });
  });
  it('omits examples when there are no variables, and round-trips legacy positional bodies', () => {
    expect(toMetaComponents(compile(spec({ body: 'Plain text only' })))).toEqual([{ type: 'BODY', text: 'Plain text only' }, { type: 'FOOTER', text: 'Golden Travels | +91 98450 12345' }]);
    expect(toNamedBody('Hi {{1}}, quote {{2}} {{3}}', ['name', 'quote'])).toBe('Hi {{name}}, quote {{quote}} {{variable_3}}');
  });
});

describe('preview and strict send values', () => {
  const s = spec({ header: { type: 'text', text: '{{agency_name}}' }, buttons: [{ type: 'url', text: 'View', url: 'https://x.com/q/{{quote_token}}' }] });
  it('builder preview fills gaps with catalogue samples and does not report missing', () => {
    const p = renderPreview(s, { customer_name: 'Asha' }, true);
    expect(p.body).toContain('Hello Asha, thank you for choosing Golden Travels.');
    expect(p.body).toContain('Total: ₹21,000.00');
    expect(p.header.text).toBe('Golden Travels');
    expect(p.buttons[0].target).toBe('https://x.com/q/AbC123xyz');
    expect(p.missing).toEqual([]);
  });
  it('strict preview keeps unresolved placeholders and lists them', () => {
    const p = renderPreview(s, { customer_name: 'Asha' }, false);
    expect(p.body).toContain('{{agency_name}}');
    expect(p.missing.sort()).toEqual(['agency_name', 'destination', 'quote_token', 'quote_total']);
  });
  it('lists required variables across header, body and URL button', () => {
    expect(requiredVariables(s).sort()).toEqual(['agency_name', 'customer_name', 'destination', 'quote_token', 'quote_total']);
  });
  it('strict send parts come out in positional order and refuse missing or empty values', () => {
    const c = compile(s);
    const all = { customer_name: 'Asha', agency_name: 'Golden', destination: 'Coorg', quote_total: '₹1.00', quote_token: 'tok' };
    expect(buildSendParts(c, all).parts).toEqual({ bodyParams: ['Asha', 'Golden', 'Coorg', '₹1.00'], headerText: 'Golden', buttons: [{ index: 0, kind: 'url', value: 'tok' }] });
    expect(buildSendParts(c, { ...all, destination: '   ' }).missing).toEqual(['destination']);
    expect(buildSendParts(c, { customer_name: 'Asha' }).missing.sort()).toEqual(['agency_name', 'destination', 'quote_token', 'quote_total']);
  });
  it('makes parameter values safe for Meta (no line breaks, tabs or long space runs)', () => {
    expect(sanitizeParam('Day 1\nCoorg\t\tDay 2      end')).toBe('Day 1 Coorg Day 2    end');
    expect(sanitizeParam('x'.repeat(2000))).toHaveLength(1024);
  });
});

describe('resolving values from business data', () => {
  const ctx = {
    customerName: 'Rahul Shetty', agency: { name: 'Golden Travels', phone: '+91 98450 12345', email: null, website: 'golden.example' }, timezone: 'Asia/Kolkata', publicBaseUrl: 'https://app.example.com/',
    quote: { number: 'Q-0007', version: 2, total: '197200.00', destinations: ['Coorg', 'Mysore'], pickupLocation: 'Bangalore', pickupAt: '2026-10-13T14:30:00.000Z', returnAt: '2026-10-16T14:30:00.000Z', passengers: 6, vehicleName: 'Urbania', validUntil: new Date('2026-10-19T15:00:00Z'), publicToken: 'tok123' },
  };
  it('fills every catalogue variable from the quote and agency, formatted for customers', () => {
    const v = resolveValues(ctx);
    expect(v).toMatchObject({
      customer_name: 'Rahul Shetty', agency_name: 'Golden Travels', agency_phone: '+91 98450 12345', agency_website: 'golden.example', destination: 'Coorg, Mysore', pickup_location: 'Bangalore',
      passenger_count: '6', vehicle_type: 'Urbania', quote_number: 'Q-0007', quote_version: '2', quote_total: '₹1,97,200.00', travel_dates: '13 Oct 2026 – 16 Oct 2026', valid_until: '19 Oct 2026',
      quote_token: 'tok123', quote_link: 'https://app.example.com/q/tok123',
    });
    expect(v.agency_email).toBeUndefined();   // not configured: stays unresolved rather than invented
  });
  it('uses a single date for same-day trips and leaves quote variables out when there is no quote', () => {
    expect(resolveValues({ ...ctx, quote: { ...ctx.quote, returnAt: ctx.quote.pickupAt } }).travel_dates).toBe('13 Oct 2026');
    expect(Object.keys(resolveValues({ ...ctx, quote: undefined })).sort()).toEqual(['agency_name', 'agency_phone', 'agency_website', 'customer_name']);
  });
  it('formats rupees with Indian grouping', () => { expect(formatInr('1234567.5')).toBe('₹12,34,567.50'); });
});
