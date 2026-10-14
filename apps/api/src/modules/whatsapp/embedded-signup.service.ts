import { BadRequestException, ConflictException, ForbiddenException, GoneException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256 } from '../../common/crypto';
import { config } from '../../config/config';
import { Db } from '../../db/db.service';
import { hintForKind } from '../../providers/whatsapp/meta-errors';
import { WaAccount, WaSendError, WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';
import { whatsappStatusView } from './status-view';
import { WhatsappAccountService } from './whatsapp-account.service';

const ATTEMPT_TTL_MS = 30 * 60 * 1000;
/** A run that has been "running" longer than this is presumed dead (process crash) and may be taken over. */
const RUN_LOCK_MS = 2 * 60 * 1000;
/** Embedded Signup completion events we act on. Everything else (CANCEL, ERROR, FINISH_ONLY_WABA, ...) is not a usable connection. */
export const SIGNUP_FINISH_EVENTS = ['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'] as const;

export interface CompleteInput {
  attemptId: string;
  state: string;
  /** One-time authorization code from FB.login. Optional on a retry that can resume from the stored token. */
  code?: string;
  event: { type: string; wabaId?: string; phoneNumberId?: string; businessId?: string };
  displayName: string;
}

type Step = 'exchange' | 'verify' | 'subscribe' | 'commit';

/** A failure we decided how to report: whether the run can be retried, and whether a fresh authorization code is needed. */
class StepFailure extends Error {
  constructor(readonly step: Step, readonly code: string, message: string, readonly permanent = false, readonly http: 'bad' | 'conflict' = 'bad') { super(message); }
}

@Injectable()
export class EmbeddedSignupService {
  private readonly log = new Logger('EmbeddedSignup');
  constructor(private readonly db: Db, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider, private readonly accounts: WhatsappAccountService) {}

  private assertEnabled() {
    if (!config().WHATSAPP_EMBEDDED_SIGNUP_ENABLED) throw new NotFoundException({ code: 'feature_disabled', message: 'WhatsApp Embedded Signup is not enabled' });
  }

  private graphVersion() { return /\/(v\d+\.\d+)\/?$/.exec(config().WHATSAPP_API_BASE_URL)?.[1] ?? 'v21.0'; }

  private view(a: any) {
    return {
      id: a.id, status: a.status, step: a.step, failedStep: a.failedStep, lastErrorCode: a.lastErrorCode, lastError: a.lastError, syncStatus: a.syncStatus,
      expiresAt: a.expiresAt, completedAt: a.completedAt,
      /** True when the exchange has not succeeded yet: the browser must run the Meta popup again to get a fresh code. */
      needsNewCode: !a.tokenRef && ['started', 'failed'].includes(a.status),
    };
  }

  // ------------------------------------------------------------------ read

  /** Public, non-secret settings the browser needs, plus the latest attempt so the UI can resume. */
  async settings(agencyId: string) {
    const c = config();
    if (!c.WHATSAPP_EMBEDDED_SIGNUP_ENABLED) return { enabled: false };
    const { account, attempt } = await this.db.tenant(agencyId, async (tx) => ({
      account: await tx.whatsappAccount.findFirst({ where: { agencyId } }),
      attempt: await tx.whatsappSignupAttempt.findFirst({ where: { agencyId }, orderBy: { createdAt: 'desc' } }),
    }));
    return {
      enabled: true, simulated: this.wa.simulated, appId: c.WHATSAPP_APP_ID ?? null, configId: c.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID ?? null, graphVersion: this.graphVersion(),
      // An existing live connection is never replaced by this flow; the admin must disconnect it first.
      blockedByExistingConnection: !!account && account.connectionStatus !== 'disconnected',
      attempt: attempt ? this.view(attempt) : null,
    };
  }

  // ------------------------------------------------------------------ start

  async start(agencyId: string, userId: string, opts: { requestSync: boolean }) {
    this.assertEnabled();
    const c = config();
    const now = new Date();
    const state = randomToken(24);
    const result = await this.db.tenant(agencyId, async (tx) => {
      const existing = await tx.whatsappAccount.findFirst({ where: { agencyId } });
      if (existing && existing.connectionStatus !== 'disconnected') {
        throw new ConflictException({ code: 'whatsapp_already_connected', message: 'This agency already has a WhatsApp connection. It has not been changed. Disconnect it first if you want to replace it.' });
      }
      // Anything past its deadline is closed and its token forgotten.
      await tx.whatsappSignupAttempt.updateMany({ where: { agencyId, status: { in: ['started', 'running', 'failed'] }, expiresAt: { lt: now } }, data: { status: 'expired', tokenRef: null, runStartedAt: null } });
      const open = await tx.whatsappSignupAttempt.findFirst({ where: { agencyId, status: { in: ['started', 'running', 'failed'] } }, orderBy: { createdAt: 'desc' } });
      if (open) {
        if (open.status === 'running' && open.runStartedAt && now.getTime() - open.runStartedAt.getTime() < RUN_LOCK_MS) {
          throw new ConflictException({ code: 'signup_in_progress', message: 'A sign-up is already being processed. Wait a moment and check its status.' });
        }
        // Reuse (idempotent start): same attempt, fresh state value, any stored progress kept.
        return tx.whatsappSignupAttempt.update({ where: { id: open.id }, data: { stateHash: sha256(state), userId, requestSync: opts.requestSync, expiresAt: new Date(now.getTime() + ATTEMPT_TTL_MS) } });
      }
      return tx.whatsappSignupAttempt.create({ data: { agencyId, userId, stateHash: sha256(state), requestSync: opts.requestSync, expiresAt: new Date(now.getTime() + ATTEMPT_TTL_MS) } });
    });
    return { attemptId: result.id, state, expiresAt: result.expiresAt, appId: c.WHATSAPP_APP_ID ?? null, configId: c.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID ?? null, graphVersion: this.graphVersion() };
  }

  async cancel(agencyId: string, userId: string, attemptId: string) {
    this.assertEnabled();
    const r = await this.db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.updateMany({
      where: { id: attemptId, agencyId, userId, status: { in: ['started', 'failed'] } }, data: { status: 'cancelled', tokenRef: null },
    }));
    return { ok: r.count === 1 };
  }

  // ------------------------------------------------------------------ complete

  async complete(agencyId: string, userId: string, input: CompleteInput) {
    this.assertEnabled();
    const attempt = await this.db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.findFirst({ where: { id: input.attemptId, agencyId } }));
    // Same answer for "not yours" and "does not exist": nothing about other agencies' attempts is revealed.
    if (!attempt || attempt.userId !== userId) throw new NotFoundException({ code: 'signup_not_found', message: 'Sign-up attempt not found' });
    if (!safeEqual(attempt.stateHash, sha256(input.state))) throw new ForbiddenException({ code: 'signup_state_invalid', message: 'This sign-up window does not match the one that was started. Start again.' });

    if (attempt.status === 'completed') {
      const acc = await this.db.tenant(agencyId, (tx) => tx.whatsappAccount.findFirst({ where: { agencyId } }));
      return { status: 'completed' as const, alreadyCompleted: true, attempt: this.view(attempt), account: acc ? whatsappStatusView(acc) : null };
    }
    if (['cancelled', 'expired', 'failed_permanent'].includes(attempt.status)) {
      throw new ConflictException({ code: 'signup_closed', message: 'This sign-up attempt is closed. Start a new one.', lastError: attempt.lastError });
    }
    if (attempt.expiresAt.getTime() < Date.now()) {
      await this.db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.update({ where: { id: attempt.id }, data: { status: 'expired', tokenRef: null, runStartedAt: null } }));
      throw new GoneException({ code: 'signup_expired', message: 'This sign-up attempt expired. Start again.' });
    }
    if (!(SIGNUP_FINISH_EVENTS as readonly string[]).includes(input.event.type)) {
      throw new BadRequestException({ code: 'invalid_event', message: 'Meta did not report a completed sign-up' });
    }

    // Atomic claim: only one run at a time per attempt (a stale lock from a crashed run can be taken over).
    const claimed = await this.db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.updateMany({
      where: { id: attempt.id, agencyId, OR: [{ status: { in: ['started', 'failed'] } }, { status: 'running', runStartedAt: { lt: new Date(Date.now() - RUN_LOCK_MS) } }] },
      data: { status: 'running', runStartedAt: new Date() },
    }));
    if (claimed.count !== 1) throw new ConflictException({ code: 'signup_in_progress', message: 'This sign-up is already being processed.' });

    try {
      return await this.run(agencyId, userId, attempt.id, input);
    } catch (e) {
      throw await this.fail(agencyId, attempt.id, e);
    }
  }

  private async run(agencyId: string, userId: string, attemptId: string, input: CompleteInput) {
    let a = await this.db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.findFirstOrThrow({ where: { id: attemptId, agencyId } }));
    const patch = (data: Record<string, unknown>) => this.db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.update({ where: { id: attemptId }, data: data as any }));

    // The ids the browser reports are only claims; they are checked against Meta below. A retry may not change them.
    const claimedWaba = input.event.wabaId?.trim() || undefined;
    const claimedPhone = input.event.phoneNumberId?.trim() || undefined;
    if ((a.wabaId && claimedWaba && a.wabaId !== claimedWaba) || (a.phoneNumberId && claimedPhone && a.phoneNumberId !== claimedPhone)) {
      throw new StepFailure('verify', 'signup_mismatch', 'The accounts reported now differ from the ones this attempt started with. Start a new attempt.', true);
    }
    if (!a.wabaId && !claimedWaba) throw new StepFailure('verify', 'missing_assets', 'Meta did not report a WhatsApp Business Account for this sign-up.', true);
    if (!a.wabaId || !a.phoneNumberId || !a.businessId) {
      a = await patch({ wabaId: a.wabaId ?? claimedWaba, phoneNumberId: a.phoneNumberId ?? claimedPhone ?? null, businessId: a.businessId ?? input.event.businessId?.trim() ?? null });
    }

    // 1. Exchange the one-time code on the server. The code is recorded (as a hash) BEFORE it is sent so it can never be used twice.
    if (!a.tokenRef) {
      const code = input.code?.trim();
      if (!code) throw new StepFailure('exchange', 'code_required', 'A fresh authorization code from Meta is needed. Run the Meta sign-up window again.');
      const codeHash = sha256(code);
      if (a.codeHash === codeHash) throw new StepFailure('exchange', 'code_required', 'That authorization code was already used. Run the Meta sign-up window again for a fresh one.');
      try { a = await patch({ codeHash, step: 'exchange' }); } catch (e: any) {
        if (e?.code === 'P2002') throw new StepFailure('exchange', 'code_already_used', 'That authorization code was already used. Run the Meta sign-up window again.', true, 'conflict');
        throw e;
      }
      let token: string;
      try { token = (await this.wa.exchangeSignupCode(code)).accessToken; } catch (e) {
        if (e instanceof WaSendError) throw new StepFailure('exchange', 'code_required', `${e.message}. ${hintForKind(e.kind)} Run the Meta sign-up window again for a fresh code.`);
        throw e;
      }
      a = await patch({ tokenRef: encryptSecret(token), step: 'verify' });
    }
    const token = decryptSecret(a.tokenRef!);
    const waba = a.wabaId!;

    // 2. Ownership: the token must really have access to this WABA, the number must belong to it, and no other agency may hold either.
    let phoneId = a.phoneNumberId ?? undefined;
    let listed;
    try { listed = await this.wa.listWabaPhoneNumbers({ phoneNumberId: phoneId ?? '', wabaId: waba, token }); } catch (e) { throw this.upstream('verify', e, 'Could not confirm access to the WhatsApp Business Account'); }
    if (!phoneId) {
      if (listed.length !== 1) throw new StepFailure('verify', 'phone_selection_required', 'This business account has more than one phone number (or none). Choosing a number is not supported yet.', true);
      phoneId = listed[0].id;
    } else if (!listed.some((p) => p.id === phoneId)) {
      throw new StepFailure('verify', 'asset_mismatch', 'That phone number does not belong to the business account Meta reported. Nothing was connected.', true);
    }
    const clash = await this.db.system((tx) => tx.whatsappAccount.findFirst({ where: { agencyId: { not: agencyId }, OR: [{ phoneNumberId: phoneId }, { wabaId: waba }] }, select: { id: true } }));
    if (clash) throw new StepFailure('verify', 'whatsapp_in_use', 'This WhatsApp number or business account is already connected to another agency.', true, 'conflict');
    const creds: WaAccount = { phoneNumberId: phoneId, wabaId: waba, token };
    let coex;
    try { coex = await this.wa.getCoexistenceInfo(creds); } catch (e) { throw this.upstream('verify', e, 'Could not read the number\'s WhatsApp Business app status'); }
    if (!coex.isOnBizApp) {
      // Registering a brand-new number is a separate flow that is not implemented; never register or migrate here.
      throw new StepFailure('verify', 'not_coexistence', 'This number is not linked to the WhatsApp Business app, so it cannot be connected this way. It was not registered or changed.', true);
    }
    a = await patch({ phoneNumberId: phoneId, step: 'subscribe' });

    // 3. Subscribe the app to this WABA's webhooks (idempotent), then read the number's health.
    try { await this.wa.subscribeWebhooks(creds); } catch (e) { throw this.upstream('subscribe', e, 'Could not subscribe to WhatsApp webhooks'); }
    let info;
    try { info = await this.wa.getPhoneInfo(creds); } catch (e) { throw this.upstream('subscribe', e, 'Could not read the number\'s status'); }
    a = await patch({ step: 'commit' });

    // 4. Commit atomically. An existing live connection is never overwritten (re-checked here, inside the transaction).
    const now = new Date();
    let account;
    try {
      account = await this.db.tenant(agencyId, async (tx) => {
        const existing = await tx.whatsappAccount.findFirst({ where: { agencyId } });
        if (existing && existing.connectionStatus !== 'disconnected') throw new StepFailure('commit', 'whatsapp_already_connected', 'This agency already has a WhatsApp connection. It has not been changed.', true, 'conflict');
        const data = {
          mode: 'cloud', wabaId: waba, phoneNumberId: phoneId!, displayName: input.displayName, credentialSecretRef: a.tokenRef!,
          connectionStatus: 'connected', statusReason: null, webhookSubscribed: true, subscribedAt: now, lastCheckedAt: now, lastErrorCode: null, lastErrorAt: null,
          displayPhoneNumber: info.displayPhoneNumber ?? null, verifiedName: info.verifiedName ?? null, displayNameStatus: info.displayNameStatus ?? null,
          qualityRating: info.qualityRating ?? null, messagingLimitTier: info.messagingLimitTier ?? null,
          onboardingMethod: 'embedded', isCoexistence: true, businessId: a.businessId, connectedByUserId: userId,
        };
        const acc = await tx.whatsappAccount.upsert({ where: { agencyId }, create: { agencyId, ...data }, update: data });
        await audit(tx, { agencyId, actorUserId: userId, action: 'whatsapp.connected', entityType: 'whatsapp_account', entityId: acc.id, metadata: { mode: 'cloud', method: 'embedded', coexistence: true, phoneNumberId: phoneId, wabaId: waba } });
        // The token now lives only on the account row.
        await tx.whatsappSignupAttempt.update({ where: { id: attemptId }, data: { status: 'completed', step: 'done', tokenRef: null, completedAt: now, runStartedAt: null, failedStep: null, lastError: null, lastErrorCode: null } });
        return acc;
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new StepFailure('commit', 'whatsapp_in_use', 'This WhatsApp number or business account is already connected to another agency.', true, 'conflict');
      throw e;
    }

    // 5. Best-effort follow-ups. A failure here never undoes (or re-labels) a successful connection.
    if (a.requestSync) {
      let syncStatus: 'requested' | 'failed' = 'requested';
      try {
        await this.wa.requestSmbSync(creds, 'smb_app_state_sync');
        await this.wa.requestSmbSync(creds, 'history');
      } catch (e) {
        syncStatus = 'failed';
        this.log.warn(`Contact/history sync request failed: ${e instanceof Error ? e.message : 'unknown'}`);
      }
      await patch({ syncStatus }).catch(() => undefined);
    }
    await this.accounts.syncTemplates(agencyId).catch((e) => this.log.warn(`Initial template sync failed: ${(e as Error).message}`));

    const done = await this.db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.findFirstOrThrow({ where: { id: attemptId, agencyId } }));
    return { status: 'completed' as const, alreadyCompleted: false, attempt: this.view(done), account: whatsappStatusView(account) };
  }

  /** Turns a provider error into a retryable step failure (token kept) or, for auth/account problems, one that needs attention. */
  private upstream(step: Step, e: unknown, prefix: string) {
    if (e instanceof WaSendError) return new StepFailure(step, e.kind === 'auth' ? 'whatsapp_auth_failed' : 'whatsapp_error', `${prefix}: ${e.message}. ${hintForKind(e.kind)}`);
    return e;
  }

  /** Records the failure on the attempt and returns the HTTP exception to throw. The stored token is only dropped when the failure is final. */
  private async fail(agencyId: string, attemptId: string, e: unknown) {
    const f = e instanceof StepFailure ? e : new StepFailure('commit', 'unexpected', 'Something went wrong while connecting. Nothing was changed on the existing account. You can retry.');
    if (!(e instanceof StepFailure)) this.log.error(`Embedded signup failed unexpectedly: ${e instanceof Error ? e.message : 'unknown'}`);
    // Only a run that is still "running" can be marked failed: a completed attempt is never rewritten.
    await this.db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.updateMany({
      where: { id: attemptId, agencyId, status: 'running' },
      data: { status: f.permanent ? 'failed_permanent' : 'failed', failedStep: f.step, lastErrorCode: f.code, lastError: f.message.slice(0, 400), runStartedAt: null, ...(f.permanent ? { tokenRef: null } : {}) },
    })).catch(() => undefined);
    const body = { code: f.code, message: f.message, retryable: !f.permanent, needsNewCode: f.code === 'code_required' };
    return f.http === 'conflict' ? new ConflictException(body) : new BadRequestException(body);
  }
}
