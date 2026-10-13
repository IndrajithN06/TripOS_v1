/**
 * WhatsApp template authoring model: rules, variables, compilation and previews. Pure (no I/O, no clock, no globals).
 *
 * Agencies write templates with readable variables such as {{customer_name}}. Meta's universally supported format is
 * positional ({{1}}, {{2}}), so `compile()` converts names to numbers for submission and keeps the name-to-number mapping,
 * which is also used to fill values when sending.
 *
 * Limits come from Meta's template-component documentation (checked October 2026): header text 60 chars and one variable,
 * body 1,024, footer 60 (no variables), button text 25, up to 10 buttons, at most 2 URL buttons and 1 phone button, a URL
 * button takes one variable at the very end. Re-check against Meta before relying on a specific number.
 */

export type TemplatePurpose = 'quotation' | 'followup' | 'enquiry_ack' | 'revised_quotation' | 'custom';
export const PURPOSES: Record<TemplatePurpose, string> = {
  quotation: 'Quotation', followup: 'Follow-up', enquiry_ack: 'Enquiry acknowledgement', revised_quotation: 'Revised quotation', custom: 'Custom message',
};
export type HeaderType = 'none' | 'text' | 'image' | 'document';
/** Where the media for an image/document header comes from when the template is sent. */
export type HeaderSource = 'logo' | 'vehicle_photo' | 'custom' | 'quote_pdf';
export type ButtonDef =
  | { type: 'quick_reply'; text: string }
  | { type: 'url'; text: string; url: string }
  | { type: 'phone'; text: string; phone: string };

export interface TemplateSpec {
  purpose: TemplatePurpose;
  header: { type: HeaderType; source?: HeaderSource; text?: string };
  body: string;
  footer?: string;
  buttons: ButtonDef[];
}

export const LIMITS = { name: 60, headerText: 60, body: 1024, footer: 60, buttonText: 25, buttons: 10, urlButtons: 2, phoneButtons: 1, url: 2000, param: 1024 } as const;

// ---------------------------------------------------------------------------------------------- variables

