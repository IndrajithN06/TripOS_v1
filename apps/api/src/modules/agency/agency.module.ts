import {
  BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { AssetService, MAX_IMAGE_BYTES } from '../../common/assets';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { encryptSecret } from '../../common/crypto';
import { config } from '../../config/config';
import { Db } from '../../db/db.service';
import { WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';
import { InviteService } from '../auth/auth.module';
import { WhatsappAccountService } from '../whatsapp/whatsapp-account.service';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour');
const brandingSchema = z.object({
  brandColour: hex.optional(), tagline: z.string().max(160).nullable().optional(), phone: z.string().max(30).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)), website: z.string().max(200).nullable().optional(),
  address: z.string().max(400).nullable().optional(), footer: z.string().max(600).nullable().optional(), terms: z.string().max(4000).nullable().optional(),
  inclusions: z.string().max(1500).nullable().optional(), exclusions: z.string().max(1500).nullable().optional(),
});
const settingsSchema = z.object({
  salesVisibility: z.enum(['all', 'assigned']).optional(), taxEnabled: z.boolean().optional(),
  taxRatePercent: z.number().min(0).max(100).optional(), taxMode: z.enum(['exclusive', 'inclusive']).optional(),
  quoteValidityDays: z.number().int().min(1).max(90).optional(), aiEnabled: z.boolean().optional(),
});

@Roles('AGENCY_ADMIN')
@Controller('agency')
export class AgencyController {
  constructor(private readonly db: Db, private readonly invites: InviteService, private readonly assets: AssetService, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider, private readonly accounts: WhatsappAccountService) {}

