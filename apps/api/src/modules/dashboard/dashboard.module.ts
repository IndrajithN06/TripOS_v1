import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { Db } from '../../db/db.service';

@Injectable()
export class DashboardService {
  constructor(private readonly db: Db) {}

  /**
   * Definitions (docs/PRODUCT_REQUIREMENTS.md §Dashboard):
   *  - quotesCreated counts PARENT quotes created in range; versionsCreated is reported separately.
   *  - pipelineValue sums the CURRENT version total of open (sent/negotiating, unexpired) quotes only.
   *  - acceptedQuotes counts quotes whose manual status change to "accepted" happened in range.
   */
  async get(p: Principal, agencyId: string, from: Date, to: Date) {
    const now = new Date();
    const mine = p.role === 'SALES';
    return this.db.tenant(agencyId, async (tx) => {
      const agency = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
      const limitedConv: any = mine && agency.salesVisibility === 'assigned' ? { assignedUserId: p.userId } : {};
      const quoteScope: any = { deletedAt: null, ...(mine ? { ownerUserId: p.userId } : {}) }; // deleted quotes never count
      const deletedIds = (await tx.quote.findMany({ where: { agencyId, deletedAt: { not: null } }, select: { id: true } })).map((d) => d.id);
      const liveVersion: any = deletedIds.length ? { quoteId: { notIn: deletedIds } } : {};
      const open = { status: { in: ['sent', 'negotiating'] }, OR: [{ expiryAt: null }, { expiryAt: { gt: now } }] };

      const [newEnquiries, openConversations, quotesCreated, versionsCreated, awaiting, followUpsDue, openQuotes, acceptedLogs, failedVersions, failedMessages, activity] = await Promise.all([
        tx.conversation.count({ where: { agencyId, ...limitedConv, createdAt: { gte: from, lte: to } } }),
        tx.conversation.count({ where: { agencyId, ...limitedConv, status: { not: 'closed' } } }),
        tx.quote.count({ where: { agencyId, ...quoteScope, createdAt: { gte: from, lte: to } } }),
        tx.quoteVersion.count({ where: { agencyId, ...liveVersion, ...(mine ? { createdById: p.userId } : {}), createdAt: { gte: from, lte: to } } }),
        tx.quote.count({ where: { agencyId, ...quoteScope, ...open } }),
        tx.quote.count({ where: { agencyId, ...quoteScope, ...open, followUpAt: { lte: now } } }),
        tx.quote.findMany({ where: { agencyId, ...quoteScope, ...open }, select: { currentVersionId: true } }),
        tx.auditLog.findMany({ where: { agencyId, action: 'quote.status_changed', createdAt: { gte: from, lte: to }, metadata: { path: ['to'], equals: 'accepted' }, ...(deletedIds.length ? { entityId: { notIn: deletedIds } } : {}) }, select: { entityId: true } }),
        tx.quoteVersion.count({ where: { agencyId, ...liveVersion, status: { in: ['failed', 'partially_sent'] }, createdAt: { gte: from, lte: to } } }),
        // Unresolved only: a failed message stops counting once a later outbound message in the same chat was accepted.
        tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int n FROM "Message" m WHERE m."agencyId" = ${agencyId}::uuid AND m.direction = 'outbound' AND m.status = 'failed' AND m."createdAt" >= ${from} AND m."createdAt" <= ${to} AND NOT EXISTS (SELECT 1 FROM "Message" r WHERE r."conversationId" = m."conversationId" AND r.direction = 'outbound' AND r.status <> 'failed' AND r."createdAt" > m."createdAt")`.then((r) => r[0].n),
        mine ? Promise.resolve([]) : tx.auditLog.findMany({ where: { agencyId }, orderBy: { createdAt: 'desc' }, take: 12 }),
      ]);
      const versions = await tx.quoteVersion.findMany({ where: { id: { in: openQuotes.map((q) => q.currentVersionId!).filter(Boolean) } }, select: { total: true } });
      const pipeline = versions.reduce((a, v) => a.plus(v.total), new Decimal(0));
      const acceptedMine = mine && acceptedLogs.length ? await tx.quote.count({ where: { agencyId, id: { in: acceptedLogs.map((l) => l.entityId!) }, ownerUserId: p.userId } }) : acceptedLogs.length;
      return {
        range: { from, to },
        metrics: {
          newEnquiries, openConversations, quotesCreated, versionsCreated, quotesAwaitingResponse: awaiting, followUpsDue,
          acceptedQuotes: mine ? acceptedMine : new Set(acceptedLogs.map((l) => l.entityId)).size,
          pipelineValue: mine ? null : pipeline.toFixed(2),
        },
        alerts: { failedQuoteSends: failedVersions, failedMessages },
        activity: activity.map((a) => ({ id: a.id, action: a.action, entityType: a.entityType, entityId: a.entityId, createdAt: a.createdAt })),
        scope: mine ? 'limited' : 'full',
      };
    });
  }
}

@Roles('AGENCY_ADMIN', 'SALES')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get()
  get(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const f = parse(z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }), q);
    const to = f.to ? new Date(f.to) : new Date();
    const from = f.from ? new Date(f.from) : new Date(to.getTime() - 30 * 86400000);
    return this.svc.get(p, agencyOf(p), from, to);
  }
}
