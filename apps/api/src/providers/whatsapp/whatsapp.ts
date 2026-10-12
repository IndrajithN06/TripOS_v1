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
  | { kind: 'account'; wabaId?: string; phoneNumberId?: string; event: string; detail?: string; timestamp: Date };

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
  sendTemplate(a: WaAccount, to: string, t: { name: string; language: string; variables: string[] }): Promise<WaSendResult>;
  downloadMedia(a: WaAccount, mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parseWebhook(body: any): WaEvent[];
  /** Validates the credentials and returns the number's health. Throws WaSendError(kind 'auth') on a bad token. */
  getPhoneInfo(a: WaAccount): Promise<WaPhoneInfo>;
  /** Subscribes the platform app to this WABA's webhooks. Idempotent. */
  subscribeWebhooks(a: WaAccount): Promise<void>;
  listTemplates(a: WaAccount): Promise<WaRemoteTemplate[]>;
  /** Submits a template for review; returns the provider's id and initial status. */
  submitTemplate(a: WaAccount, t: { name: string; language: string; category: string; body: string; variables: string[] }): Promise<{ providerTemplateId: string; status: string }>;
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
  async submitTemplate(_a: WaAccount, t: { name: string; language: string; category: string; body: string }) {
    const providerTemplateId = `sim-tpl-${t.name}-${t.language}`;
    return { providerTemplateId, status: 'PENDING' };
  }
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
  sendTemplate(a: WaAccount, to: string, t: { name: string; language: string; variables: string[] }) {
    return this.json(a, to, {
      type: 'template',
      template: { name: t.name, language: { code: t.language }, components: t.variables.length ? [{ type: 'body', parameters: t.variables.map((v) => ({ type: 'text', text: v })) }] : [] },
    });
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

  async submitTemplate(a: WaAccount, t: { name: string; language: string; category: string; body: string; variables: string[] }) {
    if (!a.wabaId) throw new WaSendError('WABA ID is required to submit templates', 'no_waba', false, 'account');
    const bodyComponent: Record<string, unknown> = { type: 'BODY', text: t.body };
    if (t.variables.length) bodyComponent.example = { body_text: [t.variables.map((v) => `Example ${v}`)] };
    const j = await this.graph(a, `${a.wabaId}/message_templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t.name, language: t.language, category: t.category, components: [bodyComponent] }),
    });
    return { providerTemplateId: String(j.id), status: String(j.status ?? 'PENDING') };
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
        events.push({ kind: 'account', wabaId: entry?.id ? String(entry.id) : undefined, event: String(v?.event ?? change.field), detail: v?.current_limit ?? v?.decision ?? v?.requested_verified_name ?? undefined, timestamp: entryTime });
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
