import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { decryptSecret } from '../../common/crypto';
import { Db } from '../../db/db.service';
import { STORAGE, StorageProvider } from '../../providers/storage/storage';
import { hintForKind } from '../../providers/whatsapp/meta-errors';
import { WaAccount, WaSendError, WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';
import { isRetryableFailure } from '../quotes/retry-policy';
import { compile, TemplateSpec } from '../templates/template-spec';
import { WhatsappAccountService } from '../whatsapp/whatsapp-account.service';
import { notConnectedMessage, SERVICE_WINDOW_MS, textSendBlock, windowState } from './service-window';

export { SERVICE_WINDOW_MS, windowState };

export type OutboundPayload =
  | { kind: 'text'; text: string }
  | { kind: 'document'; assetId: string; filename: string; caption?: string }
  | { kind: 'image'; assetId: string; caption?: string }
  | { kind: 'template'; templateId: string; variables: string[]; extra?: TemplateExtra };

/** The non-body parts of a template send: text-header value, media header (an agency asset) and dynamic URL-button values. */
export interface TemplateExtra {
  headerText?: string;
  header?: { assetId: string; kind: 'image' | 'document'; filename?: string };
  buttons?: { index: number; kind: 'url'; value: string }[];
}

interface Prepared {
  msg: { id: string };
  customer: { phoneE164: string };
  account: { phoneNumberId: string; credentialSecretRef: string | null };
  asset: { storageKey: string; mimeType: string } | null;
  template: { name: string; language: string } | null;
  headerAsset: { storageKey: string; mimeType: string } | null;
}

export interface OutboundResult {
  ok: boolean; messageId: string; status: string; errorCode?: string; errorMessage?: string; deduplicated?: boolean;
  /** Failures only: whether waiting and trying again could succeed (false for credential, window, template... problems). */
  retryable?: boolean;
}

@Injectable()
export class OutboundService {
  constructor(private readonly db: Db, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider, @Inject(STORAGE) private readonly storage: StorageProvider, private readonly accounts: WhatsappAccountService) {}

  /**
   * Sends one customer-facing message through the connected agency account.
   * Idempotent per `idempotencyKey`: a message that was already accepted is never sent twice.
   * Three short transactions (record → provider call → record result) so no DB tx spans the HTTP call.
   */
  async send(agencyId: string, conversationId: string, payload: OutboundPayload, opts: { userId: string | null; idempotencyKey?: string }): Promise<OutboundResult> {
    const ctx = await this.db.tenant(agencyId, async (tx) => {
      const conv = await tx.conversation.findFirst({ where: { id: conversationId, agencyId } });
      if (!conv) throw new NotFoundException({ code: 'not_found', message: 'Conversation not found' });
      const customer = await tx.customer.findFirstOrThrow({ where: { id: conv.customerId, agencyId } });
      const account = await tx.whatsappAccount.findFirst({ where: { agencyId } });
      if (!account || account.connectionStatus === 'disconnected') throw new BadRequestException({ code: 'whatsapp_not_connected', message: notConnectedMessage(account) });

      if (opts.idempotencyKey) {
        const prior = await tx.message.findFirst({ where: { agencyId, idempotencyKey: opts.idempotencyKey } });
        if (prior && prior.status !== 'failed') return { dedup: prior };
        // A retry of a failed send re-uses the key; the failed row keeps its history under a retired key.
        if (prior) await tx.message.update({ where: { id: prior.id }, data: { idempotencyKey: `${opts.idempotencyKey}#retired-${prior.id}` } });
      }

      let template: { name: string; language: string; body: string } | null = null;
      if (payload.kind === 'template') {
        const t = await tx.whatsappTemplate.findFirst({ where: { id: payload.templateId, agencyId } });
        if (!t) throw new NotFoundException({ code: 'not_found', message: 'Template not found' });
        if (t.providerStatus !== 'approved') throw new BadRequestException({ code: 'template_not_approved', message: `Template "${t.name}" is ${t.providerStatus}; only provider-approved templates can be sent` });
        const expected = (t.variableSchema as string[]).length;
        if (payload.variables.length !== expected || payload.variables.some((v) => !v.trim())) throw new BadRequestException({ code: 'template_variables', message: `Template needs ${expected} non-empty variable(s)` });
        // Rich parts: never send a template without the media header or dynamic values it was approved with.
        if (t.spec) {
          const c = compile(t.spec as unknown as TemplateSpec);
          const x = payload.extra;
          if ((c.header.type === 'image' || c.header.type === 'document') && !x?.header) throw new BadRequestException({ code: 'template_media_required', message: `Template "${t.name}" has a ${c.header.type} header: attach it before sending` });
          if (c.header.variable && !x?.headerText?.trim()) throw new BadRequestException({ code: 'template_variables', message: `Template "${t.name}" needs a value for its header` });
          const dynamic = c.buttons.filter((b) => b.urlVariable).length;
          if (dynamic !== (x?.buttons?.length ?? 0) || x?.buttons?.some((b) => !b.value.trim())) throw new BadRequestException({ code: 'template_variables', message: `Template "${t.name}" needs ${dynamic} button link value(s)` });
        }
        template = t;
      } else {
        // Free-form messages are only allowed inside the 24h customer-service window.
        const block = textSendBlock(conv, account);
        if (block) throw new BadRequestException({ code: block.code, message: block.message });
      }

      const text = payload.kind === 'text' ? payload.text : payload.kind === 'template' ? renderTemplate(template!.body, payload.variables) : payload.caption ?? null;
      const msg = await tx.message.create({
        data: {
          agencyId, conversationId, direction: 'outbound', type: payload.kind, text, status: 'queued', simulated: this.wa.simulated, sentByUserId: opts.userId,
          idempotencyKey: opts.idempotencyKey, mediaAssetId: payload.kind === 'document' || payload.kind === 'image' ? payload.assetId : payload.kind === 'template' ? payload.extra?.header?.assetId ?? null : null,
          templateId: payload.kind === 'template' ? payload.templateId : null,
        },
      });
      const asset = payload.kind === 'document' || payload.kind === 'image' ? await tx.asset.findFirst({ where: { id: payload.assetId, agencyId } }) : null;
      if ((payload.kind === 'document' || payload.kind === 'image') && !asset) throw new NotFoundException({ code: 'not_found', message: 'Attachment not found' });
      const hdr = payload.kind === 'template' ? payload.extra?.header : undefined;
      const headerAsset = hdr ? await tx.asset.findFirst({ where: { id: hdr.assetId, agencyId } }) : null;
      if (hdr && !headerAsset) throw new NotFoundException({ code: 'not_found', message: 'Header media not found' });
      return { dedup: null, msg, customer, account, asset, template, headerAsset };
    });

    if (ctx.dedup) return { ok: true, messageId: ctx.dedup.id, status: ctx.dedup.status, deduplicated: true };
    const { msg, customer, account, asset, template, headerAsset } = ctx as unknown as Prepared;

    const acct: WaAccount = { phoneNumberId: account.phoneNumberId, token: account.credentialSecretRef ? decryptSecret(account.credentialSecretRef) : undefined };
    try {
      let r;
      if (payload.kind === 'text') r = await this.wa.sendText(acct, customer.phoneE164, payload.text);
      else if (payload.kind === 'template') {
        const hdr = payload.extra?.header;
        r = await this.wa.sendTemplate(acct, customer.phoneE164, {
          name: template!.name, language: template!.language, variables: payload.variables, headerText: payload.extra?.headerText, buttons: payload.extra?.buttons,
          header: hdr && headerAsset ? { kind: hdr.kind, data: await this.storage.get(headerAsset.storageKey), mimeType: headerAsset.mimeType, filename: hdr.filename } : undefined,
        });
      }
      else {
        const data = await this.storage.get(asset!.storageKey);
        r = payload.kind === 'document'
          ? await this.wa.sendDocument(acct, customer.phoneE164, { filename: payload.filename, data, mimeType: asset!.mimeType, caption: payload.caption })
          : await this.wa.sendImage(acct, customer.phoneE164, { data, mimeType: asset!.mimeType, caption: payload.caption });
      }
      await this.db.tenant(agencyId, async (tx) => {
        await tx.message.update({ where: { id: msg.id }, data: { status: 'submitted', providerMessageId: r.providerMessageId } });
        await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
      });
      return { ok: true, messageId: msg.id, status: 'submitted' };
    } catch (e) {
      const err = e instanceof WaSendError ? e : new WaSendError((e as Error).message, 'unexpected');
      const reason = err.kind === 'unknown' ? err.message : `${err.message}. ${hintForKind(err.kind)}`;
      await this.db.tenant(agencyId, (tx) => tx.message.update({ where: { id: msg.id }, data: { status: 'failed', errorCode: err.code, errorMessage: reason } }));
      // A revoked token or an account-level problem affects every send: surface it on the connection, not just this message.
      if (err.kind === 'auth' || err.kind === 'account') await this.accounts.recordFailure(agencyId, err).catch(() => undefined);
      return { ok: false, messageId: msg.id, status: 'failed', errorCode: err.code, errorMessage: reason, retryable: isRetryableFailure(err.retryable, err.kind) };
    }
  }
}

export function renderTemplate(body: string, vars: string[]) {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[Number(n) - 1] ?? '');
}
