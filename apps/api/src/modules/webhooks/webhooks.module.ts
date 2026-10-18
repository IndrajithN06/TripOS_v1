import { Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Injectable, Logger, NotFoundException, Post, Query, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AssetService } from '../../common/assets';
import { decryptSecret, safeEqual } from '../../common/crypto';
import { Public } from '../../common/auth';
import { config } from '../../config/config';
import { Db, Tx } from '../../db/db.service';
import { accountAppKey, AppKey } from '../../providers/whatsapp/app-identity';
import { metaApps } from '../../providers/whatsapp/meta-apps';
import { WaEvent, WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';
import { WhatsappAccountService } from '../whatsapp/whatsapp-account.service';

const RANK: Record<string, number> = { queued: 0, submitted: 1, sent: 2, delivered: 3, read: 4 };
const MEDIA_MIME_ALLOW = /^(image\/(jpeg|png|webp)|application\/pdf|audio\/(ogg|mpeg|mp4|amr|aac))$/;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

@Injectable()
export class InboundService {
  private readonly log = new Logger('WhatsAppInbound');
  constructor(private readonly db: Db, private readonly assets: AssetService, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider, private readonly accounts: WhatsappAccountService) {}

  /**
   * The tenant is ALWAYS resolved from the destination phone_number_id, never from payload fields a sender controls.
   * `source` is the Meta app whose webhook route (and secret) authenticated this request. An event is applied only to an account
   * issued by THAT app (NULL metaAppId = primary), so a valid signature from one app can never change the other app's accounts.
   */
  async process(events: WaEvent[], source: AppKey = 'primary') {
    const apps = metaApps();
    let processed = 0, duplicates = 0, unknown = 0, ignored = 0, unrecognised = 0;
    for (const e of events) {
      // Account-level events (templates, quality) identify the WABA, not the phone number.
      const account = await this.db.system((tx) => (e.kind !== 'template' && e.kind !== 'account'
        ? tx.whatsappAccount.findUnique({ where: { phoneNumberId: e.phoneNumberId } })
        : e.wabaId ? tx.whatsappAccount.findFirst({ where: { wabaId: e.wabaId } }) : Promise.resolve(null)));
      if (!account) { unknown++; this.log.warn(`Event for unknown WhatsApp account (${e.kind}) ignored`); continue; }
      if (account.connectionStatus === 'disconnected') { ignored++; continue; }
      const key = accountAppKey(account.metaAppId, apps);
      if (key === null) {
        // A configuration fault on OUR side: the account's Meta app is not configured on this server. Never drop its events
        // silently: count them so the route answers 503 (Meta retries for up to 7 days), and mark the account degraded once.
        unrecognised++;
        await this.accounts.flagUnrecognisedApp(account).catch(() => undefined);
        continue;
      }
      if (key !== source) {
        // A correctly authenticated event for an account that belongs to the OTHER app: not ours to apply. Acknowledge (200) so it is
        // not retried; the other app's route (Meta also retries to every subscribed app) handles it.
        ignored++; this.log.warn(`Event (${e.kind}) on the ${source} webhook route belongs to the other Meta app and was ignored`); continue;
      }
      await this.accounts.touchWebhook(account.agencyId, account.id).catch(() => undefined);

      if (e.kind === 'template' || e.kind === 'account') {
        const key = e.kind === 'template' ? `tpl:${e.providerTemplateId}:${e.event}:${e.timestamp.getTime()}` : `acct:${e.event}:${e.timestamp.getTime()}`;
        // The dedupe key and the effect commit TOGETHER: if applying fails, the key is rolled back too, so Meta's retry applies it
        // instead of being suppressed as a duplicate. A concurrent duplicate waits on the unique key and then sees it as a duplicate.
        const out = await this.db.tenant(account.agencyId, async (tx) => {
          if (!(await this.claimKey(tx, account.agencyId, key))) return { dup: true as const };
          const after = e.kind === 'template' ? await this.accounts.applyTemplateEvent(account.agencyId, e, tx) : await this.accounts.applyAccountEvent(account.agencyId, e, tx);
          return { dup: false as const, after };
        });
        if (out.dup) { duplicates++; continue; }
        if (out.after) out.after(); // e.g. the post-commit health re-read
        processed++;
        continue;
      }
      if (e.kind === 'echo' || e.kind === 'history' || e.kind === 'contacts') {
        // Coexistence data is only accepted for accounts that were onboarded as coexistence numbers.
        if (!account.isCoexistence) { ignored++; continue; }
        const n = e.kind === 'echo' ? await this.echo(account.agencyId, e) : e.kind === 'history' ? await this.history(account.agencyId, e) : await this.contacts(account.agencyId, e);
        processed += n.processed; duplicates += n.duplicates; ignored += n.ignored;
        continue;
      }
      const res = e.kind === 'message' ? await this.inbound(account.agencyId, e, account.credentialSecretRef) : await this.status(account.agencyId, e);
      if (res === 'duplicate') duplicates++; else processed++;
    }
    return { processed, duplicates, unknown, ignored, unrecognised };
  }

  /**
   * Records the dedupe key inside the caller's transaction. True the first time it is seen for this agency; false for a
   * duplicate (after which the caller must return without further queries, as a unique violation aborts the transaction).
   */
  private async claimKey(tx: Tx, agencyId: string, eventKey: string) {
    try { await tx.webhookEvent.create({ data: { agencyId, eventKey } }); return true; }
    catch (err: any) { if (err.code === 'P2002') return false; throw err; }
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

  // ------------------------------------------------------------------ coexistence (WhatsApp Business app + Cloud API)

  private async conversationFor(tx: Tx, agencyId: string, phone: string) {
    const customer = await tx.customer.upsert({
      where: { agencyId_phoneE164: { agencyId, phoneE164: phone } }, update: {},
      create: { agencyId, phoneE164: phone, name: phone },
    });
    return (await tx.conversation.findFirst({ where: { agencyId, customerId: customer.id }, orderBy: { lastMessageAt: 'desc' } }))
      ?? tx.conversation.create({ data: { agencyId, customerId: customer.id } });
  }

  /** A message the business typed in the WhatsApp Business app. Recorded as outbound; never re-sent, and it does not open the 24 h window. */
  private async echo(agencyId: string, e: Extract<WaEvent, { kind: 'echo' }>) {
    // Edits and revocations of earlier messages are acknowledged but not applied (the original is kept as history).
    if (e.action) return { processed: 0, duplicates: 0, ignored: 1 };
    return this.db.tenant(agencyId, async (tx) => {
      try { await tx.webhookEvent.create({ data: { agencyId, eventKey: `echo:${e.providerMessageId}` } }); }
      catch (err: any) { if (err.code === 'P2002') return { processed: 0, duplicates: 1, ignored: 0 }; throw err; }
      if (await tx.message.findFirst({ where: { agencyId, providerMessageId: e.providerMessageId }, select: { id: true } })) return { processed: 0, duplicates: 1, ignored: 0 };
      const conv = await this.conversationFor(tx, agencyId, e.to);
      await tx.message.create({
        data: { agencyId, conversationId: conv.id, providerMessageId: e.providerMessageId, direction: 'outbound', type: e.type, text: e.text ?? null, status: 'sent', simulated: false, sentByUserId: null, createdAt: e.timestamp },
      });
      if (e.timestamp > conv.lastMessageAt) await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: e.timestamp } });
      return { processed: 1, duplicates: 0, ignored: 0 };
    });
  }

  /** Imported chat history. Idempotent per message; old messages never raise unread counts or re-open the service window. */
  private async history(agencyId: string, e: Extract<WaEvent, { kind: 'history' }>) {
    if (e.declined) {
      // The business chose not to share history (Meta error 2593109) or the sync failed: record it, do not fail the webhook.
      await this.db.tenant(agencyId, (tx) => tx.whatsappAccount.updateMany({
        // Informational only: never overwrite a meaningful error (auth failure, partner removed, ...) with it; it may replace an older history note.
        where: { agencyId, OR: [{ lastErrorCode: null }, { lastErrorCode: { startsWith: 'history:' } }] },
        data: { lastErrorCode: `history:${e.declined!.code}`, lastErrorAt: new Date() },
      }));
      return { processed: 0, duplicates: 0, ignored: 1 };
    }
    let processed = 0, duplicates = 0;
    for (const m of e.messages) {
      const created = await this.db.tenant(agencyId, async (tx) => {
        try { await tx.webhookEvent.create({ data: { agencyId, eventKey: `hist:${m.providerMessageId}` } }); }
        catch (err: any) { if (err.code === 'P2002') return false; throw err; }
        if (await tx.message.findFirst({ where: { agencyId, providerMessageId: m.providerMessageId }, select: { id: true } })) return false;
        const conv = await this.conversationFor(tx, agencyId, m.customerPhone);
        const status = m.direction === 'inbound' ? 'received' : ({ READ: 'read', DELIVERED: 'delivered', PLAYED: 'read', ERROR: 'failed' } as Record<string, string>)[m.status ?? ''] ?? 'sent';
        await tx.message.create({ data: { agencyId, conversationId: conv.id, providerMessageId: m.providerMessageId, direction: m.direction, type: m.type, text: m.text ?? null, status, simulated: false, createdAt: m.timestamp } });
        await tx.conversation.update({
          where: { id: conv.id },
          data: {
            ...(m.timestamp > conv.lastMessageAt ? { lastMessageAt: m.timestamp } : {}),
            ...(m.direction === 'inbound' && (!conv.lastInboundAt || m.timestamp > conv.lastInboundAt) ? { lastInboundAt: m.timestamp } : {}),
          },
        });
        return true;
      });
      if (created) processed++; else duplicates++;
    }
    return { processed, duplicates, ignored: 0 };
  }

  /** Contacts added in the app become customers. Removals are acknowledged but never delete TripOS data, and existing names are kept. */
  private async contacts(agencyId: string, e: Extract<WaEvent, { kind: 'contacts' }>) {
    let processed = 0, ignored = 0, duplicates = 0;
    for (const c of e.items) {
      if (c.action === 'remove') { ignored++; continue; }
      // Key and customer are written in one transaction: a failed upsert leaves no key behind, so the retry creates the customer.
      const fresh = await this.db.tenant(agencyId, async (tx) => {
        if (!(await this.claimKey(tx, agencyId, `ctc:${c.phone}:${c.timestamp.getTime()}`))) return false;
        await tx.customer.upsert({
          where: { agencyId_phoneE164: { agencyId, phoneE164: c.phone } },
          update: {}, create: { agencyId, phoneE164: c.phone, name: (c.fullName ?? c.phone).slice(0, 120) },
        });
        return true;
      });
      if (fresh) processed++; else duplicates++;
    }
    return { processed, duplicates, ignored };
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

const webhookLog = new Logger('WhatsAppWebhook');
/**
 * Decision: events for an account whose Meta app is not configured here are answered with HTTP 503, not 200. A 200 would make Meta
 * consider them delivered and they would be lost for good; a 503 makes Meta retry with decreasing frequency for up to 7 days, so
 * fixing the configuration recovers them. Trade-offs: the same batch is re-delivered (safe: every event type is de-duplicated by key),
 * and the endpoint keeps answering 503 for batches containing such events until the configuration is fixed. Every other event in
 * the batch has already been applied. A merely "wrong route" event (known app, other route) is a 200: another app's route handles it.
 */
/** Consecutive 503s per route, for an alertable signal. Reset by the first request on that route without an unrecognised app. */
const unrecognisedStreak = new Map<AppKey, { count: number; since: Date }>();
/** Test-only: forget the streaks. */
export function resetWebhookDiagnosticsForTests() { unrecognisedStreak.clear(); }

/**
 * Operational signal (see docs/SECURITY_AND_OPERATIONS.md): every 503 logs ONE error line starting with the stable token
 * `ALERT app_unrecognised_503` and carrying the route, the number of events, and how many 503s in a row this route has answered;
 * from the 3rd in a row it ends with REPEATED. Alert on that token. No account ids or payloads are logged.
 */
function refuseIfUnrecognised<T extends { unrecognised?: number }>(route: AppKey, result: T): T {
  if (result.unrecognised) {
    const streak = unrecognisedStreak.get(route) ?? { count: 0, since: new Date() };
    streak.count++;
    unrecognisedStreak.set(route, streak);
    webhookLog.error(`ALERT app_unrecognised_503 route=${route} events=${result.unrecognised} consecutive=${streak.count} since=${streak.since.toISOString()}${streak.count >= 3 ? ' REPEATED' : ''}`);
    throw new ServiceUnavailableException({ code: 'app_unrecognised', message: 'A WhatsApp account in this request belongs to a Meta app that is not configured on this server' });
  }
  unrecognisedStreak.delete(route);
  return result;
}

/** Primary (original Cloud API) app. Behaviour is unchanged: WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET. */
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
    if (!this.wa.verifySignature(req.rawBody ?? Buffer.from(''), sig, 'primary')) throw new UnauthorizedException({ code: 'bad_signature', message: 'Invalid webhook signature' });
    return refuseIfUnrecognised('primary', await this.inbound.process(this.wa.parseWebhook(req.body), 'primary'));
  }
}

