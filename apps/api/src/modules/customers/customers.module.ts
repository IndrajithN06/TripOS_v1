import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { normalizePhone } from '../../common/phone';
import { Db, Tx } from '../../db/db.service';

/** Same rule the quote list applies: a sent/negotiating quote past its expiry is shown as expired. */
const effectiveStatus = (q: { status: string; expiryAt: Date | null }) => (['sent', 'negotiating'].includes(q.status) && q.expiryAt && q.expiryAt < new Date() ? 'expired' : q.status);

const emptyToUndefined = z.literal('').transform(() => undefined);
const emailField = z.union([emptyToUndefined, z.string().trim().toLowerCase().email('Enter a valid email address').max(200)]);

const createSchema = z.object({
  name: z.string().trim().min(2, 'Enter the customer\'s name').max(120),
  phone: z.string().max(40),
  email: emailField.optional(),
  notes: z.string().trim().max(2000).optional(),
});

/** Phone numbers are immutable here: WhatsApp matches conversations (and webhooks upsert customers) by phone, so changing one would split a person in two. */
const patchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.union([emptyToUndefined.transform(() => null), z.string().trim().toLowerCase().email('Enter a valid email address').max(200), z.null()]).optional(),
  notes: z.union([z.string().trim().max(2000), z.null()]).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'Nothing to change');

const view = (c: { id: string; name: string; phoneE164: string; email: string | null; notes: string | null; createdAt: Date }) =>
  ({ id: c.id, name: c.name, phone: c.phoneE164, email: c.email, notes: c.notes, createdAt: c.createdAt });

/**
 * What a user may see. Agency admins, and sales users in an agency whose visibility is "all", see every customer.
 * In "assigned" mode a sales user sees only customers they are linked to: a conversation assigned to them, a quote they own, or a
 * customer they created themselves (found through the append-only audit entry, so no extra column is needed). This mirrors the
 * quote/inbox visibility rules; the same scope also limits which conversations and quotes are listed under a customer.
 */
async function scopeOf(tx: Tx, p: Principal, agencyId: string) {
  const all = { customer: {} as Record<string, unknown>, conversation: {} as Record<string, unknown>, quote: {} as Record<string, unknown> };
  if (p.role !== 'SALES') return all;
  const agency = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
  if (agency.salesVisibility === 'all') return all;
  const [convs, quotes, created] = await Promise.all([
    tx.conversation.findMany({ where: { agencyId, assignedUserId: p.userId }, select: { id: true, customerId: true } }),
    tx.quote.findMany({ where: { agencyId, ownerUserId: p.userId, deletedAt: null }, select: { customerId: true } }),
    tx.auditLog.findMany({ where: { agencyId, action: 'customer.created', actorUserId: p.userId }, select: { entityId: true } }),
  ]);
  const ids = new Set<string>([...convs.map((c) => c.customerId), ...quotes.map((q) => q.customerId), ...created.map((c) => c.entityId).filter((x): x is string => !!x)]);
  return {
    customer: { id: { in: [...ids] } },
    conversation: { assignedUserId: p.userId },
    quote: { OR: [{ ownerUserId: p.userId }, { conversationId: { in: convs.map((c) => c.id) } }] },
  };
}

@Roles('AGENCY_ADMIN', 'SALES')
@Controller('customers')
export class CustomersController {
  constructor(private readonly db: Db) {}

