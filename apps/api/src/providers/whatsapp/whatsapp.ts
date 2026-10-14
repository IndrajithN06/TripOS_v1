import { createHmac } from 'crypto';
import { config } from '../../config/config';
import { safeEqual } from '../../common/crypto';
import { classifyMetaError, WaErrorKind } from './meta-errors';

export interface WaAccount {
  phoneNumberId: string;
  /** WhatsApp Business Account ID (needed for templates and webhook subscription). */
  wabaId?: string;
  /** Decrypted access token (cloud only). */
  token?: string;
}

export interface WaSendResult { providerMessageId: string; simulated: boolean }

/** Health snapshot of a connected phone number, as reported by the provider. */
export interface WaPhoneInfo {
  displayPhoneNumber?: string;
  verifiedName?: string;
  displayNameStatus?: string;
  qualityRating?: string;
  messagingLimitTier?: string;
  status?: string;
}

export interface WaRemoteTemplate { providerTemplateId: string; name: string; language: string; category: string; status: string; body: string; rejectedReason?: string }

export type WaEvent =
  | { kind: 'message'; phoneNumberId: string; providerMessageId: string; from: string; name?: string; type: string; text?: string; mediaId?: string; mimeType?: string; timestamp: Date }
  | { kind: 'status'; phoneNumberId: string; providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; errorCode?: string; errorMessage?: string; timestamp: Date }
  | { kind: 'template'; wabaId: string; providerTemplateId: string; name?: string; language?: string; event: string; reason?: string; timestamp: Date }
  | { kind: 'account'; wabaId?: string; phoneNumberId?: string; event: string; detail?: string; timestamp: Date; disconnectionReason?: string; initiatedBy?: string }
  /** WhatsApp Business app coexistence: a message the business sent from the app (`smb_message_echoes`). */
  | { kind: 'echo'; phoneNumberId: string; providerMessageId: string; to: string; type: string; text?: string; action?: 'edit' | 'revoke'; timestamp: Date }
  /** WhatsApp Business app coexistence: one chunk of imported chat history (`history`), or the business declining to share it. */
  | { kind: 'history'; phoneNumberId: string; phase?: number; chunkOrder?: number; progress?: number; declined?: { code: string; message?: string }; messages: WaHistoryMessage[] }
  /** WhatsApp Business app coexistence: contact changes made in the app (`smb_app_state_sync`). */
  | { kind: 'contacts'; phoneNumberId: string; items: { action: 'add' | 'remove'; phone: string; fullName?: string; timestamp: Date }[] };

export interface WaHistoryMessage { providerMessageId: string; customerPhone: string; direction: 'inbound' | 'outbound'; type: string; text?: string; status?: string; timestamp: Date }

/** Result of exchanging an Embedded Signup authorization code. The token is a secret: never log or return it. */
export interface WaExchangedToken { accessToken: string }
/** A phone number under a WABA, as listed by Meta. */
export interface WaWabaPhone { id: string; displayPhoneNumber?: string; verifiedName?: string }
/** Whether a number is linked to the WhatsApp Business app and Cloud API at once (coexistence). */
export interface WaCoexistenceInfo { isOnBizApp: boolean; platformType?: string }

export class WaSendError extends Error {
  constructor(message: string, readonly code = 'send_failed', readonly retryable = true, readonly kind: WaErrorKind = 'unknown') { super(message); }
}

