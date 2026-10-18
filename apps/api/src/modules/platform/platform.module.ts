import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { config } from '../../config/config';
import { Db } from '../../db/db.service';
import { InviteService } from '../auth/auth.module';

const slug = z.string().min(2).max(40).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and hyphens only');
const createSchema = z.object({
  name: z.string().min(2).max(120), legalName: z.string().max(200).optional(), slug,
  adminName: z.string().min(2).max(120), adminEmail: z.string().trim().email(),
  plan: z.string().max(40).default('standard'), aiMonthlyLimit: z.number().int().min(0).max(1_000_000).default(200),
  timezone: z.string().default('Asia/Kolkata'),
});
const patchSchema = z.object({
  status: z.enum(['active', 'suspended']).optional(), name: z.string().min(2).max(120).optional(),
  aiEnabled: z.boolean().optional(), aiMonthlyLimit: z.number().int().min(0).optional(), plan: z.string().max(40).optional(),
});

export const AI_KILL_KEY = 'ai_kill_switch';

@Injectable()
export class PlatformService {
  constructor(private readonly db: Db, private readonly invites: InviteService) {}

  async create(p: Principal, input: z.infer<typeof createSchema>) {
    const email = input.adminEmail.toLowerCase();
    const result = await this.db.system(async (tx) => {
      if (await tx.user.findUnique({ where: { email } })) throw new BadRequestException({ code: 'email_taken', message: 'A user with this email already exists' });
      const agency = await tx.agency.create({ data: { name: input.name, legalName: input.legalName, slug: input.slug, plan: input.plan, aiMonthlyLimit: input.aiMonthlyLimit, timezone: input.timezone } });
      await tx.agencyBranding.create({ data: { agencyId: agency.id } });
      const admin = await tx.user.create({ data: { agencyId: agency.id, name: input.adminName, email, role: 'AGENCY_ADMIN', status: 'invited' } });
      const inv = await this.invites.create(tx, admin, agency.name);
      await audit(tx, { agencyId: agency.id, actorUserId: p.userId, action: 'platform.agency_created', entityType: 'agency', entityId: agency.id, metadata: { slug: input.slug, adminEmail: email } });
      return { agency, admin, inv };
    });
    await result.inv.deliver();
    // The invite link is only echoed outside production, to make local onboarding easy.
    return { id: result.agency.id, slug: result.agency.slug, status: result.agency.status, adminUserId: result.admin.id, ...(config().isProd ? {} : { inviteUrl: result.inv.link }) };
  }

  async list(q: { search?: string; status?: string }) {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    return this.db.system(async (tx) => {
      const agencies = await tx.agency.findMany({
        where: { status: q.status || undefined, OR: q.search ? [{ name: { contains: q.search, mode: 'insensitive' } }, { slug: { contains: q.search, mode: 'insensitive' } }] : undefined },
        orderBy: { createdAt: 'desc' }, take: 200,
      });
      return Promise.all(agencies.map(async (a) => {
        const [users, conversations, quotes, aiCalls, failedJobs] = await Promise.all([
          tx.user.count({ where: { agencyId: a.id } }), tx.conversation.count({ where: { agencyId: a.id } }), tx.quote.count({ where: { agencyId: a.id, deletedAt: null } }),
          tx.aiUsage.count({ where: { agencyId: a.id, createdAt: { gte: monthStart } } }), tx.job.count({ where: { agencyId: a.id, status: 'failed' } }),
        ]);
        return { id: a.id, name: a.name, slug: a.slug, status: a.status, plan: a.plan, aiEnabled: a.aiEnabled, aiMonthlyLimit: a.aiMonthlyLimit, createdAt: a.createdAt, usage: { users, conversations, quotes, aiCalls, failedJobs } };
      }));
    });
  }

  async update(p: Principal, id: string, patch: z.infer<typeof patchSchema>) {
    return this.db.system(async (tx) => {
      const existing = await tx.agency.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException({ code: 'not_found', message: 'Agency not found' });
      const a = await tx.agency.update({ where: { id }, data: patch });
      if (patch.status && patch.status !== existing.status) {
        // Suspension takes effect immediately: the auth guard re-checks the agency on every request.
        await audit(tx, { agencyId: id, actorUserId: p.userId, action: patch.status === 'suspended' ? 'platform.agency_suspended' : 'platform.agency_reactivated', entityType: 'agency', entityId: id });
      } else await audit(tx, { agencyId: id, actorUserId: p.userId, action: 'platform.agency_updated', entityType: 'agency', entityId: id, metadata: patch });
      return { id: a.id, status: a.status };
    });
  }

