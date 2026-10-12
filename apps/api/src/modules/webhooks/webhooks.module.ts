import { Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Injectable, Logger, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AssetService } from '../../common/assets';
import { decryptSecret, safeEqual } from '../../common/crypto';
import { Public } from '../../common/auth';
import { config } from '../../config/config';
import { Db } from '../../db/db.service';
import { WaEvent, WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';

const RANK: Record<string, number> = { queued: 0, submitted: 1, sent: 2, delivered: 3, read: 4 };
const MEDIA_MIME_ALLOW = /^(image\/(jpeg|png|webp)|application\/pdf|audio\/(ogg|mpeg|mp4|amr|aac))$/;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

@Injectable()
export class InboundService {
  private readonly log = new Logger('WhatsAppInbound');
  constructor(private readonly db: Db, private readonly assets: AssetService, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider) {}

  /** The tenant is ALWAYS resolved from the destination phone_number_id, never from payload fields a sender controls. */
  async process(events: WaEvent[]) {
    let processed = 0, duplicates = 0, unknown = 0;
    for (const e of events) {
      const account = await this.db.system((tx) => tx.whatsappAccount.findUnique({ where: { phoneNumberId: e.phoneNumberId } }));
      if (!account) { unknown++; this.log.warn(`Event for unknown phone_number_id ${e.phoneNumberId} ignored`); continue; }
      const res = e.kind === 'message' ? await this.inbound(account.agencyId, e, account.credentialSecretRef) : await this.status(account.agencyId, e);
      if (res === 'duplicate') duplicates++; else processed++;
    }
    return { processed, duplicates, unknown };
  }

  private async inbound(agencyId: string, e: Extract<WaEvent, { kind: 'message' }>, credRef: string | null) {
    const result = await this.db.tenant(agencyId, async (tx) => {
      try { await tx.webhookEvent.create({ data: { agencyId, eventKey: `msg:${e.providerMessageId}` } }); }
      catch (err: any) { if (err.code === 'P2002') return { dup: true as const }; throw err; }

      const customer = await tx.customer.upsert({
        where: { agencyId_phoneE164: { agencyId, phoneE164: e.from } }, update: {},
        create: { agencyId, phoneE164: e.from, name: (e.name ?? e.from).slice(0, 120) },
      });
      let conv = await tx.conversation.findFirst({ where: { agencyId, customerId: customer.id }, orderBy: { lastMessageAt: 'desc' } });
      if (!conv) conv = await tx.conversation.create({ data: { agencyId, customerId: customer.id } });
      const msg = await tx.message.create({
        data: { agencyId, conversationId: conv.id, providerMessageId: e.providerMessageId, direction: 'inbound', type: e.type, text: e.text ?? null, status: 'received', simulated: this.wa.simulated, createdAt: e.timestamp },
      });
      await tx.conversation.update({ where: { id: conv.id }, data: { unreadCount: { increment: 1 }, lastMessageAt: e.timestamp, lastInboundAt: e.timestamp, status: conv.status === 'closed' ? 'open' : conv.status } });
      return { dup: false as const, msgId: msg.id };
    });
    if (result.dup) return 'duplicate' as const;

    if (e.mediaId) {
      // Media is fetched best-effort; a failure never blocks the message itself.
      try {
        const token = credRef ? decryptSecret(credRef) : undefined;
        const m = await this.wa.downloadMedia({ phoneNumberId: e.phoneNumberId, token }, e.mediaId);
        if (!MEDIA_MIME_ALLOW.test(m.mimeType) || m.data.length > MAX_MEDIA_BYTES) throw new Error(`Unsupported media ${m.mimeType} (${m.data.length} bytes)`);
        await this.db.tenant(agencyId, async (tx) => {
          const a = await this.assets.storeBuffer(tx, agencyId, null, m.data, m.mimeType, 'message_media');
          await tx.message.update({ where: { id: result.msgId }, data: { mediaAssetId: a.id } });
        });
      } catch (err) { this.log.warn(`Media fetch failed for ${e.mediaId}: ${(err as Error).message}`); }
    }
    return 'ok' as const;
  }

  private async status(agencyId: string, e: Extract<WaEvent, { kind: 'status' }>) {
    return this.db.tenant(agencyId, async (tx) => {
      try { await tx.webhookEvent.create({ data: { agencyId, eventKey: `st:${e.providerMessageId}:${e.status}` } }); }
      catch (err: any) { if (err.code === 'P2002') return 'duplicate' as const; throw err; }
      const m = await tx.message.findFirst({ where: { agencyId, providerMessageId: e.providerMessageId } });
      if (!m) return 'ok' as const;
      if (e.status === 'failed') {
        await tx.message.update({ where: { id: m.id }, data: { status: 'failed', errorCode: e.errorCode, errorMessage: e.errorMessage } });
        // A provider-reported failure of a quote item turns that item into a retryable failure (partial delivery).
        const att = await tx.quoteSendAttempt.findFirst({ where: { agencyId, messageId: m.id } });
        if (att) {
          await tx.quoteSendAttempt.update({ where: { id: att.id }, data: { status: 'failed', lastError: e.errorMessage ?? 'Delivery failed' } });
          const all = await tx.quoteSendAttempt.findMany({ where: { quoteVersionId: att.quoteVersionId } });
          await tx.quoteVersion.update({ where: { id: att.quoteVersionId }, data: { status: all.some((a) => a.status === 'sent') ? 'partially_sent' : 'failed' } });
        }
      } else if ((RANK[e.status] ?? -1) > (RANK[m.status] ?? -1)) {
        await tx.message.update({ where: { id: m.id }, data: { status: e.status } });
      }
      return 'ok' as const;
    });
  }
}

@Controller('webhooks/whatsapp')
export class WebhooksController {
  constructor(private readonly inbound: InboundService, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider) {}

  @Public()
  @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    const expected = config().WHATSAPP_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token && safeEqual(token, expected)) return challenge;
    throw new ForbiddenException();
  }

  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') sig?: string) {
    if (!this.wa.verifySignature(req.rawBody ?? Buffer.from(''), sig)) throw new UnauthorizedException({ code: 'bad_signature', message: 'Invalid webhook signature' });
    return this.inbound.process(this.wa.parseWebhook(req.body));
  }
}