/** Business logic only ever talks to this interface, never to provider SDKs. */
export interface WhatsAppProvider {
  readonly name: 'simulator' | 'cloud';
  readonly simulated: boolean;
  sendText(a: WaAccount, to: string, text: string): Promise<WaSendResult>;
  sendDocument(a: WaAccount, to: string, f: { filename: string; data: Buffer; mimeType: string; caption?: string }): Promise<WaSendResult>;
  sendImage(a: WaAccount, to: string, f: { data: Buffer; mimeType: string; caption?: string }): Promise<WaSendResult>;
  sendTemplate(a: WaAccount, to: string, t: TemplateSend): Promise<WaSendResult>;
  downloadMedia(a: WaAccount, mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parseWebhook(body: any): WaEvent[];
  /** Validates the credentials and returns the number's health. Throws WaSendError(kind 'auth') on a bad token. */
  getPhoneInfo(a: WaAccount): Promise<WaPhoneInfo>;
  /** Subscribes the platform app to this WABA's webhooks. Idempotent. */
  subscribeWebhooks(a: WaAccount): Promise<void>;
  listTemplates(a: WaAccount): Promise<WaRemoteTemplate[]>;
  /** Submits a template for review with its full component definition; returns the provider's id and initial status. */
  submitTemplate(a: WaAccount, t: { name: string; language: string; category: string; components: Record<string, unknown>[] }): Promise<{ providerTemplateId: string; status: string }>;
  /** Uploads an example file for an image/document template header; returns the handle to put in the template definition. */
  uploadTemplateExample(a: WaAccount, f: { data: Buffer; mimeType: string; filename: string }): Promise<string>;

  // ---- Embedded Signup v4 / coexistence (server-side only) ----
  /** Exchanges the one-time authorization code (valid ~30 s) for the customer's business token, using the app secret. */
  exchangeSignupCode(code: string): Promise<WaExchangedToken>;
  /** Phone numbers of a WABA visible to the token. Succeeding is evidence the token really has access to that WABA. */
  listWabaPhoneNumbers(a: WaAccount): Promise<WaWabaPhone[]>;
  /** Reads `is_on_biz_app` / `platform_type` for the number. */
  getCoexistenceInfo(a: WaAccount): Promise<WaCoexistenceInfo>;
  /** Asks Meta to start sending contacts (`smb_app_state_sync`) or chat history (`history`) for a coexistence number. */
  requestSmbSync(a: WaAccount, syncType: 'smb_app_state_sync' | 'history'): Promise<void>;
}

/** Everything needed to send one template message, in the provider-neutral form TripOS uses. */
export interface TemplateSend {
  name: string;
  language: string;
  /** Body parameters in positional order. */
  variables: string[];
  /** Value for the single variable of a text header. */
  headerText?: string;
  /** Media for an image/document header on this send. */
  header?: { kind: 'image' | 'document'; data: Buffer; mimeType: string; filename?: string };
  /** Values for dynamic URL buttons (the part appended to the template's base URL). */
  buttons?: { index: number; kind: 'url'; value: string }[];
}

export const WHATSAPP = Symbol('WHATSAPP');

// ----------------------------------------------------------------------------------------------
// Simulator (development only). Every message it "sends" is flagged simulated=true in the database
// and labelled in the UI. Nothing leaves this machine.
// ----------------------------------------------------------------------------------------------
export class SimulatorWhatsApp implements WhatsAppProvider {
  readonly name = 'simulator' as const;
  readonly simulated = true;
  /** Failure injection: number of upcoming sends of each kind that should fail. */
  readonly failNext = { text: 0, document: 0, image: 0, template: 0 };
  readonly sent: { to: string; kind: string; at: Date; providerMessageId: string }[] = [];
  private seq = 0;

