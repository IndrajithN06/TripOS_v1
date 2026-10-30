/**
 * Five built-in TripOS message starters. Shared code, identical for every agency: they are wording suggestions an agent fills,
 * edits and sends as an ordinary free-form message inside the 24-hour window. They are NOT WhatsApp (Meta) templates, are never
 * submitted to Meta, and are never treated as approved. Outside the window only an approved Meta template may be sent.
 *
 * Placeholders are {{name}}. Pure: no I/O.
 */
export interface StarterField { name: string; label: string }
export interface StarterDef { key: string; label: string; description: string; body: string }

export const STARTER_FIELDS: Record<string, StarterField> = {
  customer_name: { name: 'customer_name', label: 'Customer name' },
  agency_name: { name: 'agency_name', label: 'Agency name' },
  quote_number: { name: 'quote_number', label: 'Quotation number' },
  quote_total: { name: 'quote_total', label: 'Quotation amount' },
  destination: { name: 'destination', label: 'Destination' },
  travel_dates: { name: 'travel_dates', label: 'Travel dates' },
  duration: { name: 'duration', label: 'Duration' },
  pickup_location: { name: 'pickup_location', label: 'Pickup location' },
  booking_reference: { name: 'booking_reference', label: 'Booking reference' },
  departure_date: { name: 'departure_date', label: 'Departure date' },
  amount_due: { name: 'amount_due', label: 'Amount due' },
};

/** Fields TripOS can fill from reliable V1 data (the customer, the agency and the conversation's latest quotation). Everything else is typed by the agent. */
export const AUTO_FIELDS = ['customer_name', 'agency_name', 'quote_number', 'quote_total', 'destination', 'travel_dates', 'duration', 'pickup_location'] as const;

export const STARTERS: StarterDef[] = [
  {
    key: 'quotation_ready', label: 'Quotation Ready', description: 'Tell the customer their quotation is ready.',
    body: 'Hi {{customer_name}}, your quotation {{quote_number}} for {{destination}} ({{travel_dates}}, {{duration}}) is ready. The total is {{quote_total}}. Please let us know if you would like any changes. - {{agency_name}}',
  },
  {
    key: 'quote_followup', label: 'Quote Follow-up', description: 'A polite nudge about a quotation already sent.',
    body: 'Hi {{customer_name}}, just checking in on quotation {{quote_number}} for {{destination}}. Do you have any questions, or would you like us to adjust anything? - {{agency_name}}',
  },
  {
    key: 'booking_confirmation', label: 'Booking Confirmation', description: 'Confirm a booking. The booking reference and departure date are entered by you.',
    body: 'Hi {{customer_name}}, your booking {{booking_reference}} for {{destination}} is confirmed. Departure: {{departure_date}} from {{pickup_location}}. Thank you for choosing {{agency_name}}.',
  },
  {
    key: 'payment_reminder', label: 'Payment Reminder', description: 'Remind about a payment. The reference and amount are entered by you.',
    body: 'Hi {{customer_name}}, a gentle reminder that {{amount_due}} is due for booking {{booking_reference}}. Please let us know once it is done or if you need any help. - {{agency_name}}',
  },
  {
    key: 'upcoming_trip_reminder', label: 'Upcoming Trip Reminder', description: 'Remind the customer about an upcoming trip. The departure date is entered by you.',
    body: 'Hi {{customer_name}}, a reminder that your trip to {{destination}} departs on {{departure_date}} from {{pickup_location}}. Please be ready a few minutes early. Safe travels! - {{agency_name}}',
  },
];

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
export const MAX_VALUE_LENGTH = 200;

export const getStarter = (key: string) => STARTERS.find((s) => s.key === key);

/** Placeholder names in order of first appearance. */
export function placeholdersOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** A value is a single line of plain text: control characters and braces are removed, whitespace collapsed, length capped. */
export function cleanValue(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE_LENGTH);
}

export interface RenderedStarter { text: string; missing: string[] }

/**
 * Fills the placeholders in one pass (a value is never re-scanned, so a value cannot inject another placeholder).
 * A placeholder with no usable value is left visible as {{name}} and listed in `missing`: nothing is ever filled with a guess.
 */
export function renderStarter(def: StarterDef, values: Record<string, unknown>): RenderedStarter {
  const missing: string[] = [];
  const text = def.body.replace(PLACEHOLDER, (whole, name: string) => {
    const v = cleanValue(values[name]);
    if (v) return v;
    if (!missing.includes(name)) missing.push(name);
    return `{{${name}}}`;
  });
  return { text, missing };
}

/** True if the text still contains an unfilled starter placeholder. */
export const hasUnfilledPlaceholder = (text: string) => new RegExp(PLACEHOLDER.source).test(text);