export interface VariableInfo { label: string; sample: string }
/** Variables TripOS can fill automatically. Agencies may also use their own names; those need a value at send time. */
export const VARIABLES: Record<string, VariableInfo> = {
  customer_name: { label: 'Customer name', sample: 'Rahul Shetty' },
  agency_name: { label: 'Agency name', sample: 'Golden Travels' },
  agency_phone: { label: 'Agency phone', sample: '+91 98450 12345' },
  agency_email: { label: 'Agency email', sample: 'hello@goldentravels.example' },
  agency_website: { label: 'Agency website', sample: 'goldentravels.example' },
  destination: { label: 'Destination', sample: 'Coorg' },
  pickup_location: { label: 'Pickup location', sample: 'Bangalore Airport' },
  travel_dates: { label: 'Travel dates', sample: '13 Oct 2026 – 16 Oct 2026' },
  passenger_count: { label: 'Guests', sample: '5' },
  vehicle_type: { label: 'Vehicle', sample: 'Innova Crysta' },
  quote_total: { label: 'Quotation amount', sample: '₹21,000.00' },
  quote_number: { label: 'Quotation number', sample: 'Q-0001' },
  quote_version: { label: 'Quotation version', sample: '1' },
  valid_until: { label: 'Valid until', sample: '19 Oct 2026' },
  quote_link: { label: 'Quotation link', sample: 'https://app.example.com/q/AbC123xyz' },
  quote_token: { label: 'Quotation link token (for URL buttons)', sample: 'AbC123xyz' },
};
export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,29}$/;
export const sampleFor = (name: string) => VARIABLES[name]?.sample ?? `Example ${name.replace(/_/g, ' ')}`;

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Unique variable names in order of first appearance. Invalid names are returned as-is so validation can report them. */
export function extractVariables(text: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(PLACEHOLDER)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------------------------- validation

export interface Issue { field: string; message: string }
export interface Validation { errors: Issue[]; warnings: Issue[] }

export function validateTemplate(t: { name: string; language: string; category: string; spec: TemplateSpec }): Validation {
  const errors: Issue[] = [], warnings: Issue[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  const warn = (field: string, message: string) => warnings.push({ field, message });
  const { spec } = t;

  if (!/^[a-z0-9_]{3,60}$/.test(t.name)) err('name', 'Use 3-60 lowercase letters, digits and underscores (no spaces).');
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(t.language)) err('language', 'Use a Meta language code such as en, en_US or hi.');
  if (!['UTILITY', 'MARKETING'].includes(t.category)) err('category', 'Choose Utility or Marketing. Authentication templates are not supported in this builder.');
  if (t.category === 'MARKETING') warn('category', 'Marketing messages are billed at a higher rate. Quotations and follow-ups about an existing enquiry usually qualify as Utility, but Meta decides the final category.');

  // header
  const h = spec.header;
  if (h.type === 'text') {
    if (!h.text?.trim()) err('header.text', 'Header text is required.');
    else {
      if (h.text.length > LIMITS.headerText) err('header.text', `Header text can be at most ${LIMITS.headerText} characters.`);
      const vars = extractVariables(h.text);
      if (vars.length > 1) err('header.text', 'A text header can contain only one variable.');
      vars.filter((v) => !VARIABLE_NAME.test(v)).forEach((v) => err('header.text', `"{{${v}}}" is not a valid variable name.`));
    }
  } else if (h.type === 'image') {
    if (!h.source || !['logo', 'vehicle_photo', 'custom'].includes(h.source)) err('header.source', 'Choose where the header image comes from: agency logo, vehicle photo or an uploaded image.');
  } else if (h.type === 'document') {
    if (h.source !== 'quote_pdf') err('header.source', 'A document header carries the generated quotation PDF.');
  }

  // body
  if (!spec.body?.trim()) err('body', 'Message body is required.');
  else {
    if (spec.body.length > LIMITS.body) err('body', `The body can be at most ${LIMITS.body} characters.`);
    extractVariables(spec.body).filter((v) => !VARIABLE_NAME.test(v)).forEach((v) => err('body', `"{{${v}}}" is not a valid variable name. Use lowercase letters, digits and underscores, starting with a letter.`));
    if (extractVariables(spec.body).length === 0 && /[{}]/.test(spec.body)) err('body', 'Unmatched braces: write variables as {{name}}.');
  }

  // footer
  if (spec.footer) {
    if (spec.footer.length > LIMITS.footer) err('footer', `The footer can be at most ${LIMITS.footer} characters.`);
    if (/[{}]/.test(spec.footer)) err('footer', 'Meta does not allow variables in the footer. Write the agency name and phone as plain text.');
  }

  // buttons
  const btns = spec.buttons ?? [];
  if (btns.length > LIMITS.buttons) err('buttons', `A template can have at most ${LIMITS.buttons} buttons.`);
  if (btns.filter((b) => b.type === 'url').length > LIMITS.urlButtons) err('buttons', `At most ${LIMITS.urlButtons} URL buttons are allowed.`);
  if (btns.filter((b) => b.type === 'phone').length > LIMITS.phoneButtons) err('buttons', 'Only one phone-number button is allowed.');
  const seen = new Set<string>();
  btns.forEach((b, i) => {
    const f = `buttons[${i}]`;
    if (!b.text?.trim()) err(f, 'Button text is required.');
    else if (b.text.length > LIMITS.buttonText) err(f, `Button text can be at most ${LIMITS.buttonText} characters.`);
    if (b.text && seen.has(b.text.trim().toLowerCase())) err(f, 'Button texts must be different from each other.');
    seen.add((b.text ?? '').trim().toLowerCase());
    if (b.type === 'url') {
      if (!/^https:\/\//i.test(b.url ?? '')) err(f, 'The button URL must start with https://.');
      else if (b.url.length > LIMITS.url) err(f, `The URL can be at most ${LIMITS.url} characters.`);
      const vars = extractVariables(b.url);
      if (vars.length > 1) err(f, 'A URL button can contain only one variable.');
      else if (vars.length === 1 && !new RegExp(`\\{\\{\\s*${vars[0]}\\s*\\}\\}$`).test(b.url)) err(f, 'The variable must be the very end of the URL, for example https://example.com/q/{{quote_token}}.');
      if (vars.length === 1 && !VARIABLE_NAME.test(vars[0])) err(f, `"{{${vars[0]}}}" is not a valid variable name.`);
    }
    if (b.type === 'phone' && !/^\+[1-9]\d{6,14}$/.test(b.phone ?? '')) err(f, 'Enter the phone number in international format, for example +919845012345.');
  });
  const kinds = btns.map((b) => (b.type === 'quick_reply' ? 'q' : 'c')).join('');
  if (/q.*c.*q|c.*q.*c/.test(kinds)) warn('buttons', 'Meta expects buttons of the same kind (quick replies vs call-to-action) to be grouped together; mixed ordering may be rejected.');

  // purpose-specific advice
  if ((spec.purpose === 'quotation' || spec.purpose === 'revised_quotation') && !extractVariables(spec.body).includes('quote_total')) warn('body', 'A quotation message normally shows {{quote_total}}.');
  return { errors, warnings };
}

// ---------------------------------------------------------------------------------------------- compilation

export interface CompiledButton { type: 'quick_reply' | 'url' | 'phone'; text: string; url?: string; urlVariable?: string; phone?: string }
export interface CompiledTemplate {
  /** Positional body ({{1}}, {{2}}) as Meta stores it. */
  body: string;
  /** Names in positional order: bodyVariables[0] fills {{1}}. */
  bodyVariables: string[];
  header: { type: HeaderType; source?: HeaderSource; text?: string; variable?: string };
  footer?: string;
  buttons: CompiledButton[];
}

function positional(text: string, names: string[]): string {
  return text.replace(PLACEHOLDER, (_m, n: string) => `{{${names.indexOf(n) + 1}}}`);
}

export function compile(spec: TemplateSpec): CompiledTemplate {
  const bodyVariables = extractVariables(spec.body);
  const headerVar = spec.header.type === 'text' ? extractVariables(spec.header.text)[0] : undefined;
  return {
    body: positional(spec.body, bodyVariables), bodyVariables,
    header: { type: spec.header.type, source: spec.header.source, text: spec.header.type === 'text' && spec.header.text ? positional(spec.header.text, headerVar ? [headerVar] : []) : undefined, variable: headerVar },
    footer: spec.footer?.trim() || undefined,
    buttons: (spec.buttons ?? []).map((b): CompiledButton => {
      if (b.type === 'url') {
        const v = extractVariables(b.url)[0];
        return { type: 'url', text: b.text.trim(), url: v ? b.url.replace(PLACEHOLDER, '{{1}}') : b.url, urlVariable: v };
      }
      return b.type === 'phone' ? { type: 'phone', text: b.text.trim(), phone: b.phone } : { type: 'quick_reply', text: b.text.trim() };
    }),
  };
}

/** Meta "components" for template creation. `headerHandle` is the uploaded example for image/document headers. */
export function toMetaComponents(c: CompiledTemplate, opts: { headerHandle?: string; sample?: (name: string) => string } = {}): Record<string, unknown>[] {
  const sample = opts.sample ?? sampleFor;
  const out: Record<string, unknown>[] = [];
  if (c.header.type === 'text' && c.header.text) {
    out.push({ type: 'HEADER', format: 'TEXT', text: c.header.text, ...(c.header.variable ? { example: { header_text: [sample(c.header.variable)] } } : {}) });
  } else if (c.header.type === 'image' || c.header.type === 'document') {
    if (!opts.headerHandle) throw new Error('A media header needs an uploaded example (header handle).');
    out.push({ type: 'HEADER', format: c.header.type === 'image' ? 'IMAGE' : 'DOCUMENT', example: { header_handle: [opts.headerHandle] } });
  }
  out.push({ type: 'BODY', text: c.body, ...(c.bodyVariables.length ? { example: { body_text: [c.bodyVariables.map(sample)] } } : {}) });
  if (c.footer) out.push({ type: 'FOOTER', text: c.footer });
  if (c.buttons.length) {
    out.push({
      type: 'BUTTONS',
      buttons: c.buttons.map((b) => b.type === 'url'
        ? { type: 'URL', text: b.text, url: b.url, ...(b.urlVariable ? { example: [b.url!.replace('{{1}}', sample(b.urlVariable))] } : {}) }
        : b.type === 'phone' ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone } : { type: 'QUICK_REPLY', text: b.text }),
    });
  }
  return out;
}

/** Positional Meta body + names, back to the readable form (used for legacy templates and imports). */
export function toNamedBody(positionalBody: string, names: string[]): string {
  return positionalBody.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => `{{${names[Number(n) - 1] ?? `variable_${n}`}}}`);
}