  private take(kind: keyof SimulatorWhatsApp['failNext']) {
    if (this.failNext[kind] > 0) {
      this.failNext[kind]--;
      throw new WaSendError(`[simulated] ${kind} delivery failure`, 'sim_failure');
    }
  }
  private ok(to: string, kind: string): WaSendResult {
    const providerMessageId = `sim.${Date.now().toString(36)}.${++this.seq}`;
    this.sent.push({ to, kind, at: new Date(), providerMessageId });
    return { providerMessageId, simulated: true };
  }
  async sendText(_a: WaAccount, to: string) { this.take('text'); return this.ok(to, 'text'); }
  async sendDocument(_a: WaAccount, to: string) { this.take('document'); return this.ok(to, 'document'); }
  async sendImage(_a: WaAccount, to: string) { this.take('image'); return this.ok(to, 'image'); }
  async sendTemplate(_a: WaAccount, to: string) { this.take('template'); return this.ok(to, 'template'); }
  async downloadMedia(): Promise<{ data: Buffer; mimeType: string }> {
    // 1x1 transparent PNG
    return { mimeType: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') };
  }
  verifySignature() { return true; } // simulator events are injected by trusted dev endpoints
  parseWebhook(body: any): WaEvent[] { return parseCloudPayload(body); }
  async getPhoneInfo(): Promise<WaPhoneInfo> {
    return { displayPhoneNumber: '+00 00000 00000 (simulated)', verifiedName: 'Simulated line', displayNameStatus: 'APPROVED', qualityRating: 'GREEN', messagingLimitTier: 'SIMULATED', status: 'CONNECTED' };
  }
  async subscribeWebhooks() { /* nothing to subscribe in the simulator */ }
  /** Templates "created in Meta's manager" for sync testing. */
  readonly remoteTemplates: WaRemoteTemplate[] = [];
  async listTemplates() { return this.remoteTemplates; }
  async submitTemplate(_a: WaAccount, t: { name: string; language: string; category: string; components: Record<string, unknown>[] }) {
    const providerTemplateId = `sim-tpl-${t.name}-${t.language}`;
    return { providerTemplateId, status: 'PENDING' };
  }
  async uploadTemplateExample(_a: WaAccount, f: { filename: string }) { return `sim-handle-${f.filename}`; }

  // ---- Embedded Signup simulation: codes are registered by tests/dev tools; each is single use, like Meta's ----
  readonly signupFixtures = new Map<string, { wabaId: string; phoneNumberId: string; displayPhoneNumber?: string; isOnBizApp: boolean }>();
  private readonly signupTokens = new Map<string, { wabaId: string; phoneNumberId: string; displayPhoneNumber?: string; isOnBizApp: boolean }>();
  readonly syncRequests: { phoneNumberId: string; syncType: string }[] = [];
  async exchangeSignupCode(code: string): Promise<WaExchangedToken> {
    const f = this.signupFixtures.get(code);
    if (!f) throw new WaSendError('[simulated] the authorization code is invalid, expired or already used', 'code_invalid', false, 'auth');
    this.signupFixtures.delete(code);
    const accessToken = `sim-token-${code}`;
    this.signupTokens.set(accessToken, f);
    return { accessToken };
  }
  private fixtureFor(a: WaAccount) {
    const f = a.token ? this.signupTokens.get(a.token) : undefined;
    if (!f) throw new WaSendError('[simulated] the token has no access to this account', '190', false, 'auth');
    return f;
  }
  async listWabaPhoneNumbers(a: WaAccount): Promise<WaWabaPhone[]> {
    const f = this.fixtureFor(a);
    if (a.wabaId !== f.wabaId) throw new WaSendError('[simulated] the token has no access to this WABA', '100', false, 'account');
    return [{ id: f.phoneNumberId, displayPhoneNumber: f.displayPhoneNumber, verifiedName: 'Simulated line' }];
  }
  async getCoexistenceInfo(a: WaAccount): Promise<WaCoexistenceInfo> { const f = this.fixtureFor(a); return { isOnBizApp: f.isOnBizApp, platformType: 'CLOUD_API' }; }
  async requestSmbSync(a: WaAccount, syncType: 'smb_app_state_sync' | 'history') { this.syncRequests.push({ phoneNumberId: a.phoneNumberId, syncType }); }
}

// ----------------------------------------------------------------------------------------------
// Meta WhatsApp Business Platform Cloud API (production). Not verifiable without live credentials.
// ----------------------------------------------------------------------------------------------
export class CloudWhatsApp implements WhatsAppProvider {
  readonly name = 'cloud' as const;
  readonly simulated = false;
  private readonly base = config().WHATSAPP_API_BASE_URL;

