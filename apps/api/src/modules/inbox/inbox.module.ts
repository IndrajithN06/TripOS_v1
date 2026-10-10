import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { AssetService } from '../../common/assets';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { Db, Tx } from '../../db/db.service';
import { AiService } from '../ai/ai.service';
import { OutboundService, SERVICE_WINDOW_MS } from './outbound.service';

@Injectable()
export class InboxService {
  constructor(private readonly db: Db, private readonly assets: AssetService) {}

  /** Visibility policy: Sales see all agency conversations, or only their assigned ones, per agency setting. */
  async scope(tx: Tx, p: Principal, agencyId: string) {
    if (p.role !== 'SALES') return {};
    const a = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
    return a.salesVisibility === 'assigned' ? { assignedUserId: p.userId } : {};
  }

  async getConversation(tx: Tx, p: Principal, agencyId: string, id: string) {
    const c = await tx.conversation.findFirst({ where: { id, agencyId, ...(await this.scope(tx, p, agencyId)) } });
    if (!c) throw new NotFoundException({ code: 'not_found', message: 'Conversation not found' });
    return c;
  }

  async list(p: Principal, agencyId: string, q: { search?: string; filter?: string; page: number; pageSize: number }) {
    return this.db.tenant(agencyId, async (tx) => {
      const where: any = { agencyId, ...(await this.scope(tx, p, agencyId)) };
      if (q.filter === 'unread') where.unreadCount = { gt: 0 };
      if (q.filter === 'mine') where.assignedUserId = p.userId;
      if (q.filter === 'unassigned') where.assignedUserId = null;
      if (q.filter === 'open') where.status = { not: 'closed' };
      if (q.filter === 'closed') where.status = 'closed';
      if (q.filter === 'quoted') {
        const quoted = await tx.quote.findMany({ where: { agencyId, conversationId: { not: null } }, select: { conversationId: true } });
        where.id = { in: quoted.map((x) => x.conversationId!) };
      }
      if (q.search) {
        const custs = await tx.customer.findMany({ where: { agencyId, OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { phoneE164: { contains: q.search } }] }, select: { id: true } });
        const msgs = await tx.message.findMany({ where: { agencyId, text: { contains: q.search, mode: 'insensitive' } }, select: { conversationId: true }, take: 200 });
        where.OR = [{ customerId: { in: custs.map((c) => c.id) } }, { id: { in: msgs.map((m) => m.conversationId) } }];
      }
      const [total, rows] = await Promise.all([tx.conversation.count({ where }), tx.conversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
      const ids = rows.map((r) => r.id);
      const [customers, users, lastMsgs, quotes] = await Promise.all([
        tx.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) } } }),
        tx.user.findMany({ where: { id: { in: rows.map((r) => r.assignedUserId).filter(Boolean) as string[] } }, select: { id: true, name: true } }),
        Promise.all(ids.map((id) => tx.message.findFirst({ where: { conversationId: id, agencyId }, orderBy: { createdAt: 'desc' } }))),
        tx.quote.findMany({ where: { agencyId, conversationId: { in: ids } }, orderBy: { createdAt: 'desc' }, select: { conversationId: true, status: true, quoteNumber: true } }),
      ]);
      return {
        total, page: q.page, pageSize: q.pageSize,
        items: rows.map((r, i) => ({
          id: r.id, status: r.status, unreadCount: r.unreadCount, lastMessageAt: r.lastMessageAt, customer: customers.find((c) => c.id === r.customerId) && { id: r.customerId, name: customers.find((c) => c.id === r.customerId)!.name, phone: customers.find((c) => c.id === r.customerId)!.phoneE164 },
          assignedUser: users.find((u) => u.id === r.assignedUserId) ?? null, preview: lastMsgs[i]?.text?.slice(0, 80) ?? (lastMsgs[i] ? `[${lastMsgs[i]!.type}]` : ''),
          lastQuote: quotes.find((x) => x.conversationId === r.id) ?? null,
        })),
      };
    });
  }

  async detail(p: Principal, agencyId: string, id: string) {
    return this.db.tenant(agencyId, async (tx) => {
      const c = await this.getConversation(tx, p, agencyId, id);
      const [customer, notes, quotes, assignee] = await Promise.all([
        tx.customer.findFirstOrThrow({ where: { id: c.customerId, agencyId } }),
        tx.conversationNote.findMany({ where: { agencyId, conversationId: id }, orderBy: { createdAt: 'asc' } }),
        tx.quote.findMany({ where: { agencyId, conversationId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, quoteNumber: true, status: true, currentVersionId: true } }),
        c.assignedUserId ? tx.user.findFirst({ where: { id: c.assignedUserId }, select: { id: true, name: true } }) : null,
      ]);
      const authors = await tx.user.findMany({ where: { id: { in: notes.map((n) => n.authorId) } }, select: { id: true, name: true } });
      const windowOpen = !!c.lastInboundAt && Date.now() - c.lastInboundAt.getTime() < SERVICE_WINDOW_MS;
      return {
        id: c.id, status: c.status, unreadCount: c.unreadCount, summary: c.summary, summaryAt: c.summaryAt, windowOpen,
        windowExpiresAt: c.lastInboundAt ? new Date(c.lastInboundAt.getTime() + SERVICE_WINDOW_MS) : null,
        customer: { id: customer.id, name: customer.name, phone: customer.phoneE164, email: customer.email, notes: customer.notes }, assignedUser: assignee,
        notes: notes.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt, author: authors.find((a) => a.id === n.authorId)?.name ?? 'Unknown' })), quotes,
      };
    });
  }

  async messages(p: Principal, agencyId: string, id: string, q: { before?: string; limit: number }) {
    return this.db.tenant(agencyId, async (tx) => {
      await this.getConversation(tx, p, agencyId, id);
      const rows = await tx.message.findMany({ where: { agencyId, conversationId: id, ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) }, orderBy: { createdAt: 'desc' }, take: q.limit });
      const assetIds = rows.map((r) => r.mediaAssetId).filter(Boolean) as string[];
      const assets = await tx.asset.findMany({ where: { agencyId, id: { in: assetIds } } });
      const links = await tx.quoteSendAttempt.findMany({ where: { agencyId, messageId: { in: rows.map((r) => r.id) } } });
      const versions = await tx.quoteVersion.findMany({ where: { agencyId, id: { in: links.map((l) => l.quoteVersionId) } }, select: { id: true, versionNumber: true, quoteId: true } });
      const quotes = await tx.quote.findMany({ where: { agencyId, id: { in: versions.map((v) => v.quoteId) } }, select: { id: true, quoteNumber: true } });
      const items = await Promise.all(rows.reverse().map(async (m) => {
        const a = assets.find((x) => x.id === m.mediaAssetId);
        const link = links.find((l) => l.messageId === m.id);
        const ver = versions.find((v) => v.id === link?.quoteVersionId);
        return {
          id: m.id, providerMessageId: m.simulated ? m.providerMessageId : undefined, direction: m.direction, type: m.type, text: m.text, status: m.status, errorCode: m.errorCode, errorMessage: m.errorMessage, simulated: m.simulated, createdAt: m.createdAt,
          media: a ? { assetId: a.id, mimeType: a.mimeType, url: await this.assets.url(a) } : null,
          quote: ver ? { quoteId: ver.quoteId, quoteNumber: quotes.find((q2) => q2.id === ver.quoteId)?.quoteNumber, version: ver.versionNumber } : null,
        };
      }));
      return { items, hasMore: rows.length === q.limit };
    });
  }
}

const sendSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(4000), idempotencyKey: z.string().max(100).optional() }),
  z.object({ type: z.literal('template'), templateId: z.string().uuid(), variables: z.array(z.string().max(200)).max(10).default([]), idempotencyKey: z.string().max(100).optional() }),
]);

@Roles('AGENCY_ADMIN', 'SALES')
@Controller('inbox/conversations')
export class InboxController {
  constructor(private readonly svc: InboxService, private readonly db: Db, private readonly outbound: OutboundService, private readonly ai: AiService) {}

  @Get()
  list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    return this.svc.list(p, agencyOf(p), parse(z.object({ search: z.string().max(100).optional(), filter: z.enum(['all', 'unread', 'mine', 'unassigned', 'open', 'closed', 'quoted']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) }), q));
  }

  @Get(':id') detail(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.detail(p, agencyOf(p), id); }

  @Get(':id/messages')
  messages(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query() q: Record<string, string>) {
    return this.svc.messages(p, agencyOf(p), id, parse(z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), q));
  }

  @Post(':id/read')
  async read(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const agencyId = agencyOf(p);
    await this.db.tenant(agencyId, async (tx) => { await this.svc.getConversation(tx, p, agencyId, id); await tx.conversation.update({ where: { id }, data: { unreadCount: 0 } }); });
    return { ok: true };
  }

  @Post(':id/messages')
  async send(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(sendSchema, body);
    const agencyId = agencyOf(p);
    await this.db.tenant(agencyId, (tx) => this.svc.getConversation(tx, p, agencyId, id));
    return this.outbound.send(agencyId, id, b.type === 'text' ? { kind: 'text', text: b.text } : { kind: 'template', templateId: b.templateId, variables: b.variables }, { userId: p.userId, idempotencyKey: b.idempotencyKey });
  }

  @Post(':id/messages/:messageId/retry')
  async retry(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('messageId', ParseUUIDPipe) messageId: string) {
    const agencyId = agencyOf(p);
    const m = await this.db.tenant(agencyId, async (tx) => {
      await this.svc.getConversation(tx, p, agencyId, id);
      const msg = await tx.message.findFirst({ where: { id: messageId, agencyId, conversationId: id, direction: 'outbound' } });
      if (!msg) throw new NotFoundException({ code: 'not_found', message: 'Message not found' });
      if (msg.status !== 'failed') throw new BadRequestException({ code: 'not_failed', message: 'Only failed messages can be retried' });
      if (msg.type !== 'text' || !msg.text) throw new BadRequestException({ code: 'not_retryable', message: 'Only text messages can be retried from the thread; retry quote items from the quote.' });
      return msg;
    });
    return this.outbound.send(agencyId, id, { kind: 'text', text: m.text! }, { userId: p.userId, idempotencyKey: `retry:${m.id}:${Date.now()}` });
  }

  @Post(':id/notes')
  async note(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { text } = parse(z.object({ text: z.string().min(1).max(2000) }), body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      await this.svc.getConversation(tx, p, agencyId, id);
      const n = await tx.conversationNote.create({ data: { agencyId, conversationId: id, authorId: p.userId, text } });
      return { id: n.id };
    });
  }

  @Patch(':id')
  async update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ assignedUserId: z.string().uuid().nullable().optional(), status: z.enum(['open', 'pending', 'closed']).optional() }), body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      await this.svc.getConversation(tx, p, agencyId, id);
      if (b.assignedUserId) {
        // Assignee must be an active user of THIS agency.
        const u = await tx.user.findFirst({ where: { id: b.assignedUserId, agencyId, status: 'active' } });
        if (!u) throw new BadRequestException({ code: 'bad_assignee', message: 'Assignee must be an active user in your agency' });
      }
      const c = await tx.conversation.update({ where: { id }, data: b });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'conversation.updated', entityType: 'conversation', entityId: id, metadata: b });
      return { id: c.id, status: c.status, assignedUserId: c.assignedUserId };
    });
  }

  // ---- AI assistance (drafts only; nothing is sent or priced by AI) ----
  @Post(':id/ai/:feature')
  async aiRun(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('feature') feature: string, @Body() body: unknown) {
    const f = parse(z.enum(['summary', 'reply-suggestions', 'extract', 'quote-draft', 'negotiation']), feature);
    const b = parse(z.object({ quoteId: z.string().uuid().optional(), customerMessage: z.string().max(1000).optional() }), body ?? {});
    const agencyId = agencyOf(p);
    await this.db.tenant(agencyId, (tx) => this.svc.getConversation(tx, p, agencyId, id));
    const map = { summary: 'summary', 'reply-suggestions': 'reply', extract: 'extract', 'quote-draft': 'quote_draft', negotiation: 'negotiation' } as const;
    return this.ai.run(p, agencyId, map[f], id, b);
  }
}