  // ---- users ----
  @Get('users')
  users(@CurrentUser() p: Principal) {
    return this.db.tenant(agencyOf(p), (tx) => tx.user.findMany({ where: { agencyId: p.agencyId! }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, email: true, role: true, status: true, canOverrideRates: true, lastLoginAt: true } }));
  }

  @Post('users')
  async inviteUser(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(2).max(120), email: z.string().trim().email(), role: z.enum(['SALES', 'AGENCY_ADMIN']).default('SALES'), canOverrideRates: z.boolean().default(true) }), body);
    const agencyId = agencyOf(p);
    const r = await this.db.tenant(agencyId, async (tx) => {
      const email = b.email.toLowerCase();
      if (await this.db.system((s) => s.user.findUnique({ where: { email } }))) throw new BadRequestException({ code: 'email_taken', message: 'A user with this email already exists' });
      const agency = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
      const u = await tx.user.create({ data: { agencyId, name: b.name, email, role: b.role, canOverrideRates: b.canOverrideRates, status: 'invited' } });
      const inv = await this.invites.create(tx, u, agency.name);
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'user.invited', entityType: 'user', entityId: u.id, metadata: { role: b.role } });
      return { u, inv };
    });
    await r.inv.deliver();
    return { id: r.u.id, ...(config().isProd ? {} : { inviteUrl: r.inv.link }) };
  }

  @Patch('users/:id')
  async updateUser(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(2).max(120).optional(), status: z.enum(['active', 'disabled']).optional(), role: z.enum(['SALES', 'AGENCY_ADMIN']).optional(), canOverrideRates: z.boolean().optional() }), body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const u = await tx.user.findFirst({ where: { id, agencyId } });
      if (!u) throw new NotFoundException({ code: 'not_found', message: 'User not found' });
      if (u.id === p.userId && (b.status === 'disabled' || (b.role && b.role !== 'AGENCY_ADMIN'))) throw new BadRequestException({ code: 'self_lockout', message: 'You cannot disable or demote yourself' });
      const revoke = b.status === 'disabled' || (b.role && b.role !== u.role);
      const upd = await tx.user.update({ where: { id }, data: { ...b, status: b.status === 'active' && u.status === 'invited' ? 'invited' : b.status, ...(revoke ? { tokenVersion: { increment: 1 } } : {}) } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: b.role && b.role !== u.role ? 'user.role_changed' : 'user.updated', entityType: 'user', entityId: id, metadata: b });
      return { id: upd.id, status: upd.status, role: upd.role };
    });
  }

  /** Resend an invitation or issue a password-reset link. The user keeps access until they set a new password. */
  @Post('users/:id/reinvite')
  async reinvite(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const agencyId = agencyOf(p);
    const r = await this.db.tenant(agencyId, async (tx) => {
      const u = await tx.user.findFirst({ where: { id, agencyId } });
      if (!u) throw new NotFoundException({ code: 'not_found', message: 'User not found' });
      if (u.status === 'disabled') throw new BadRequestException({ code: 'user_disabled', message: 'Enable this user before sending an invitation' });
      const agency = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
      const inv = await this.invites.create(tx, u, agency.name);
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'user.reinvited', entityType: 'user', entityId: id });
      return inv;
    });
    await r.deliver();
    return config().isProd ? { ok: true } : { ok: true, inviteUrl: r.link };
  }

  // ---- branding ----
  @Roles('AGENCY_ADMIN', 'SALES')
  @Get('branding')
  async branding(@CurrentUser() p: Principal) {
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const b = await tx.agencyBranding.findUniqueOrThrow({ where: { agencyId } });
      const logo = b.logoAssetId ? await tx.asset.findUnique({ where: { id: b.logoAssetId } }) : null;
      const agency = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
      return { ...b, displayName: agency.name, logoUrl: logo ? await this.assets.url(logo) : null };
    });
  }

  @Patch('branding')
  async updateBranding(@CurrentUser() p: Principal, @Body() body: unknown) {
    const data = parse(brandingSchema, body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const b = await tx.agencyBranding.update({ where: { agencyId }, data });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'branding.updated', entityType: 'branding', entityId: agencyId });
      return b;
    });
  }

  @Post('branding/logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  async logo(@CurrentUser() p: Principal, @UploadedFile() file: Express.Multer.File) {
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const a = await this.assets.storeImage(tx, agencyId, p.userId, file, 'logo');
      await tx.agencyBranding.update({ where: { agencyId }, data: { logoAssetId: a.id } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'branding.logo_updated', entityType: 'asset', entityId: a.id });
      return { assetId: a.id, url: await this.assets.url(a) };
    });
  }

  // ---- settings ----
  @Get('settings')
  settings(@CurrentUser() p: Principal) {
    return this.db.tenant(agencyOf(p), async (tx) => {
      const a = await tx.agency.findUniqueOrThrow({ where: { id: p.agencyId! } });
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const ai = await tx.aiUsage.aggregate({ where: { agencyId: a.id, createdAt: { gte: monthStart } }, _count: true, _sum: { estimatedCost: true, inputTokens: true, outputTokens: true } });
      return {
        name: a.name, timezone: a.timezone, currency: a.currency, salesVisibility: a.salesVisibility, taxEnabled: a.taxEnabled,
        taxRatePercent: a.taxRatePercent.toString(), taxMode: a.taxMode, quoteValidityDays: a.quoteValidityDays, aiEnabled: a.aiEnabled,
        aiMonthlyLimit: a.aiMonthlyLimit, aiUsage: { calls: ai._count, inputTokens: ai._sum.inputTokens ?? 0, outputTokens: ai._sum.outputTokens ?? 0, estimatedCost: ai._sum.estimatedCost?.toString() ?? '0' },
      };
    });
  }

  @Patch('settings')
  async updateSettings(@CurrentUser() p: Principal, @Body() body: unknown) {
    const data = parse(settingsSchema, body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      await tx.agency.update({ where: { id: agencyId }, data });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'settings.updated', entityType: 'agency', entityId: agencyId, metadata: data });
      return { ok: true };
    });
  }

  @Get('audit')
  auditLog(@CurrentUser() p: Principal) {
    return this.db.tenant(agencyOf(p), (tx) => tx.auditLog.findMany({ where: { agencyId: p.agencyId! }, orderBy: { createdAt: 'desc' }, take: 100 }));
  }

  // ---- WhatsApp connection ----
  @Get('whatsapp')
  async whatsapp(@CurrentUser() p: Principal) {
    const a = await this.db.tenant(agencyOf(p), (tx) => tx.whatsappAccount.findFirst({ where: { agencyId: p.agencyId! } }));
    return a ? this.statusView(a) : { connected: false, providerMode: this.wa.name };
  }

  /** Never includes the credential itself, only whether one is stored. */
  private statusView(a: any) {
    return {
      connected: a.connectionStatus !== 'disconnected', mode: a.mode, simulated: a.mode === 'simulator', phoneNumberId: a.phoneNumberId, wabaId: a.wabaId, displayName: a.displayName,
      connectionStatus: a.connectionStatus, statusReason: a.statusReason, webhookSubscribed: a.webhookSubscribed, hasCredential: !!a.credentialSecretRef,
      displayPhoneNumber: a.displayPhoneNumber, verifiedName: a.verifiedName, displayNameStatus: a.displayNameStatus, qualityRating: a.qualityRating, messagingLimitTier: a.messagingLimitTier,
      subscribedAt: a.subscribedAt, lastWebhookAt: a.lastWebhookAt, lastCheckedAt: a.lastCheckedAt, lastErrorCode: a.lastErrorCode, lastErrorAt: a.lastErrorAt,
    };
  }

  @Post('whatsapp/connect')
  async connectWhatsapp(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(z.object({ displayName: z.string().trim().min(2).max(80), wabaId: z.string().trim().optional(), phoneNumberId: z.string().trim().optional(), accessToken: z.string().trim().min(10).optional() }), body);
    return this.statusView(await this.accounts.connect(agencyOf(p), p.userId, b));
  }

  /** Re-check the number's health with the provider right now. */
  @Post('whatsapp/refresh')
  async refreshWhatsapp(@CurrentUser() p: Principal) { return this.statusView(await this.accounts.refreshHealth(agencyOf(p))); }

  @Post('whatsapp/disconnect')
  disconnectWhatsapp(@CurrentUser() p: Principal) { return this.accounts.disconnect(agencyOf(p), p.userId); }

  @Post('whatsapp/templates/sync')
  syncTemplates(@CurrentUser() p: Principal) { return this.accounts.syncTemplates(agencyOf(p)); }

  // Template list/create/update/duplicate/delete/preview/submit: see modules/templates/templates.controller.ts
}

export const AGENCY_PROVIDERS = [];