  /** Any Graph API request. `path` is relative to the versioned base, or an absolute URL (paging links). */
  private async graph(a: WaAccount, path: string, init: RequestInit = {}) {
    if (!a.token) throw new WaSendError('WhatsApp account has no credential configured', 'no_credential', false, 'auth');
    let res: Response;
    try {
      res = await fetch(path.startsWith('http') ? path : `${this.base}/${path}`, {
        ...init, headers: { Authorization: `Bearer ${a.token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new WaSendError(`Could not reach WhatsApp: ${(e as Error).message}`, 'network', true, 'transient');
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const c = classifyMetaError(res.status, json?.error?.code, json?.error?.message);
      throw new WaSendError(json?.error?.message ?? `WhatsApp API error ${res.status}`, String(json?.error?.code ?? res.status), c.retryable, c.kind);
    }
    return json;
  }
  private call(a: WaAccount, pathSuffix: string, init: RequestInit) { return this.graph(a, `${a.phoneNumberId}/${pathSuffix}`, init); }
  private json(a: WaAccount, to: string, payload: object): Promise<WaSendResult> {
    return this.call(a, 'messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace('+', ''), ...payload }),
    }).then((j) => ({ providerMessageId: j.messages?.[0]?.id as string, simulated: false }));
  }
  private async upload(a: WaAccount, data: Buffer, mimeType: string, filename: string) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    const j = await this.call(a, 'media', { method: 'POST', body: form });
    return j.id as string;
  }
  sendText(a: WaAccount, to: string, text: string) { return this.json(a, to, { type: 'text', text: { body: text, preview_url: false } }); }
  async sendDocument(a: WaAccount, to: string, f: { filename: string; data: Buffer; mimeType: string; caption?: string }) {
    const id = await this.upload(a, f.data, f.mimeType, f.filename);
    return this.json(a, to, { type: 'document', document: { id, filename: f.filename, caption: f.caption } });
  }
  async sendImage(a: WaAccount, to: string, f: { data: Buffer; mimeType: string; caption?: string }) {
    const id = await this.upload(a, f.data, f.mimeType, 'image');
    return this.json(a, to, { type: 'image', image: { id, caption: f.caption } });
  }
  async sendTemplate(a: WaAccount, to: string, t: TemplateSend) {
    const components: Record<string, unknown>[] = [];
    if (t.header) {
      const id = await this.upload(a, t.header.data, t.header.mimeType, t.header.filename ?? t.header.kind);
      components.push({ type: 'header', parameters: [t.header.kind === 'document' ? { type: 'document', document: { id, filename: t.header.filename ?? 'quotation.pdf' } } : { type: 'image', image: { id } }] });
    } else if (t.headerText !== undefined) {
      components.push({ type: 'header', parameters: [{ type: 'text', text: t.headerText }] });
    }
    if (t.variables.length) components.push({ type: 'body', parameters: t.variables.map((v) => ({ type: 'text', text: v })) });
    for (const b of t.buttons ?? []) components.push({ type: 'button', sub_type: 'url', index: String(b.index), parameters: [{ type: 'text', text: b.value }] });
    return this.json(a, to, { type: 'template', template: { name: t.name, language: { code: t.language }, components } });
  }
  async downloadMedia(a: WaAccount, mediaId: string) {
    const meta = await this.graph(a, mediaId);
    const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new WaSendError(`Media download failed (${res.status})`, String(res.status), res.status >= 500, res.status >= 500 ? 'transient' : 'unknown');
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type as string };
  }

  async getPhoneInfo(a: WaAccount): Promise<WaPhoneInfo> {
    const j = await this.graph(a, `${a.phoneNumberId}?fields=display_phone_number,verified_name,name_status,quality_rating,messaging_limit_tier,status`);
    return {
      displayPhoneNumber: j.display_phone_number, verifiedName: j.verified_name, displayNameStatus: j.name_status,
      qualityRating: j.quality_rating, messagingLimitTier: j.messaging_limit_tier, status: j.status,
    };
  }

  async subscribeWebhooks(a: WaAccount) {
    if (!a.wabaId) throw new WaSendError('WABA ID is required to subscribe webhooks', 'no_waba', false, 'account');
    await this.graph(a, `${a.wabaId}/subscribed_apps`, { method: 'POST' });
  }

  async listTemplates(a: WaAccount): Promise<WaRemoteTemplate[]> {
    if (!a.wabaId) throw new WaSendError('WABA ID is required to list templates', 'no_waba', false, 'account');
    const out: WaRemoteTemplate[] = [];
    let next: string | undefined = `${a.wabaId}/message_templates?fields=id,name,language,category,status,rejected_reason,components&limit=100`;
    for (let page = 0; next && page < 20; page++) {
      const j: any = await this.graph(a, next);
      for (const t of j.data ?? []) {
        const body = (t.components ?? []).find((c: any) => c.type === 'BODY')?.text ?? '';
        out.push({ providerTemplateId: String(t.id), name: t.name, language: t.language, category: t.category, status: t.status, body, rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : undefined });
      }
      next = j.paging?.next;
    }
    return out;
  }

  async submitTemplate(a: WaAccount, t: { name: string; language: string; category: string; components: Record<string, unknown>[] }) {
    if (!a.wabaId) throw new WaSendError('WABA ID is required to submit templates', 'no_waba', false, 'account');
    const j = await this.graph(a, `${a.wabaId}/message_templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t.name, language: t.language, category: t.category, components: t.components }),
    });
    return { providerTemplateId: String(j.id), status: String(j.status ?? 'PENDING') };
  }

