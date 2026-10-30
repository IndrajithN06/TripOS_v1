import { notConnectedMessage, SERVICE_WINDOW_MS, textSendBlock, windowClosedMessage, windowState } from './service-window';

const NOW = Date.parse('2030-03-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms);
const H = 3_600_000;
const connected = { connectionStatus: 'connected' };

describe('windowState: the 24-hour customer-service window', () => {
  it('is 24 hours long', () => expect(SERVICE_WINDOW_MS).toBe(24 * H));

  it.each([
    ['just now', 0, true],
    ['1 minute ago', 60_000, true],
    ['23 hours 59 minutes 59.999 seconds ago', 24 * H - 1, true],
    ['exactly 24 hours ago (closed: the window is strictly shorter than 24 hours)', 24 * H, false],
    ['24 hours and 1 ms ago', 24 * H + 1, false],
    ['3 days ago', 72 * H, false],
  ])('last inbound %s -> open=%s', (_l, ms, open) => {
    expect(windowState(ago(ms as number), NOW).open).toBe(open);
  });

  it('never open when the customer has not messaged yet, and has no expiry', () => {
    expect(windowState(null, NOW)).toEqual({ open: false, expiresAt: null });
    expect(windowState(undefined, NOW)).toEqual({ open: false, expiresAt: null });
  });

  it('expires 24 hours after the last inbound message, and a newer inbound message re-opens it', () => {
    const old = ago(30 * H);
    expect(windowState(old, NOW).open).toBe(false);
    expect(windowState(old, NOW).expiresAt?.toISOString()).toBe(new Date(old.getTime() + 24 * H).toISOString());
    const refreshed = ago(5 * 60_000);
    expect(windowState(refreshed, NOW).open).toBe(true);
    expect(windowState(refreshed, NOW).expiresAt?.getTime()).toBe(NOW - 5 * 60_000 + 24 * H);
  });
});

describe('textSendBlock: when a free-form text cannot be sent', () => {
  it('allows a text inside the window on a connected account', () => {
    expect(textSendBlock({ lastInboundAt: ago(H) }, connected, NOW)).toBeNull();
    // Degraded and still-connecting accounts are not blocked here; only a disconnected one is (matches the send path).
    expect(textSendBlock({ lastInboundAt: ago(H) }, { connectionStatus: 'degraded' }, NOW)).toBeNull();
  });

  it('blocks with window_closed outside the window, explaining the template-only rule', () => {
    const b = textSendBlock({ lastInboundAt: ago(25 * H) }, connected, NOW)!;
    expect(b.code).toBe('window_closed');
    expect(b.message).toMatch(/approved template/i);
    expect(b.message).toMatch(/customer replies/i);
  });

  it('blocks with window_closed, and a different explanation, when the customer never messaged', () => {
    const b = textSendBlock({ lastInboundAt: null }, connected, NOW)!;
    expect(b.code).toBe('window_closed');
    expect(b.message).toMatch(/has not messaged you yet/i);
    expect(b.message).not.toBe(windowClosedMessage({ open: false, expiresAt: new Date() }));
  });

  it('reports a disconnected account before a closed window, naming the reason', () => {
    const b = textSendBlock({ lastInboundAt: ago(30 * H) }, { connectionStatus: 'disconnected', statusReason: 'Disconnected by an administrator' }, NOW)!;
    expect(b.code).toBe('whatsapp_not_connected');
    expect(b.message).toContain('Disconnected by an administrator');
    expect(b.message).toMatch(/reconnect/i);
  });

  it('blocks when no account exists at all', () => {
    const b = textSendBlock({ lastInboundAt: ago(H) }, null, NOW)!;
    expect(b.code).toBe('whatsapp_not_connected');
    expect(b.message).toMatch(/No WhatsApp number is connected/);
  });

  it('a disconnected message without a stored reason has no dangling punctuation', () => {
    expect(notConnectedMessage({ connectionStatus: 'disconnected' })).toMatch(/^WhatsApp is disconnected\. /);
    expect(notConnectedMessage({ connectionStatus: 'disconnected', statusReason: '   ' })).toMatch(/^WhatsApp is disconnected\. /);
  });
});
