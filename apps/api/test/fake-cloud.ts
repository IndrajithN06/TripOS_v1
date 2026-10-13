import {
  parseCloudPayload, TemplateSend, WaAccount, WaPhoneInfo, WaRemoteTemplate, WaSendError, WaSendResult, WhatsAppProvider,
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
  /** Full parameters of every template send attempted (header media, body values, button values). */
  templateSends: TemplateSend[] = [];
  /** What was submitted to "Meta" for review, and the header example uploads. */
  submissions: { name: string; language: string; category: string; components: Record<string, unknown>[] }[] = [];
  uploads: { mimeType: string; filename: string; bytes: number }[] = [];
  submitError?: WaSendError;
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
  async sendTemplate(_a: WaAccount, _to: string, t: TemplateSend) { this.templateSends.push(t); return this.send('template'); }
  async downloadMedia() { return { data: Buffer.from('x'), mimeType: 'image/png' }; }
  verifySignature() { return true; }
  parseWebhook(b: any) { return parseCloudPayload(b); }
  async getPhoneInfo(_a: WaAccount) { if (this.infoError) throw this.infoError; return this.phoneInfo; }
  async subscribeWebhooks() { /* ok */ }
  async listTemplates() { return this.templates; }
  async submitTemplate(_a: WaAccount, t: { name: string; language: string; category: string; components: Record<string, unknown>[] }) {
    if (this.submitError) throw this.submitError;
    this.submissions.push(t);
    return { providerTemplateId: `meta-${t.name}`, status: 'PENDING' };
  }
  async uploadTemplateExample(_a: WaAccount, f: { data: Buffer; mimeType: string; filename: string }) {
    this.uploads.push({ mimeType: f.mimeType, filename: f.filename, bytes: f.data.length });
    return `4::handle-${this.uploads.length}`;
  }

  count(list: 'attempted' | 'delivered', kind: string) { return this[list].filter((k) => k === kind).length; }
}

export const authError = () => new WaSendError('Error validating access token: Session has expired', '190', false, 'auth');
export const rateLimitError = () => new WaSendError('Throughput limit reached', '130429', true, 'rate_limit');