  /**
   * Meta's Resumable Upload API: create an upload session on the APP (not the WABA), then send the bytes.
   * The returned handle goes into the template's `example.header_handle`. Needs WHATSAPP_APP_ID.
   */
  async uploadTemplateExample(a: WaAccount, f: { data: Buffer; mimeType: string; filename: string }) {
    const appId = config().WHATSAPP_APP_ID;
    if (!appId) throw new WaSendError('WHATSAPP_APP_ID must be set in the API environment to submit templates with an image or document header', 'no_app_id', false, 'account');
    const qs = new URLSearchParams({ file_name: f.filename, file_length: String(f.data.length), file_type: f.mimeType });
    const session = await this.graph(a, `${appId}/uploads?${qs}`, { method: 'POST' });
    const done = await this.graph(a, String(session.id), { method: 'POST', headers: { Authorization: `OAuth ${a.token}`, file_offset: '0' }, body: new Uint8Array(f.data) });
    if (!done?.h) throw new WaSendError('Meta did not return an upload handle', 'no_handle', false, 'unknown');
    return String(done.h);
  }

  // ---- Embedded Signup v4 / coexistence ----

  /**
   * Server-side authorization-code exchange (Meta: GET /oauth/access_token with client_id, client_secret, code; the code lives
   * about 30 seconds and is single use). The app secret never leaves the server and errors never echo the request URL.
   */
  async exchangeSignupCode(code: string): Promise<WaExchangedToken> {
    const { WHATSAPP_APP_ID: clientId, WHATSAPP_APP_SECRET: clientSecret } = config();
    if (!clientId || !clientSecret) throw new WaSendError('Embedded Signup is not configured on the server (app id and secret)', 'not_configured', false, 'account');
    let res: Response;
    try {
      res = await fetch(`${this.base}/oauth/access_token?${new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code })}`, { signal: AbortSignal.timeout(20000) });
    } catch {
      throw new WaSendError('Could not reach Meta to complete the sign-up', 'network', true, 'transient');
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const c = classifyMetaError(res.status, json?.error?.code, json?.error?.message);
      throw new WaSendError(json?.error?.message ?? `Meta rejected the authorization code (${res.status})`, String(json?.error?.code ?? res.status), c.retryable, c.kind === 'unknown' ? 'auth' : c.kind);
    }
    if (typeof json?.access_token !== 'string' || !json.access_token) throw new WaSendError('Meta did not return an access token', 'no_token', false, 'unknown');
    return { accessToken: json.access_token };
  }

  async listWabaPhoneNumbers(a: WaAccount): Promise<WaWabaPhone[]> {
    if (!a.wabaId) throw new WaSendError('WABA ID is required to list phone numbers', 'no_waba', false, 'account');
    const out: WaWabaPhone[] = [];
    let next: string | undefined = `${a.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`;
    for (let page = 0; next && page < 5; page++) {
      const j: any = await this.graph(a, next);
      for (const p of j.data ?? []) out.push({ id: String(p.id), displayPhoneNumber: p.display_phone_number, verifiedName: p.verified_name });
      next = j.paging?.next;
    }
    return out;
  }

  async getCoexistenceInfo(a: WaAccount): Promise<WaCoexistenceInfo> {
    const j = await this.graph(a, `${a.phoneNumberId}?fields=is_on_biz_app,platform_type`);
    return { isOnBizApp: j.is_on_biz_app === true, platformType: j.platform_type };
  }