// ---------------------------------------------------------------------------------------------- values, preview, send parts

/** Meta rejects parameters with line breaks, tabs or long runs of spaces: make values safe. */
export function sanitizeParam(v: string): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ').trim().slice(0, LIMITS.param);
}

export interface PreviewButton { type: 'quick_reply' | 'url' | 'phone'; text: string; target?: string }
export interface Preview {
  header: { type: HeaderType; text?: string; source?: HeaderSource };
  body: string; footer?: string; buttons: PreviewButton[];
  /** Variables that have no real value (only relevant for a strict preview). */
  missing: string[];
}

const fill = (text: string, values: Record<string, string>, missing: Set<string>, useSamples: boolean) =>
  text.replace(PLACEHOLDER, (_m, n: string) => {
    const v = values[n];
    if (v !== undefined && v.trim() !== '') return sanitizeParam(v);
    if (useSamples) return sampleFor(n);
    missing.add(n);
    return `{{${n}}}`;
  });

/** `useSamples` fills any gap with the catalogue sample (builder preview); strict mode reports gaps in `missing`. */
export function renderPreview(spec: TemplateSpec, values: Record<string, string>, useSamples: boolean): Preview {
  const missing = new Set<string>();
  const f = (t: string) => fill(t, values, missing, useSamples);
  return {
    header: { type: spec.header.type, source: spec.header.source, text: spec.header.type === 'text' && spec.header.text ? f(spec.header.text) : undefined },
    body: f(spec.body), footer: spec.footer?.trim() || undefined,
    buttons: (spec.buttons ?? []).map((b): PreviewButton => b.type === 'url' ? { type: 'url', text: b.text, target: f(b.url) } : b.type === 'phone' ? { type: 'phone', text: b.text, target: b.phone } : { type: 'quick_reply', text: b.text }),
    missing: [...missing],
  };
}

