import { AppKey } from '../src/providers/whatsapp/app-identity';
import { verifyMetaSignature } from '../src/providers/whatsapp/signature';
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
  verifySignature(_raw?: Buffer, _header?: string, _app?: string): boolean { return true; }
  parseWebhook(b: any) { return parseCloudPayload(b); }
  async getPhoneInfo(_a: WaAccount) { if (this.infoError) throw this.infoError; return this.phoneInfo; }
  async subscribeWebhooks(a?: WaAccount) { this.attempted.push('subscribe'); if (this.subscribeError) throw this.subscribeError; this.subscribed.push(a?.wabaId ?? ''); }
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

  // ---- Embedded Signup / coexistence: scripted, offline, never touches Meta ----
  /** Authorization codes Meta would accept. Single use, like the real ones. */
  codes = new Map<string, { wabaId: string; phoneNumberId: string; isOnBizApp?: boolean; extraPhones?: string[] }>();
  tokens = new Map<string, { wabaId: string; phoneNumberId: string; isOnBizApp: boolean; extraPhones: string[] }>();
  exchangeError?: WaSendError; listError?: WaSendError; coexError?: WaSendError; subscribeError?: WaSendError; syncError?: WaSendError;
  exchanged: string[] = [];
  subscribed: string[] = [];
  syncs: { phoneNumberId: string; syncType: string }[] = [];
  async exchangeSignupCode(code: string) {
    this.attempted.push('exchange');
    if (this.exchangeError) throw this.exchangeError;
    const f = this.codes.get(code);
    if (!f) throw new WaSendError('Invalid verification code format.', '100', false, 'auth');
    this.codes.delete(code);
    this.exchanged.push(code);
    const accessToken = `EAAG-business-${code}`;
    this.tokens.set(accessToken, { wabaId: f.wabaId, phoneNumberId: f.phoneNumberId, isOnBizApp: f.isOnBizApp ?? true, extraPhones: f.extraPhones ?? [] });
    return { accessToken };
  }
  private access(a: WaAccount) {
    const f = a.token ? this.tokens.get(a.token) : undefined;
    if (!f) throw new WaSendError('Invalid OAuth access token', '190', false, 'auth');
    return f;
  }
  async listWabaPhoneNumbers(a: WaAccount) {
    this.attempted.push('list-phones');
    if (this.listError) throw this.listError;
    const f = this.access(a);
    if (a.wabaId !== f.wabaId) throw new WaSendError('(#100) Object does not exist or you lack permission', '100', false, 'account');
    return [f.phoneNumberId, ...f.extraPhones].map((id) => ({ id, displayPhoneNumber: '+91 98000 00000', verifiedName: 'Golden Travels' }));
  }
  async getCoexistenceInfo(a: WaAccount) {
    this.attempted.push('coexistence-info');
    if (this.coexError) throw this.coexError;
    return { isOnBizApp: this.access(a).isOnBizApp, platformType: 'CLOUD_API' };
  }
  async requestSmbSync(a: WaAccount, syncType: 'smb_app_state_sync' | 'history') {
    this.attempted.push(`sync:${syncType}`);
    if (this.syncError) throw this.syncError;
    this.syncs.push({ phoneNumberId: a.phoneNumberId, syncType });
  }

  count(list: 'attempted' | 'delivered', kind: string) { return this[list].filter((k) => k === kind).length; }
}

export const authError = () => new WaSendError('Error validating access token: Session has expired', '190', false, 'auth');
export const rateLimitError = () => new WaSendError('Throughput limit reached', '130429', true, 'rate_limit');

/**
 * Same fake Meta, but webhook signatures are REALLY verified (HMAC-SHA256 of the raw body) against the secret of the app the
 * route belongs to. Reads the secrets from the environment at call time, exactly like the production provider's config does.
 */
export class SignedFakeCloud extends FakeCloud {
  verifySignature(raw?: Buffer, header?: string, app: AppKey | string = 'primary'): boolean {
    return verifyMetaSignature(raw ?? Buffer.from(''), header, app === 'signup' ? process.env.WHATSAPP_SIGNUP_APP_SECRET : process.env.WHATSAPP_APP_SECRET);
  }
}
