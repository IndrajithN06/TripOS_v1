import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { decryptSecret, encryptSecret } from '../../common/crypto';
import { Db } from '../../db/db.service';
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

export interface ConnectInput { displayName: string; wabaId?: string; phoneNumberId?: string; accessToken?: string }

@Injectable()
export class WhatsappAccountService {
  private readonly log = new Logger('WhatsappAccount');
  constructor(private readonly db: Db, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider) {}

  private creds(a: { phoneNumberId: string; wabaId: string | null; credentialSecretRef: string | null }): WaAccount {
    return { phoneNumberId: a.phoneNumberId, wabaId: a.wabaId ?? undefined, token: a.credentialSecretRef ? decryptSecret(a.credentialSecretRef) : undefined };
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
      displayPhoneNumber: info.displayPhoneNumber ?? null, verifiedName: info.verifiedName ?? null, displayNameStatus: info.displayNameStatus ?? null,
      qualityRating: info.qualityRating ?? null, messagingLimitTier: info.messagingLimitTier ?? null,
    };
    const acc = await this.db.tenant(agencyId, async (tx) => {
      const a = await tx.whatsappAccount.upsert({ where: { agencyId }, create: { agencyId, ...data }, update: data });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'whatsapp.connected', entityType: 'whatsapp_account', entityId: a.id, metadata: { mode: 'cloud', phoneNumberId: input.phoneNumberId, wabaId: input.wabaId } });
      return a;
    });
    // Pull templates already created in Meta's manager. Best effort: connecting must not fail because of this.
    await this.syncTemplates(agencyId).catch((e) => this.log.warn(`Initial template sync failed: ${(e as Error).message}`));
    return acc;
  }

  private async connectSimulator(agencyId: string, actorId: string, input: ConnectInput) {
    const phoneNumberId = `sim-${agencyId.slice(0, 8)}`;
    const data = { mode: 'simulator', wabaId: null, phoneNumberId, displayName: input.displayName, credentialSecretRef: null, connectionStatus: 'connected', statusReason: null, webhookSubscribed: true, lastCheckedAt: new Date() };
    return this.db.tenant(agencyId, async (tx) => {
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

  private failure(e: unknown, prefix: string) {
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
      return this.db.tenant(agencyId, (tx) => tx.whatsappAccount.update({
        where: { id: account.id },
        data: {
          displayPhoneNumber: info.displayPhoneNumber ?? account.displayPhoneNumber, verifiedName: info.verifiedName ?? account.verifiedName, displayNameStatus: info.displayNameStatus ?? account.displayNameStatus,
          qualityRating: info.qualityRating ?? account.qualityRating, messagingLimitTier: info.messagingLimitTier ?? account.messagingLimitTier, lastCheckedAt: new Date(),
          connectionStatus: bad ? 'degraded' : 'connected', lastErrorCode: bad ? info.status : null,
          statusReason: bad ? `Meta reports this number as ${info.status}. Check it in Meta Business Manager.` : red ? 'Quality rating is RED: Meta may limit how many messages this number can send.' : null,
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

  async submitTemplate(agencyId: string, actorId: string, templateId: string) {
    const [account, t] = await Promise.all([
      this.load(agencyId),
      this.db.tenant(agencyId, (tx) => tx.whatsappTemplate.findFirst({ where: { id: templateId, agencyId } })),
    ]);
    if (!t) throw new NotFoundException({ code: 'not_found', message: 'Template not found' });
    if (t.providerStatus !== 'local_draft' && t.providerStatus !== 'rejected') throw new BadRequestException({ code: 'already_submitted', message: `This template is already ${t.providerStatus}` });
    let res: { providerTemplateId: string; status: string };
    try {
      res = await this.wa.submitTemplate(this.creds(account), { name: t.name, language: t.language, category: t.category, body: t.body, variables: t.variableSchema as string[] });
    } catch (e) {
      if (e instanceof WaSendError && (e.kind === 'auth' || e.kind === 'account')) await this.recordFailure(agencyId, e);
      throw this.failure(e, 'Meta rejected the template submission');
    }
    // Submitted is NOT approved: the provider's own status (normally PENDING) is what we store.
    const status = mapTemplateStatus(res.status) ?? 'pending';
    return this.db.tenant(agencyId, async (tx) => {
      const u = await tx.whatsappTemplate.update({ where: { id: t.id }, data: { providerTemplateId: res.providerTemplateId, providerStatus: this.wa.simulated && status === 'pending' ? 'submitted' : status, rejectedReason: null, lastSyncedAt: new Date() } });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'template.submitted', entityType: 'template', entityId: t.id, metadata: { providerStatus: u.providerStatus } });
      return u;
    });
  }

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

  async applyTemplateEvent(agencyId: string, e: { providerTemplateId: string; name?: string; language?: string; event: string; reason?: string }) {
    const status = mapTemplateStatus(e.event);
    if (!status) return;
    await this.db.tenant(agencyId, async (tx) => {
      const t = await tx.whatsappTemplate.findFirst({ where: { agencyId, OR: [{ providerTemplateId: e.providerTemplateId }, ...(e.name ? [{ name: e.name, language: e.language ?? 'en' }] : [])] } });
      if (!t) return;
      await tx.whatsappTemplate.update({ where: { id: t.id }, data: { providerTemplateId: e.providerTemplateId, providerStatus: status, rejectedReason: status === 'rejected' ? e.reason ?? 'Rejected by Meta' : null, lastSyncedAt: new Date() } });
      await audit(tx, { agencyId, actorUserId: null, action: 'template.provider_status', entityType: 'template', entityId: t.id, metadata: { event: e.event, reason: e.reason } });
    });
  }

  async applyAccountEvent(agencyId: string, e: { event: string; detail?: string }) {
    const account = await this.db.tenant(agencyId, (tx) => tx.whatsappAccount.findFirst({ where: { agencyId } }));
    if (!account || account.connectionStatus === 'disconnected') return;
    if (BAD_ACCOUNT_EVENT.test(e.event)) {
      await this.db.tenant(agencyId, (tx) => tx.whatsappAccount.update({ where: { id: account.id }, data: { connectionStatus: 'degraded', lastErrorCode: e.event, lastErrorAt: new Date(), statusReason: `Meta reported an account event: ${e.event}. Check Meta Business Manager.` } }));
    } else {
      // quality / limit changes: re-read the authoritative values (best effort, off the webhook's critical path)
      void this.refreshHealth(agencyId).catch(() => undefined);
    }
  }
}