  async requestSmbSync(a: WaAccount, syncType: 'smb_app_state_sync' | 'history') {
    await this.call(a, 'smb_app_data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }) });
  }

  verifySignature(rawBody: Buffer, header: string | undefined) {
    const secret = config().WHATSAPP_APP_SECRET;
    if (!secret || !header?.startsWith('sha256=')) return false;
    return safeEqual(header.slice(7), createHmac('sha256', secret).update(rawBody).digest('hex'));
  }
  parseWebhook(body: any) { return parseCloudPayload(body); }
}

/** Both adapters use Meta's webhook payload shape so the simulator exercises the real parser. */
export function parseCloudPayload(body: any): WaEvent[] {
  const events: WaEvent[] = [];
  for (const entry of body?.entry ?? []) {
    const entryTime = new Date((Number(entry?.time) || Math.floor(Date.now() / 1000)) * 1000);
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      // Account-level events carry the WABA id (entry.id), not a phone_number_id.
      if (change?.field === 'message_template_status_update' && v?.message_template_id !== undefined) {
        events.push({ kind: 'template', wabaId: String(entry.id), providerTemplateId: String(v.message_template_id), name: v.message_template_name, language: v.message_template_language, event: String(v.event ?? ''), reason: v.reason && v.reason !== 'NONE' ? String(v.reason) : undefined, timestamp: entryTime });
        continue;
      }
      if (change?.field === 'phone_number_quality_update' || change?.field === 'account_update' || change?.field === 'phone_number_name_update') {
        // For account_update Meta's example puts the WABA in waba_info; `entry.id` can be a partner business id, so prefer waba_info.
        const wabaId = v?.waba_info?.waba_id ?? entry?.id;
        events.push({
          kind: 'account', wabaId: wabaId ? String(wabaId) : undefined, event: String(v?.event ?? change.field), detail: v?.current_limit ?? v?.decision ?? v?.requested_verified_name ?? undefined, timestamp: entryTime,
          disconnectionReason: v?.disconnection_info?.reason ? String(v.disconnection_info.reason) : undefined, initiatedBy: v?.disconnection_info?.initiated_by ? String(v.disconnection_info.initiated_by) : undefined,
        });
        continue;
      }
      // Coexistence (WhatsApp Business app + Cloud API). Phone numbers arrive without "+".
      if (change?.field === 'smb_message_echoes' && v?.metadata?.phone_number_id) {
        for (const m of v.message_echoes ?? []) {
          const body = m[m.type];
          const action = m.type === 'revoke' ? 'revoke' as const : m.type === 'edit' ? 'edit' as const : undefined;
          events.push({
            kind: 'echo', phoneNumberId: String(v.metadata.phone_number_id), providerMessageId: String(m.id), to: `+${m.to}`, type: String(m.type), action,
            text: m.type === 'text' ? body?.body : m.type === 'edit' ? body?.message?.text?.body : body?.caption,
            timestamp: new Date((Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000),
          });
        }
        continue;
      }
      if (change?.field === 'history' && v?.metadata?.phone_number_id) {
        const phoneNumberId = String(v.metadata.phone_number_id);
        for (const h of v.history ?? []) {
          const err = (h?.errors ?? v?.errors)?.[0];
          if (err) { events.push({ kind: 'history', phoneNumberId, messages: [], declined: { code: String(err.code), message: err.message ?? err.title } }); continue; }
          const messages: WaHistoryMessage[] = [];
          for (const t of h?.threads ?? []) {
            for (const m of t?.messages ?? []) {
              const body = m[m.type];
              messages.push({
                providerMessageId: String(m.id), customerPhone: `+${t.id}`, direction: String(m.from) === String(t.id) ? 'inbound' : 'outbound', type: String(m.type),
                text: m.type === 'text' ? body?.body : body?.caption, status: m.history_context?.status, timestamp: new Date(Number(m.timestamp) * 1000),
              });
            }
          }
          events.push({ kind: 'history', phoneNumberId, phase: h?.metadata?.phase, chunkOrder: h?.metadata?.chunk_order, progress: h?.metadata?.progress, messages });
        }
        continue;
      }
      if (change?.field === 'smb_app_state_sync' && v?.metadata?.phone_number_id) {
        const items = (v.state_sync ?? []).filter((s: any) => s?.type === 'contact' && s?.contact?.phone_number && (s.action === 'add' || s.action === 'remove')).map((s: any) => ({
          action: s.action as 'add' | 'remove', phone: `+${s.contact.phone_number}`, fullName: s.contact.full_name, timestamp: new Date((Number(s.metadata?.timestamp) || Math.floor(Date.now() / 1000)) * 1000),
        }));
        if (items.length) events.push({ kind: 'contacts', phoneNumberId: String(v.metadata.phone_number_id), items });
        continue;
      }
      const phoneNumberId = v?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      for (const m of v.messages ?? []) {
        const names: Record<string, string> = {};
        for (const c of v.contacts ?? []) names[c.wa_id] = c.profile?.name;
        const media = m[m.type];
        events.push({
          kind: 'message', phoneNumberId, providerMessageId: m.id, from: `+${m.from}`, name: names[m.from], type: m.type,
          text: m.type === 'text' ? m.text?.body : media?.caption, mediaId: media?.id, mimeType: media?.mime_type,
          timestamp: new Date(Number(m.timestamp) * 1000),
        });
      }
      for (const s of v.statuses ?? []) {
        events.push({
          kind: 'status', phoneNumberId, providerMessageId: s.id, status: s.status, timestamp: new Date(Number(s.timestamp) * 1000),
          errorCode: s.errors?.[0]?.code ? String(s.errors[0].code) : undefined, errorMessage: s.errors?.[0]?.title,
        });
      }
    }
  }
  return events;
}

export function createWhatsApp(): WhatsAppProvider {
  return config().WHATSAPP_PROVIDER === 'cloud' ? new CloudWhatsApp() : new SimulatorWhatsApp();
}