/** Names of every variable the template needs a value for (header, body and URL button). */
export function requiredVariables(spec: TemplateSpec): string[] {
  const all = [...extractVariables(spec.header.type === 'text' ? spec.header.text : ''), ...extractVariables(spec.body), ...(spec.buttons ?? []).flatMap((b) => (b.type === 'url' ? extractVariables(b.url) : []))];
  return [...new Set(all)];
}

export interface SendParts { bodyParams: string[]; headerText?: string; buttons: { index: number; kind: 'url'; value: string }[] }
/** Strict: returns the values in positional order, or the list of variables that are missing/empty. */
export function buildSendParts(c: CompiledTemplate, values: Record<string, string>): { parts?: SendParts; missing: string[] } {
  const get = (n: string) => (values[n] !== undefined ? sanitizeParam(values[n]) : '');
  const missing = [...new Set([...(c.header.variable ? [c.header.variable] : []), ...c.bodyVariables, ...c.buttons.flatMap((b) => (b.urlVariable ? [b.urlVariable] : []))].filter((n) => !get(n)))];
  if (missing.length) return { missing };
  return {
    missing: [],
    parts: {
      bodyParams: c.bodyVariables.map(get),
      headerText: c.header.variable ? get(c.header.variable) : undefined,
      buttons: c.buttons.flatMap((b, index) => (b.type === 'url' && b.urlVariable ? [{ index, kind: 'url' as const, value: get(b.urlVariable) }] : [])),
    },
  };
}

// ---------------------------------------------------------------------------------------------- value resolution from business data

export interface ValueContext {
  customerName: string;
  agency: { name: string; phone?: string | null; email?: string | null; website?: string | null };
  timezone: string;
  publicBaseUrl: string;
  quote?: {
    number: string; version: number; total: string; destinations: string[]; pickupLocation?: string; pickupAt?: string; returnAt?: string | null;
    passengers?: number; vehicleName: string; validUntil?: Date | null; publicToken?: string | null;
  };
}

const day = (d: string | Date, tz: string) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d));
export const formatInr = (v: string | number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(Number(v));

export function resolveValues(ctx: ValueContext): Record<string, string> {
  const v: Record<string, string> = { customer_name: ctx.customerName, agency_name: ctx.agency.name };
  if (ctx.agency.phone) v.agency_phone = ctx.agency.phone;
  if (ctx.agency.email) v.agency_email = ctx.agency.email;
  if (ctx.agency.website) v.agency_website = ctx.agency.website;
  const q = ctx.quote;
  if (q) {
    v.quote_number = q.number; v.quote_version = String(q.version); v.quote_total = formatInr(q.total); v.vehicle_type = q.vehicleName;
    if (q.destinations.length) v.destination = q.destinations.join(', ');
    if (q.pickupLocation) v.pickup_location = q.pickupLocation;
    if (q.passengers) v.passenger_count = String(q.passengers);
    if (q.pickupAt) v.travel_dates = q.returnAt && day(q.returnAt, ctx.timezone) !== day(q.pickupAt, ctx.timezone) ? `${day(q.pickupAt, ctx.timezone)} – ${day(q.returnAt, ctx.timezone)}` : day(q.pickupAt, ctx.timezone);
    if (q.validUntil) v.valid_until = day(q.validUntil, ctx.timezone);
    if (q.publicToken) { v.quote_token = q.publicToken; v.quote_link = `${ctx.publicBaseUrl.replace(/\/$/, '')}/q/${q.publicToken}`; }
  }
  return v;
}