  async reinviteAdmin(p: Principal, id: string) {
    const r = await this.db.system(async (tx) => {
      const admin = await tx.user.findFirst({ where: { agencyId: id, role: 'AGENCY_ADMIN' }, orderBy: { createdAt: 'asc' } });
      const agency = await tx.agency.findUnique({ where: { id } });
      if (!admin || !agency) throw new NotFoundException({ code: 'not_found', message: 'Agency admin not found' });
      await tx.user.update({ where: { id: admin.id }, data: { tokenVersion: { increment: 1 } } });
      const inv = await this.invites.create(tx, admin, agency.name);
      await audit(tx, { agencyId: id, actorUserId: p.userId, action: 'platform.admin_reinvited', entityType: 'user', entityId: admin.id });
      return inv;
    });
    await r.deliver();
    return config().isProd ? { ok: true } : { ok: true, inviteUrl: r.link };
  }

  async grantSupport(p: Principal, agencyId: string, reason: string, minutes: number) {
    return this.db.system(async (tx) => {
      if (!(await tx.agency.findUnique({ where: { id: agencyId } }))) throw new NotFoundException({ code: 'not_found', message: 'Agency not found' });
      const g = await tx.supportAccessGrant.create({ data: { superAdminId: p.userId, agencyId, reason, expiresAt: new Date(Date.now() + minutes * 60000) } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'platform.support_access_granted', entityType: 'agency', entityId: agencyId, metadata: { reason, minutes } });
      return { grantId: g.id, expiresAt: g.expiresAt };
    });
  }

  /** Cross-tenant read of conversation metadata: only with a live, audited grant. */
  async supportConversations(p: Principal, agencyId: string) {
    return this.db.system(async (tx) => {
      const g = await tx.supportAccessGrant.findFirst({ where: { superAdminId: p.userId, agencyId, expiresAt: { gt: new Date() } } });
      if (!g) throw new ForbiddenException({ code: 'no_support_grant', message: 'No active support access grant for this agency' });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'platform.support_conversations_viewed', entityType: 'agency', entityId: agencyId, metadata: { grantId: g.id } });
      return tx.conversation.findMany({ where: { agencyId }, orderBy: { lastMessageAt: 'desc' }, take: 50, select: { id: true, status: true, lastMessageAt: true, unreadCount: true } });
    });
  }

  async getSettings() {
    const s = await this.db.system((tx) => tx.platformSetting.findUnique({ where: { key: AI_KILL_KEY } }));
    return { aiKillSwitch: (s?.value as any)?.on === true };
  }
  async setAiKill(p: Principal, on: boolean) {
    await this.db.system(async (tx) => {
      await tx.platformSetting.upsert({ where: { key: AI_KILL_KEY }, create: { key: AI_KILL_KEY, value: { on } }, update: { value: { on } } });
      await audit(tx, { agencyId: null, actorUserId: p.userId, action: 'platform.ai_kill_switch', entityType: 'platform', metadata: { on } });
    });
    return { aiKillSwitch: on };
  }

  async errors() {
    return this.db.system((tx) => tx.job.findMany({ where: { status: 'failed' }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, agencyId: true, type: true, attempts: true, lastError: true, createdAt: true } }));
  }
}

@Roles('SUPER_ADMIN')
@Controller('platform')
export class PlatformController {
  constructor(private readonly svc: PlatformService) {}

  @Post('agencies') create(@CurrentUser() p: Principal, @Body() b: unknown) { return this.svc.create(p, parse(createSchema, b)); }
  @Get('agencies') list(@Query('search') search?: string, @Query('status') status?: string) { return this.svc.list({ search, status }); }
  @Patch('agencies/:id') update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.update(p, id, parse(patchSchema, b)); }
  @Post('agencies/:id/reinvite-admin') reinvite(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.reinviteAdmin(p, id); }
  @Post('support-access') grant(@CurrentUser() p: Principal, @Body() b: unknown) {
    const i = parse(z.object({ agencyId: z.string().uuid(), reason: z.string().min(10).max(500), minutes: z.number().int().min(5).max(60) }), b);
    return this.svc.grantSupport(p, i.agencyId, i.reason, i.minutes);
  }
  @Get('support/:id/conversations') supportConvs(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.supportConversations(p, id); }
  @Get('settings') settings() { return this.svc.getSettings(); }
  @Patch('settings') setSettings(@CurrentUser() p: Principal, @Body() b: unknown) { return this.svc.setAiKill(p, parse(z.object({ aiKillSwitch: z.boolean() }), b).aiKillSwitch); }
  @Get('errors') errors() { return this.svc.errors(); }
}
