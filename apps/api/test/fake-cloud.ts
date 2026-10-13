import {
  parseCloudPayload, WaAccount, WaPhoneInfo, WaRemoteTemplate, WaSendError, WaSendResult, WhatsAppProvider,
} from '../src/providers/whatsapp/whatsapp';

/**
 * Stand-in for the Meta Cloud API with the provider's real shape, so "cloud mode" code paths run offline.
 * `sendError` makes every send fail with that error until cleared; `delivered` lists what was actually accepted.
 */
export class FakeCloud implements WhatsAppProvider {
  readonly name = 'cloud' as const;
  readonly simulated = false;
  phoneInfo: WaPhoneInfo = { displayPhoneNumber: '+91 98000 00000', verifiedName: 'Test Travels', displayNameStatus: 'APPROVED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', status: 'CONNECTED' };
  infoError?: WaSendError;
  sendError?: WaSendError;
  templates: WaRemoteTemplate[] = [];
  /** Every provider call attempted, in order (including ones that failed). */
  attempted: string[] = [];
  /** Only the sends the "provider" accepted. */
  delivered: string[] = [];
  private n = 0;

  private send(kind: string): WaSendResult {
    this.attempted.push(kind);
    if (this.sendError) throw this.sendError;
    this.delivered.push(kind);
    return { providerMessageId: `wamid.fake.${++this.n}`, simulated: false };
  }
  async sendText() { return this.send('text'); }
  async sendDocument() { return this.send('document'); }
  async sendImage() { return this.send('image'); }
  async sendTemplate() { return this.send('template'); }
  async downloadMedia() { return { data: Buffer.from('x'), mimeType: 'image/png' }; }
  verifySignature() { return true; }
  parseWebhook(b: any) { return parseCloudPayload(b); }
  async getPhoneInfo(_a: WaAccount) { if (this.infoError) throw this.infoError; return this.phoneInfo; }
  async subscribeWebhooks() { /* ok */ }
  async listTemplates() { return this.templates; }
  async submitTemplate(_a: WaAccount, t: { name: string }) { return { providerTemplateId: `meta-${t.name}`, status: 'PENDING' }; }

  count(list: 'attempted' | 'delivered', kind: string) { return this[list].filter((k) => k === kind).length; }
}

export const authError = () => new WaSendError('Error validating access token: Session has expired', '190', false, 'auth');
export const rateLimitError = () => new WaSendError('Throughput limit reached', '130429', true, 'rate_limit');
