import { createHmac } from 'crypto';
import { config } from '../../config/config';
import { safeEqual } from '../../common/crypto';

export interface WaAccount {
  phoneNumberId: string;
  /** Decrypted access token (cloud only). */
  token?: string;
}

export interface WaSendResult { providerMessageId: string; simulated: boolean }

export type WaEvent =
  | { kind: 'message'; phoneNumberId: string; providerMessageId: string; from: string; name?: string; type: string; text?: string; mediaId?: string; mimeType?: string; timestamp: Date }
  | { kind: 'status'; phoneNumberId: string; providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; errorCode?: string; errorMessage?: string; timestamp: Date };

export class WaSendError extends Error {
  constructor(message: string, readonly code = 'send_failed', readonly retryable = true) { super(message); }
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
}

// ----------------------------------------------------------------------------------------------
// Meta WhatsApp Business Platform Cloud API (production). Not verifiable without live credentials.
// ----------------------------------------------------------------------------------------------
export class CloudWhatsApp implements WhatsAppProvider {
  readonly name = 'cloud' as const;
  readonly simulated = false;
  private readonly base = config().WHATSAPP_API_BASE_URL;

  private async call(a: WaAccount, pathSuffix: string, init: RequestInit) {
    if (!a.token) throw new WaSendError('WhatsApp account has no credential configured', 'no_credential', false);
    const res = await fetch(`${this.base}/${a.phoneNumberId}/${pathSuffix}`, {
      ...init, headers: { Authorization: `Bearer ${a.token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new WaSendError(json?.error?.message ?? `WhatsApp API error ${res.status}`, String(json?.error?.code ?? res.status), retryable);
    }
    return json;
  }
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
    const meta: any = await (await fetch(`${this.base}/${mediaId}`, { headers: { Authorization: `Bearer ${a.token}` } })).json();
    const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${a.token}` } });
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type as string };
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
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
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
