import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { Db } from '../../db/db.service';

const SAFE_TZ = /[^A-Za-z_/+-]/g;

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  /**
   * Analytics for the visual dashboard. Same definitions as DashboardService.get(); series are bucketed by day in
   * the agency timezone. Sales users see only their own quotes (and assigned chats if the agency restricts), with
   * no pipeline value. All queries run inside the tenant transaction, so RLS applies on top of the explicit filters.
   */
  async analytics(p: Principal, agencyId: string, from: Date, to: Date) {
    const mine = p.role === 'SALES';
    const spanMs = Math.max(86400000, to.getTime() - from.getTime());
    const prevFrom = new Date(from.getTime() - spanMs), prevTo = new Date(from.getTime());

    return this.db.tenant(agencyId, async (tx) => {
      const agency = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
      const tz = agency.timezone;
      const tzSql = tz.replace(SAFE_TZ, '');
      // Every Quote query below uses alias q and ownQ, so this one clause keeps soft-deleted quotes out of all of them.
      const ownQ = mine ? Prisma.sql`AND q."deletedAt" IS NULL AND q."ownerUserId" = ${p.userId}::uuid` : Prisma.sql`AND q."deletedAt" IS NULL`;
      const notDeletedAudit = Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "Quote" dq WHERE dq.id::text = a."entityId" AND dq."deletedAt" IS NOT NULL)`;
      const liveAttempts = Prisma.sql`AND a."quoteVersionId" IN (SELECT dv.id FROM "QuoteVersion" dv JOIN "Quote" dq ON dq.id = dv."quoteId" WHERE dq."deletedAt" IS NULL)`;
      const ownC = mine && agency.salesVisibility === 'assigned' ? Prisma.sql`AND c."assignedUserId" = ${p.userId}::uuid` : Prisma.empty;
      // Columns are timestamp-without-tz holding UTC: tag as UTC, then express in the agency's wall clock.
      const local = (alias: string, col: string) => Prisma.raw(`(${alias}."${col}" AT TIME ZONE 'UTC') AT TIME ZONE '${tzSql}'`);
      const day = (alias: string, col: string) => Prisma.sql`to_char(date_trunc('day', ${local(alias, col)}), 'YYYY-MM-DD')`;

      const [enq, created, sentFirst, acc, heat, vehicles, statuses, resp, attempts, prev, cohort] = await Promise.all([
        tx.$queryRaw<{ d: string; n: number }[]>`SELECT ${day('c', 'createdAt')} d, count(*)::int n FROM "Conversation" c WHERE c."agencyId" = ${agencyId}::uuid AND c."createdAt" >= ${from} AND c."createdAt" <= ${to} ${ownC} GROUP BY 1`,
        tx.$queryRaw<{ d: string; n: number }[]>`SELECT ${day('q', 'createdAt')} d, count(*)::int n FROM "Quote" q WHERE q."agencyId" = ${agencyId}::uuid AND q."createdAt" >= ${from} AND q."createdAt" <= ${to} ${ownQ} GROUP BY 1`,
        tx.$queryRaw<{ d: string; n: number }[]>`SELECT ${day('t', 's')} d, count(*)::int n FROM (SELECT v."quoteId", min(v."sentAt") AS s FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE v."agencyId" = ${agencyId}::uuid AND v."sentAt" IS NOT NULL ${ownQ} GROUP BY 1) t WHERE t.s >= ${from} AND t.s <= ${to} GROUP BY 1`,
        tx.$queryRaw<{ d: string; n: number }[]>`SELECT ${day('a', 'createdAt')} d, count(DISTINCT a."entityId")::int n FROM "AuditLog" a WHERE a."agencyId" = ${agencyId}::uuid AND a.action = 'quote.status_changed' AND a.metadata->>'to' = 'accepted' ${notDeletedAudit} AND a."createdAt" >= ${from} AND a."createdAt" <= ${to} GROUP BY 1`,
        tx.$queryRaw<{ dow: number; hr: number; n: number }[]>`SELECT extract(dow FROM ${local('m', 'createdAt')})::int dow, extract(hour FROM ${local('m', 'createdAt')})::int hr, count(*)::int n FROM "Message" m WHERE m."agencyId" = ${agencyId}::uuid AND m.direction = 'inbound' AND m."createdAt" >= ${from} AND m."createdAt" <= ${to} GROUP BY 1, 2`,
        tx.$queryRaw<{ name: string; n: number; value: string }[]>`SELECT v."vehicleName" name, count(*)::int n, sum(v.total)::text value FROM "Quote" q JOIN "QuoteVersion" v ON v.id = q."currentVersionId" WHERE q."agencyId" = ${agencyId}::uuid AND q."createdAt" >= ${from} AND q."createdAt" <= ${to} ${ownQ} GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 6`,
        tx.$queryRaw<{ status: string; n: number }[]>`SELECT q.status, count(*)::int n FROM "Quote" q WHERE q."agencyId" = ${agencyId}::uuid AND q."createdAt" >= ${from} AND q."createdAt" <= ${to} ${ownQ} GROUP BY 1`,
        tx.$queryRaw<{ secs: number }[]>`SELECT extract(epoch FROM (o.t - i.t))::float secs FROM (SELECT "conversationId", min("createdAt") t FROM "Message" WHERE "agencyId" = ${agencyId}::uuid AND direction = 'inbound' GROUP BY 1) i JOIN (SELECT "conversationId", min("createdAt") t FROM "Message" WHERE "agencyId" = ${agencyId}::uuid AND direction = 'outbound' GROUP BY 1) o USING ("conversationId") JOIN "Conversation" c ON c.id = i."conversationId" WHERE o.t > i.t AND c."createdAt" >= ${from} AND c."createdAt" <= ${to} ${ownC}`,
        tx.$queryRaw<{ status: string; n: number }[]>`SELECT a.status, count(*)::int n FROM "QuoteSendAttempt" a WHERE a."agencyId" = ${agencyId}::uuid ${liveAttempts} AND a."createdAt" >= ${from} AND a."createdAt" <= ${to} GROUP BY 1`,
        tx.$queryRaw<{ enq: number; qs: number; acc: number; avg: string | null }[]>`SELECT
          (SELECT count(*)::int FROM "Conversation" c WHERE c."agencyId" = ${agencyId}::uuid AND c."createdAt" >= ${prevFrom} AND c."createdAt" < ${prevTo} ${ownC}) enq,
          (SELECT count(*)::int FROM "Quote" q WHERE q."agencyId" = ${agencyId}::uuid AND q."createdAt" >= ${prevFrom} AND q."createdAt" < ${prevTo} ${ownQ}) qs,
          (SELECT count(DISTINCT a."entityId")::int FROM "AuditLog" a WHERE a."agencyId" = ${agencyId}::uuid AND a.action = 'quote.status_changed' AND a.metadata->>'to' = 'accepted' ${notDeletedAudit} AND a."createdAt" >= ${prevFrom} AND a."createdAt" < ${prevTo}) acc,
          (SELECT avg(v.total)::text FROM "Quote" q JOIN "QuoteVersion" v ON v.id = q."currentVersionId" WHERE q."agencyId" = ${agencyId}::uuid AND q."createdAt" >= ${prevFrom} AND q."createdAt" < ${prevTo} ${ownQ}) avg`,
        tx.$queryRaw<{ created: number; sent: number; accepted: number; value: string | null; avg: string | null }[]>`SELECT count(*)::int created,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "QuoteVersion" v WHERE v."quoteId" = q.id AND v."sentAt" IS NOT NULL))::int sent,
          count(*) FILTER (WHERE q.status = 'accepted')::int accepted, (sum(cv.total) FILTER (WHERE q.status = 'accepted'))::text value, avg(cv.total)::text avg
          FROM "Quote" q JOIN "QuoteVersion" cv ON cv.id = q."currentVersionId" WHERE q."agencyId" = ${agencyId}::uuid AND q."createdAt" >= ${from} AND q."createdAt" <= ${to} ${ownQ}`,
      ]);

      // Continuous day axis in the agency timezone (capped at 120 days) so empty days render as zero.
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const keys: string[] = [];
      for (let t = from.getTime(); t <= to.getTime() + 86400000 && keys.length < 120; t += 86400000) {
        const k = fmt.format(new Date(t));
        if (!keys.includes(k)) keys.push(k);
      }
      const lastKey = fmt.format(to);
      if (!keys.includes(lastKey)) keys.push(lastKey);
      const toMap = (rows: { d: string; n: number }[]) => new Map(rows.map((r) => [r.d, r.n]));
      const [mE, mC, mS, mA] = [toMap(enq), toMap(created), toMap(sentFirst), toMap(acc)];
      const series = keys.map((d) => ({ date: d, enquiries: mE.get(d) ?? 0, quotesCreated: mC.get(d) ?? 0, quotesSent: mS.get(d) ?? 0, accepted: mA.get(d) ?? 0 }));

      const heatmap = Array.from({ length: 7 }, (_, dow) => Array.from({ length: 24 }, (_, hr) => heat.find((h) => h.dow === dow && h.hr === hr)?.n ?? 0));
      const secs = resp.map((r) => r.secs).sort((a, b) => a - b);
      const median = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2) : null;
      const sentOk = attempts.find((a) => a.status === 'sent')?.n ?? 0;
      const sentAll = attempts.reduce((a, r) => a + r.n, 0);
      const c = cohort[0], pv = prev[0];
      const enquiryTotal = series.reduce((a, r) => a + r.enquiries, 0);

      const openRows = await tx.quote.findMany({
        where: { agencyId, deletedAt: null, ...(mine ? { ownerUserId: p.userId } : {}), status: { in: ['sent', 'negotiating'] }, OR: [{ expiryAt: null }, { expiryAt: { gt: new Date() } }] },
        select: { status: true, currentVersionId: true },
      });
      const vers = await tx.quoteVersion.findMany({ where: { id: { in: openRows.map((o) => o.currentVersionId!).filter(Boolean) } }, select: { id: true, total: true } });
      const openValue = (s: string) => openRows.filter((o) => o.status === s).reduce((a, o) => a.plus(vers.find((v) => v.id === o.currentVersionId)?.total ?? 0), new Decimal(0));

      return {
        range: { from, to, previousFrom: prevFrom, previousTo: prevTo },
        timezone: tz,
        scope: mine ? 'limited' : 'full',
        kpis: {
          pipelineValue: mine ? null : openValue('sent').plus(openValue('negotiating')).toFixed(2),
          pipelineBreakdown: mine ? null : { sent: openValue('sent').toFixed(2), negotiating: openValue('negotiating').toFixed(2) },
          acceptedValue: c.value ? new Decimal(c.value).toFixed(2) : '0.00',
          avgQuoteValue: c.avg ? new Decimal(c.avg).toFixed(2) : null,
          previousAvgQuoteValue: pv.avg ? new Decimal(pv.avg).toFixed(2) : null,
          enquiries: enquiryTotal, previousEnquiries: pv.enq,
          quotesCreated: c.created, previousQuotesCreated: pv.qs,
          accepted: c.accepted, previousAccepted: pv.acc,
          conversionRate: c.sent ? Math.round((c.accepted / c.sent) * 1000) / 10 : null,
          medianFirstResponseSeconds: median === null ? null : Math.round(median),
          deliverySuccessRate: sentAll ? Math.round((sentOk / sentAll) * 1000) / 10 : null,
        },
        series,
        funnel: [
          { stage: 'Enquiries', value: enquiryTotal }, { stage: 'Quotes created', value: c.created },
          { stage: 'Quotes sent', value: c.sent }, { stage: 'Accepted', value: c.accepted },
        ],
        statusBreakdown: statuses.map((s) => ({ status: s.status, count: s.n })),
        topVehicles: vehicles.map((v) => ({ name: v.name, quotes: v.n, value: new Decimal(v.value).toFixed(2) })),
        heatmap,
      };
    });
  }
}

@Roles('AGENCY_ADMIN', 'SALES')
@Controller('dashboard/analytics')
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get()
  get(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const f = parse(z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }), q);
    const to = f.to ? new Date(f.to) : new Date();
    const from = f.from ? new Date(f.from) : new Date(to.getTime() - 30 * 86400000);
    return this.svc.analytics(p, agencyOf(p), from, to);
  }
}
