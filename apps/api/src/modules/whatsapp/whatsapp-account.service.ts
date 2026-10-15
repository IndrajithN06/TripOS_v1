import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { decryptSecret, encryptSecret } from '../../common/crypto';
import { Db, Tx } from '../../db/db.service';
import { accountAppKey } from '../../providers/whatsapp/app-identity';
import { metaApps } from '../../providers/whatsapp/meta-apps';
import { hintForKind } from '../../providers/whatsapp/meta-errors';
import { WaAccount, WaPhoneInfo, WaSendError, WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';

/** Meta template statuses (webhook events and API) mapped to the product's template states. Unknown values return null. */
export function mapTemplateStatus(metaStatus: string): 'approved' | 'rejected' | 'pending' | 'paused' | null {
  switch (metaStatus.toUpperCase()) {
    case 'APPROVED': case 'REINSTATED': return 'approved';
    case 'REJECTED': return 'rejected';
    case 'PENDING': case 'IN_APPEAL': return 'pending';
    case 'PAUSED': case 'DISABLED': case 'PENDING_DELETION': case 'DELETED': case 'LIMIT_EXCEEDED': return 'paused';
    default: return null; // e.g. FLAGGED: informational, keep current state
  }
}

const BAD_NUMBER_STATUS = ['RESTRICTED', 'BANNED', 'FLAGGED', 'DISCONNECTED', 'UNPAIRED', 'DELETED'];
const BAD_ACCOUNT_EVENT = /(DISABLED|VIOLATION|RESTRICT|BAN|DELETED|SUSPEND)/i;

/** Shown on an account whose Meta app is not configured on this server. Contains no ids. */
const UNRECOGNISED_REASON = 'This account is tied to a Meta app that is not configured on this server, so its WhatsApp events cannot be accepted. Restore the Meta app settings, or disconnect and connect the account again.';
const FLAG_TTL_MS = 10 * 60 * 1000;

export interface ConnectInput { displayName: string; wabaId?: string; phoneNumberId?: string; accessToken?: string }

@Injectable()
export class WhatsappAccountService {
  private readonly log = new Logger('WhatsappAccount');
  /** account:app -> last time we flagged it, so a burst of events causes at most one write attempt per TTL. */
  private readonly flaggedApps = new Map<string, number>();
  constructor(private readonly db: Db, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider) {}

  /** Runs `fn` inside the caller's transaction when given one (so a webhook can record its dedupe key and apply atomically). */
  private inTx<T>(agencyId: string, outer: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return outer ? fn(outer) : this.db.tenant(agencyId, fn);
  }

  creds(a: { phoneNumberId: string; wabaId: string | null; credentialSecretRef: string | null; metaAppId?: string | null }): WaAccount {
    return { phoneNumberId: a.phoneNumberId, wabaId: a.wabaId ?? undefined, token: a.credentialSecretRef ? decryptSecret(a.credentialSecretRef) : undefined, appId: a.metaAppId ?? undefined };
  }

  async load(agencyId: string) {
    const account = await this.db.tenant(agencyId, (tx) => tx.whatsappAccount.findFirst({ where: { agencyId } }));
    if (!account) throw new BadRequestException({ code: 'whatsapp_not_connected', message: 'Connect a WhatsApp account first' });
    return account;
  }

  // ------------------------------------------------------------------ connect / disconnect

  /**
   * Cloud mode validates the credentials and subscribes the webhook BEFORE saving anything, so a bad token or a
   * missing permission is reported immediately and nothing half-configured is stored.
   */
  async connect(agencyId: string, actorId: string, input: ConnectInput) {
    // Checked before any Meta call or write; re-checked inside the saving transaction below.
    await this.assertNoActiveEmbedded(agencyId);
    const cloud = this.wa.name === 'cloud';
    if (!cloud) return this.connectSimulator(agencyId, actorId, input);
    if (!input.phoneNumberId || !input.wabaId || !input.accessToken) {
      throw new BadRequestException({ code: 'missing_fields', message: 'WABA ID, phone number ID and access token are required' });
    }
    // One WhatsApp number / WABA belongs to exactly one agency.
    const clash = await this.db.system((tx) => tx.whatsappAccount.findFirst({ where: { agencyId: { not: agencyId }, OR: [{ phoneNumberId: input.phoneNumberId }, { wabaId: input.wabaId }] } }));
    if (clash) throw new ConflictException({ code: 'whatsapp_in_use', message: 'This WhatsApp number or business account is already connected to another agency' });

    const creds: WaAccount = { phoneNumberId: input.phoneNumberId, wabaId: input.wabaId, token: input.accessToken };
    let info: WaPhoneInfo;
    try { info = await this.wa.getPhoneInfo(creds); } catch (e) { throw this.failure(e, 'Could not verify the access token and phone number ID'); }
    try { await this.wa.subscribeWebhooks(creds); } catch (e) { throw this.failure(e, 'Could not subscribe to WhatsApp webhooks (the token needs the whatsapp_business_management permission and access to this WABA)'); }

    const now = new Date();
    const data = {
      mode: 'cloud', wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, displayName: input.displayName, credentialSecretRef: encryptSecret(input.accessToken),
      connectionStatus: 'connected', statusReason: null, webhookSubscribed: true, subscribedAt: now, lastCheckedAt: now, lastErrorCode: null, lastErrorAt: null,
      // A pasted token has an unknown source app: record none (NULL = primary) and clear anything left by an earlier Embedded Signup.
      onboardingMethod: 'manual', isCoexistence: false, businessId: null, connectedByUserId: null, metaAppId: null,
      displayPhoneNumber: info.displayPhoneNumber ?? null, verifiedName: info.verifiedName ?? null, displayNameStatus: info.displayNameStatus ?? null,
      qualityRating: info.qualityRating ?? null, messagingLimitTier: info.messagingLimitTier ?? null,
    };
    const acc = await this.db.tenant(agencyId, async (tx) => {
      await this.assertNoActiveEmbedded(agencyId, tx);
      const a = await tx.whatsappAccount.upsert({ where: { agencyId }, create: { agencyId, ...data }, update: data });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'whatsapp.connected', entityType: 'whatsapp_account', entityId: a.id, metadata: { mode: 'cloud', phoneNumberId: input.phoneNumberId, wabaId: input.wabaId } });
      return a;
    });
    // Pull templates already created in Meta's manager. Best effort: connecting must not fail because of this.
    await this.syncTemplates(agencyId).catch((e) => this.log.warn(`Initial template sync failed: ${(e as Error).message}`));
    return acc;
  }

  /**
   * A live Embedded Signup / coexistence connection is never replaced by pasting a token: that would silently change its app, its
   * coexistence flag and how its webhooks are classified. The only way out is an explicit disconnect first (a disconnected row has
   * no credential and may be reused). There is deliberately no "replace" shortcut.
   */
  private async assertNoActiveEmbedded(agencyId: string, tx?: Tx) {
    const read = (t: Tx) => t.whatsappAccount.findFirst({ where: { agencyId } });
    const existing = tx ? await read(tx) : await this.db.tenant(agencyId, read);
    if (existing && existing.onboardingMethod === 'embedded' && existing.connectionStatus !== 'disconnected') {
      throw new ConflictException({ code: 'embedded_account_active', message: 'This number is connected through Embedded Signup, so it cannot be replaced by pasting a token. Nothing was changed. Disconnect it first if you really want to switch to a manual connection.' });
    }
  }

  private async connectSimulator(agencyId: string, actorId: string, input: ConnectInput) {
    const phoneNumberId = `sim-${agencyId.slice(0, 8)}`;
    const data = { mode: 'simulator', wabaId: null, phoneNumberId, displayName: input.displayName, credentialSecretRef: null, connectionStatus: 'connected', statusReason: null, webhookSubscribed: true, lastCheckedAt: new Date(), onboardingMethod: 'manual', isCoexistence: false, businessId: null, connectedByUserId: null, metaAppId: null };
    return this.db.tenant(agencyId, async (tx) => {
      await this.assertNoActiveEmbedded(agencyId, tx);
      const a = await tx.whatsappAccount.upsert({ where: { agencyId }, create: { agencyId, ...data }, update: data });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'whatsapp.connected', entityType: 'whatsapp_account', entityId: a.id, metadata: { mode: 'simulator', phoneNumberId } });
      return a;
    });
  }

  /** Stops using the account: credentials are erased and incoming events for it are ignored. */
  async disconnect(agencyId: string, actorId: string) {
    return this.db.tenant(agencyId, async (tx) => {
      const a = await tx.whatsappAccount.findFirst({ where: { agencyId } });
      if (!a) throw new NotFoundException({ code: 'not_found', message: 'No WhatsApp account is connected' });
      await tx.whatsappAccount.update({ where: { id: a.id }, data: { connectionStatus: 'disconnected', statusReason: 'Disconnected by an administrator', credentialSecretRef: null, webhookSubscribed: false } });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'whatsapp.disconnected', entityType: 'whatsapp_account', entityId: a.id });
      return { ok: true };
    });
  }

  failure(e: unknown, prefix: string) {
    if (e instanceof WaSendError) {
      return new BadRequestException({ code: e.kind === 'auth' ? 'whatsapp_auth_failed' : 'whatsapp_error', message: `${prefix}: ${e.message}. ${hintForKind(e.kind)}` });
    }
    return new BadRequestException({ code: 'whatsapp_error', message: `${prefix}: ${(e as Error).message}` });
  }

  // ------------------------------------------------------------------ health

  /** Re-reads the number's health from the provider and updates the connection state. */
  async refreshHealth(agencyId: string) {
    const account = await this.load(agencyId);
    if (account.connectionStatus === 'disconnected') return account;
    try {
      const info = await this.wa.getPhoneInfo(this.creds(account));
      const bad = info.status && BAD_NUMBER_STATUS.includes(info.status.toUpperCase());
      const red = info.qualityRating?.toUpperCase() === 'RED';
      const appBroken = accountAppKey(account.metaAppId, metaApps()) === null;
      return this.db.tenant(agencyId, (tx) => tx.whatsappAccount.update({
        where: { id: account.id },
        data: {
          displayPhoneNumber: info.displayPhoneNumber ?? account.displayPhoneNumber, verifiedName: info.verifiedName ?? account.verifiedName, displayNameStatus: info.displayNameStatus ?? account.displayNameStatus,
          qualityRating: info.qualityRating ?? account.qualityRating, messagingLimitTier: info.messagingLimitTier ?? account.messagingLimitTier, lastCheckedAt: new Date(),
          connectionStatus: bad || appBroken ? 'degraded' : 'connected', lastErrorCode: appBroken ? 'APP_UNRECOGNISED' : bad ? info.status : null,
          statusReason: appBroken ? UNRECOGNISED_REASON : bad ? `Meta reports this number as ${info.status}. Check it in Meta Business Manager.` : red ? 'Quality rating is RED: Meta may limit how many messages this number can send.' : null,
        },
      }));
    } catch (e) {
      const err = e instanceof WaSendError ? e : new WaSendError((e as Error).message, 'unexpected', true, 'transient');
      return this.recordFailure(agencyId, err);
    }
  }

  /** Called when a send or health call fails. Auth and account problems flip the connection to degraded. */
  async recordFailure(agencyId: string, err: WaSendError) {
    const serious = err.kind === 'auth' || err.kind === 'account';
    const hint = hintForKind(err.kind);
    return this.db.tenant(agencyId, async (tx) => {
      const a = await tx.whatsappAccount.findFirst({ where: { agencyId } });
      if (!a) return null;
      return tx.whatsappAccount.update({
        where: { id: a.id },
        data: { lastErrorCode: err.code, lastErrorAt: new Date(), lastCheckedAt: new Date(), ...(serious && a.connectionStatus !== 'disconnected' ? { connectionStatus: 'degraded', statusReason: `${hint} (${err.message})` } : {}) },
      });
    });
  }

  /**
   * An event arrived for an account whose Meta app is not configured on this server. Logs at error level and marks the account
   * degraded with a clear reason. Cheap under bursts: at most one attempt per account per TTL, and the UPDATE matches nothing once the
   * account is already flagged (so it never rewrites the row).
   */
  async flagUnrecognisedApp(a: { id: string; agencyId: string; metaAppId: string | null }) {
    const key = `${a.id}:${a.metaAppId}`, now = Date.now();
    if (now < (this.flaggedApps.get(key) ?? 0) + FLAG_TTL_MS) return 0;
    this.flaggedApps.set(key, now);
    this.log.error(`WhatsApp account ${a.id} belongs to a Meta app that is not configured on this server. Its webhook events are refused (HTTP 503) so Meta retries them for up to 7 days. Fix WHATSAPP_APP_ID / WHATSAPP_SIGNUP_APP_ID, or disconnect and reconnect the account.`);
    const r = await this.db.tenant(a.agencyId, (tx) => tx.whatsappAccount.updateMany({
      where: { id: a.id, connectionStatus: { not: 'disconnected' }, OR: [{ lastErrorCode: null }, { lastErrorCode: { not: 'APP_UNRECOGNISED' } }] },
      data: { connectionStatus: 'degraded', lastErrorCode: 'APP_UNRECOGNISED', lastErrorAt: new Date(), statusReason: UNRECOGNISED_REASON },
    }));
    return r.count;
  }

  /** Startup check: every account tied to a Meta app must match a configured app. Read-mostly; flags (never disconnects) the rest. */
  async auditAppIdentities() {
    const rows = await this.db.system((tx) => tx.whatsappAccount.findMany({ where: { metaAppId: { not: null } }, select: { id: true, agencyId: true, metaAppId: true } }));
    const apps = metaApps();
    let unrecognised = 0;
    for (const r of rows) if (accountAppKey(r.metaAppId, apps) === null) { unrecognised++; await this.flagUnrecognisedApp(r).catch(() => undefined); }
    return { checked: rows.length, unrecognised };
  }

  /** Same as above but never throws: a database that has not been migrated yet is reported clearly instead of crashing startup. */
  async auditAppIdentitiesSafely() {
    try { return await this.auditAppIdentities(); } catch (e) {
      this.log.error(`Could not check WhatsApp account app identities (has the latest database migration been applied?): ${(e as Error).message.split('\n').pop()}`);
      return null;
    }
  }

  /** Periodic job: checks every cloud account that is not disconnected. */
  async checkAll() {
    const rows = await this.db.system((tx) => tx.whatsappAccount.findMany({ where: { mode: 'cloud', connectionStatus: { not: 'disconnected' } }, select: { agencyId: true } }));
    for (const r of rows) await this.refreshHealth(r.agencyId).catch((e) => this.log.warn(`Health check failed for ${r.agencyId}: ${(e as Error).message}`));
    return rows.length;
  }

  touchWebhook(agencyId: string, accountId: string) {
    return this.db.tenant(agencyId, (tx) => tx.whatsappAccount.update({ where: { id: accountId }, data: { lastWebhookAt: new Date() } }));
  }

  // ------------------------------------------------------------------ templates

  // Template authoring, submission and previews live in modules/templates/templates.service.ts.

  /** Pulls every template from the provider: updates local ones and adds ones created in Meta's own manager. */
  async syncTemplates(agencyId: string) {
    const account = await this.load(agencyId);
    let remote;
    try { remote = await this.wa.listTemplates(this.creds(account)); } catch (e) {
      if (e instanceof WaSendError && (e.kind === 'auth' || e.kind === 'account')) await this.recordFailure(agencyId, e);
      throw this.failure(e, 'Could not read templates from Meta');
    }
    let updated = 0, created = 0;
    await this.db.tenant(agencyId, async (tx) => {
      for (const r of remote) {
        const status = mapTemplateStatus(r.status);
        const vars = [...r.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
        const count = vars.length ? Math.max(...vars) : 0;
        const existing = await tx.whatsappTemplate.findFirst({ where: { agencyId, OR: [{ providerTemplateId: r.providerTemplateId }, { name: r.name, language: r.language }] } });
        if (existing) {
          await tx.whatsappTemplate.update({ where: { id: existing.id }, data: { providerTemplateId: r.providerTemplateId, ...(status ? { providerStatus: status } : {}), rejectedReason: r.rejectedReason ?? null, lastSyncedAt: new Date() } });
          updated++;
        } else {
          await tx.whatsappTemplate.create({ data: { agencyId, name: r.name, language: r.language, category: r.category || 'UTILITY', body: r.body, variableSchema: Array.from({ length: count }, (_, i) => `variable_${i + 1}`), providerTemplateId: r.providerTemplateId, providerStatus: status ?? 'pending', rejectedReason: r.rejectedReason ?? null, lastSyncedAt: new Date() } });
          created++;
        }
      }
    });
    return { updated, created, total: remote.length };
  }

  // ------------------------------------------------------------------ inbound account-level events

  async applyTemplateEvent(agencyId: string, e: { providerTemplateId: string; name?: string; language?: string; event: string; reason?: string }, outerTx?: Tx) {
    const status = mapTemplateStatus(e.event);
    if (!status) return;
    await this.inTx(agencyId, outerTx, async (tx) => {
      const t = await tx.whatsappTemplate.findFirst({ where: { agencyId, OR: [{ providerTemplateId: e.providerTemplateId }, ...(e.name ? [{ name: e.name, language: e.language ?? 'en' }] : [])] } });
      if (!t) return;
      await tx.whatsappTemplate.update({ where: { id: t.id }, data: { providerTemplateId: e.providerTemplateId, providerStatus: status, rejectedReason: status === 'rejected' ? e.reason ?? 'Rejected by Meta' : null, lastSyncedAt: new Date() } });
      await audit(tx, { agencyId, actorUserId: null, action: 'template.provider_status', entityType: 'template', entityId: t.id, metadata: { event: e.event, reason: e.reason } });
    });
  }

  /**
   * Meta removed TripOS's access to this WABA (the business disconnected it in the WhatsApp Business app, went inactive, changed
   * number, ...). The stored token is useless afterwards. An account onboarded through Embedded Signup becomes `disconnected` and its
   * credential is erased; a manually connected account is only marked `degraded` and left untouched, because the admin should decide.
   */
  private async applyPartnerRemoved(agencyId: string, account: { id: string; onboardingMethod: string }, e: { disconnectionReason?: string; initiatedBy?: string }, outerTx?: Tx) {
    const why = e.disconnectionReason ? ` (${e.disconnectionReason.toLowerCase().replace(/_/g, ' ')})` : '';
    const reason = `Access was removed on the WhatsApp side${why}${e.initiatedBy === 'USER' ? ', by the business' : ''}. Connect again to resume.`;
    const embedded = account.onboardingMethod === 'embedded';
    await this.inTx(agencyId, outerTx, async (tx) => {
      await tx.whatsappAccount.update({
        where: { id: account.id },
        data: embedded
          ? { connectionStatus: 'disconnected', statusReason: reason, credentialSecretRef: null, webhookSubscribed: false, lastErrorCode: 'PARTNER_REMOVED', lastErrorAt: new Date() }
          : { connectionStatus: 'degraded', statusReason: reason, lastErrorCode: 'PARTNER_REMOVED', lastErrorAt: new Date() },
      });
      await audit(tx, { agencyId, actorUserId: null, action: 'whatsapp.partner_removed', entityType: 'whatsapp_account', entityId: account.id, metadata: { reason: e.disconnectionReason, initiatedBy: e.initiatedBy, onboardingMethod: account.onboardingMethod } });
    });
  }

  /**
   * Returns an optional follow-up to run AFTER the surrounding transaction commits (never inside it): the health re-read talks to Meta.
   * With `outerTx` the whole effect joins the caller's transaction, so a failure rolls back together with the webhook's dedupe key.
   */
  async applyAccountEvent(agencyId: string, e: { event: string; detail?: string; disconnectionReason?: string; initiatedBy?: string }, outerTx?: Tx): Promise<(() => void) | void> {
    const account = await this.inTx(agencyId, outerTx, (tx) => tx.whatsappAccount.findFirst({ where: { agencyId } }));
    if (!account || account.connectionStatus === 'disconnected') return;
    if (e.event === 'PARTNER_REMOVED') return this.applyPartnerRemoved(agencyId, account, e, outerTx);
    if (BAD_ACCOUNT_EVENT.test(e.event)) {
      await this.inTx(agencyId, outerTx, (tx) => tx.whatsappAccount.update({ where: { id: account.id }, data: { connectionStatus: 'degraded', lastErrorCode: e.event, lastErrorAt: new Date(), statusReason: `Meta reported an account event: ${e.event}. Check Meta Business Manager.` } }));
      return;
    }
    // quality / limit changes: re-read the authoritative values (best effort, off the webhook's critical path, after commit)
    return () => { void this.refreshHealth(agencyId).catch(() => undefined); };
  }
}
