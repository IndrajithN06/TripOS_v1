import { composerState, enteredValues, hasUnfilledPlaceholder, unfilledPlaceholders } from './starter-send';

const closed = { code: 'window_closed' as const, message: 'The 24-hour customer service window has closed.' };
const disconnected = { code: 'whatsapp_not_connected' as const, message: 'WhatsApp is disconnected: token revoked.' };

describe('unfilled starter placeholders', () => {
  it('detects them, including spaced and repeated ones', () => {
    expect(hasUnfilledPlaceholder('Hi {{customer_name}}')).toBe(true);
    expect(hasUnfilledPlaceholder('Hi {{ amount_due }}')).toBe(true);
    expect(unfilledPlaceholders('{{a}} and {{b_2}} and {{a}}')).toEqual(['a', 'b_2']);
  });
  it('ignores ordinary text, single braces and non-placeholder braces', () => {
    for (const t of ['Hello', '{x}', '{{ 1 }}', '{{Capital}}', 'price {₹5}', '']) expect(hasUnfilledPlaceholder(t)).toBe(false);
  });
});

describe('composerState', () => {
  it('lets the agent type and send inside the window', () => {
    expect(composerState({ sendBlock: null, text: 'Hello', sending: false })).toEqual({ canType: true, canSend: true, notice: null, suggestMetaTemplate: false });
  });
  it('does not send an empty or whitespace message, or while a send is in flight', () => {
    expect(composerState({ sendBlock: null, text: '  ', sending: false }).canSend).toBe(false);
    expect(composerState({ sendBlock: null, text: 'Hello', sending: true }).canSend).toBe(false);
  });
  it('blocks typing outside the window, explains why, and points to approved templates', () => {
    const s = composerState({ sendBlock: closed, text: 'draft', sending: false });
    expect(s).toMatchObject({ canType: false, canSend: false, notice: closed.message, suggestMetaTemplate: true });
  });
  it('blocks typing for a disconnected account, explains why, and does not suggest templates (they cannot be sent either)', () => {
    const s = composerState({ sendBlock: disconnected, text: 'x', sending: false });
    expect(s).toMatchObject({ canType: false, canSend: false, notice: disconnected.message, suggestMetaTemplate: false });
  });
  it('refuses to send while a starter placeholder is unfilled, and names it', () => {
    const s = composerState({ sendBlock: null, text: 'Hi Asha, {{amount_due}} is due for {{booking_reference}}', sending: false });
    expect(s.canType).toBe(true);
    expect(s.canSend).toBe(false);
    expect(s.notice).toBe('Fill in {{amount_due}}, {{booking_reference}} before sending.');
  });
  it('allows sending once the placeholders are filled in', () => {
    expect(composerState({ sendBlock: null, text: 'Hi Asha, ₹5,000 is due for BK-9', sending: false }).canSend).toBe(true);
  });
});

describe('enteredValues', () => {
  it('keeps only what the agent typed', () => {
    expect(enteredValues({ amount_due: '₹5,000', booking_reference: '  ', destination: '' })).toEqual({ amount_due: '₹5,000' });
  });
});