/**
 * Embedded Signup app. Its own callback URL, verify token and HMAC secret (WHATSAPP_SIGNUP_*): the route itself decides which
 * secret is used, so no signature is ever accepted just because it matches "one of the apps". The route does not exist (404)
 * until both the signup secret and verify token are configured. It is NOT tied to the onboarding feature flag, so accounts that
 * are already connected keep receiving events if the flag is switched off.
 */
@Controller('webhooks/whatsapp/signup')
export class SignupWebhooksController {
  constructor(private readonly inbound: InboundService, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider) {}

  private configured() {
    const c = config();
    if (!c.WHATSAPP_SIGNUP_APP_SECRET || !c.WHATSAPP_SIGNUP_VERIFY_TOKEN) throw new NotFoundException();
    // Single-app mode (both app ids equal): every account resolves to the PRIMARY route, so this route would acknowledge and ignore
    // everything. Better a visible 404 than silent drops if the Meta callback is ever pointed here by mistake.
    const apps = metaApps();
    if (apps.primaryAppId && apps.signupAppId && apps.primaryAppId === apps.signupAppId) throw new NotFoundException();
    return c;
  }

  @Public()
  @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    const expected = this.configured().WHATSAPP_SIGNUP_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token && safeEqual(token, expected)) return challenge;
    throw new ForbiddenException();
  }

  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') sig?: string) {
    this.configured();
    if (!this.wa.verifySignature(req.rawBody ?? Buffer.from(''), sig, 'signup')) throw new UnauthorizedException({ code: 'bad_signature', message: 'Invalid webhook signature' });
    return refuseIfUnrecognised('signup', await this.inbound.process(this.wa.parseWebhook(req.body), 'signup'));
  }
}