  @Get()
  list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const f = parse(z.object({ search: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }), q);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const scope = await scopeOf(tx, p, agencyId);
      const where: Record<string, unknown> = { agencyId, ...scope.customer };
      const s = f.search?.trim();
      if (s) {
        const digits = s.replace(/\D/g, '');
        where.AND = [{ OR: [{ name: { contains: s, mode: 'insensitive' } }, { email: { contains: s, mode: 'insensitive' } }, ...(digits.length >= 3 ? [{ phoneE164: { contains: digits } }] : [])] }];
      }
      const [total, rows] = await Promise.all([
        tx.customer.count({ where }),
        tx.customer.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      ]);
      const ids = rows.map((r) => r.id);
      const [convs, quotes] = await Promise.all([
        tx.conversation.groupBy({ by: ['customerId'], where: { agencyId, customerId: { in: ids }, ...scope.conversation }, _count: { _all: true }, _max: { lastMessageAt: true } }),
        tx.quote.groupBy({ by: ['customerId'], where: { agencyId, customerId: { in: ids }, deletedAt: null, ...scope.quote }, _count: { _all: true } }),
      ]);
      return {
        items: rows.map((r) => ({
          ...view(r), notes: undefined,
          conversations: convs.find((c) => c.customerId === r.id)?._count._all ?? 0,
          quotes: quotes.find((c) => c.customerId === r.id)?._count._all ?? 0,
          lastActivityAt: convs.find((c) => c.customerId === r.id)?._max.lastMessageAt ?? null,
        })),
        total, page: f.page, pageSize: f.pageSize,
      };
    });
  }

  @Get(':id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, (tx) => this.detail(tx, p, agencyId, id));
  }

  @Post()
  async create(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(createSchema, body);
    const phone = normalizePhone(b.phone);
    if (!phone) throw new BadRequestException({ code: 'invalid_phone', message: 'Enter the phone number with its country code, for example +91 98765 43210.' });
    const agencyId = agencyOf(p);
    try {
      return await this.db.tenant(agencyId, async (tx) => {
        if (await tx.customer.findUnique({ where: { agencyId_phoneE164: { agencyId, phoneE164: phone } }, select: { id: true } })) {
          throw new ConflictException({ code: 'customer_exists', message: 'A customer with this phone number already exists.' });
        }
        const c = await tx.customer.create({ data: { agencyId, name: b.name, phoneE164: phone, email: b.email ?? null, notes: b.notes || null } });
        await audit(tx, { agencyId, actorUserId: p.userId, action: 'customer.created', entityType: 'customer', entityId: c.id, metadata: { source: 'manual' } });
        return view(c);
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ code: 'customer_exists', message: 'A customer with this phone number already exists.' }); // lost a race with the webhook or another user
      throw e;
    }
  }

  @Patch(':id')
  update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(patchSchema, body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const scope = await scopeOf(tx, p, agencyId);
      const existing = await tx.customer.findFirst({ where: { AND: [{ id, agencyId }, scope.customer] }, select: { id: true } }); // AND, never a spread: the scope has its own `id` filter
      if (!existing) throw new NotFoundException({ code: 'not_found', message: 'Customer not found' });
      const data: Record<string, unknown> = {};
      if (b.name !== undefined) data.name = b.name;
      if (b.email !== undefined) data.email = b.email;
      if (b.notes !== undefined) data.notes = b.notes === null || b.notes === '' ? null : b.notes;
      const c = await tx.customer.update({ where: { id }, data });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'customer.updated', entityType: 'customer', entityId: id, metadata: { fields: Object.keys(data) } }); // field names only, never the values
      return view(c);
    });
  }

  private async detail(tx: Tx, p: Principal, agencyId: string, id: string) {
    const scope = await scopeOf(tx, p, agencyId);
    const c = await tx.customer.findFirst({ where: { AND: [{ id, agencyId }, scope.customer] } }); // AND, never a spread: the scope has its own `id` filter
    if (!c) throw new NotFoundException({ code: 'not_found', message: 'Customer not found' });
    const [convs, quotes] = await Promise.all([
      tx.conversation.findMany({ where: { agencyId, customerId: id, ...scope.conversation }, orderBy: { lastMessageAt: 'desc' } }),
      tx.quote.findMany({ where: { agencyId, customerId: id, deletedAt: null, ...scope.quote }, orderBy: { createdAt: 'desc' } }),
    ]);
    const [versions, users] = await Promise.all([
      tx.quoteVersion.findMany({ where: { id: { in: quotes.map((q) => q.currentVersionId).filter((x): x is string => !!x) } }, select: { id: true, versionNumber: true, total: true, vehicleName: true } }),
      tx.user.findMany({ where: { id: { in: convs.map((x) => x.assignedUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    ]);
    return {
      ...view(c),
      conversations: convs.map((x) => ({ id: x.id, status: x.status, lastMessageAt: x.lastMessageAt, unreadCount: x.unreadCount, assignedUser: users.find((u) => u.id === x.assignedUserId) ?? null })),
      quotes: quotes.map((q) => {
        const v = versions.find((x) => x.id === q.currentVersionId);
        return { id: q.id, quoteNumber: q.quoteNumber, status: effectiveStatus(q), version: v?.versionNumber ?? null, total: v ? v.total.toString() : null, vehicleName: v?.vehicleName ?? null, followUpAt: q.followUpAt, createdAt: q.createdAt };
      }),
    };
  }
}
