import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { calculateQuote, diffResults, PricingInput, PricingResult } from '@tripos/pricing';
import { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { AssetService } from '../../common/assets';
import { Principal } from '../../common/auth';
import { Db, Tx } from '../../db/db.service';
import { randomToken } from '../../common/crypto';
import { OutboundResult, OutboundService, SERVICE_WINDOW_MS } from '../inbox/outbound.service';
import { TemplatesService } from '../templates/templates.service';
import { JobsService } from '../jobs/jobs.service';
import { money, toSnapshot } from '../vehicles/vehicles.module';
import { quoteMessageText, renderQuotePdf, RenderModel } from './quote-render';
import { autoRetryDelayMs, SendOutcome, withinAutoRetryBudget } from './retry-policy';

const iso = z.string().datetime({ offset: true });
export const tripSchema = z.object({
  tripType: z.enum(['local_8h_80km', 'local_4h_40km', 'outstation']),
  pickupAt: iso, returnAt: iso.nullable().optional(),
  pickupLocation: z.string().min(1).max(200), destinations: z.array(z.string().min(1).max(120)).max(10).default([]),
  itinerary: z.string().max(3000).optional(), passengers: z.number().int().min(1).max(100),
  days: z.number().int().min(1).max(60).optional(), hours: z.number().min(0).max(240).optional(), km: z.number().min(0).max(20000).optional(),
  minKmMode: z.enum(['trip', 'daily']).optional(), dailyKm: z.array(z.number().min(0).max(5000)).max(60).optional(),
});

export const overridesSchema = z.object({
  local8h80kmPrice: money.optional(), local4h40kmPrice: money.optional(), extraHourRate: money.optional(), extraKmRate: money.optional(),
  outstationRatePerKm: money.optional(), driverBattaPerDay: money.optional(), minKmPerDay: z.number().int().min(0).max(2000).optional(),
});

export const draftSchema = z.object({
  trip: tripSchema, vehicleTypeId: z.string().uuid(), overrides: overridesSchema.default({}),
  extraCharges: z.array(z.object({ label: z.string().min(1).max(80), amount: money, taxable: z.boolean().default(true) })).max(20).default([]),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: money }).nullable().optional(),
  includeDriverBatta: z.boolean().default(true),
  inclusions: z.string().max(1500).nullable().optional(), exclusions: z.string().max(1500).nullable().optional(),
  notes: z.string().max(1500).nullable().optional(), terms: z.string().max(4000).nullable().optional(),
  imageAssetIds: z.array(z.string().uuid()).max(12).default([]),
  expiryAt: iso.nullable().optional(),
});
export type DraftInput = z.infer<typeof draftSchema>;
export const createSchema = draftSchema.extend({ conversationId: z.string().uuid().optional(), customerId: z.string().uuid().optional() });
export const patchSchema = draftSchema.partial();

const TRANSITIONS: Record<string, string[]> = {
  draft: ['ready_to_send'], ready_to_send: ['draft'], sent: ['negotiating', 'accepted', 'declined', 'expired'],
  negotiating: ['accepted', 'declined', 'expired'], send_failed: ['draft'], expired: ['negotiating'], accepted: [], declined: ['negotiating'],
};

/** Money is always serialised with 2 decimals. */
const dec = (v: any) => new Decimal(v.toString()).toFixed(2);

@Injectable()
export class QuotesService {
  constructor(private readonly db: Db, private readonly assets: AssetService, private readonly outbound: OutboundService, private readonly jobs: JobsService, private readonly templates: TemplatesService) {}

  // ------------------------------------------------------------------ pricing

  /** Builds everything a version stores. Authoritative: clients never supply totals. */
  private async build(tx: Tx, agencyId: string, p: Principal, input: DraftInput, prev?: { vehicleTypeId: string; rateSnapshot: any }) {
    const agency = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
    const vt = await tx.vehicleType.findFirst({ where: { id: input.vehicleTypeId, agencyId } });
    if (!vt) throw new NotFoundException({ code: 'vehicle_not_found', message: 'Vehicle type not found' });
    const sameVehicle = prev?.vehicleTypeId === vt.id;
    if (!vt.active && !sameVehicle) throw new BadRequestException({ code: 'vehicle_archived', message: 'This vehicle type is archived and cannot be used for new quotes' });

    let rateSnapshot = sameVehicle ? prev!.rateSnapshot : null;
    if (!rateSnapshot) {
      const rate = await tx.vehicleRate.findFirst({ where: { agencyId, vehicleTypeId: vt.id }, orderBy: { effectiveAt: 'desc' } });
      if (!rate) throw new BadRequestException({ code: 'no_rate_card', message: 'This vehicle type has no rate card' });
      rateSnapshot = toSnapshot(rate);
    }

    const changesRates = Object.keys(input.overrides).length > 0 || !!input.discount;
    if (changesRates && !p.canOverrideRates && p.role !== 'AGENCY_ADMIN') {
      throw new ForbiddenException({ code: 'override_forbidden', message: 'You are not permitted to change rates or apply discounts' });
    }

    const tax = { enabled: agency.taxEnabled, ratePercent: dec(agency.taxRatePercent), mode: agency.taxMode as 'exclusive' | 'inclusive' };
    const t = input.trip;
    const pricingInput: PricingInput = {
      tripType: t.tripType, rate: rateSnapshot, overrides: input.overrides, hours: t.hours, km: t.km, days: t.days ?? daysBetween(t.pickupAt, t.returnAt),
      minKmMode: t.minKmMode, dailyKm: t.dailyKm, includeDriverBatta: input.includeDriverBatta, extraCharges: input.extraCharges,
      discount: input.discount ?? undefined, tax,
    };
    const result = calculateQuote(pricingInput);

    // Only images belonging to THIS agency's chosen vehicle type may be attached.
    let imageAssetIds: string[] = [];
    if (input.imageAssetIds.length) {
      const own = await tx.vehicleTypeImage.findMany({ where: { agencyId, vehicleTypeId: vt.id, assetId: { in: input.imageAssetIds } } });
      if (own.length !== new Set(input.imageAssetIds).size) throw new BadRequestException({ code: 'bad_images', message: 'Selected photos must belong to the chosen vehicle type' });
      imageAssetIds = input.imageAssetIds;
    }

    const branding = await tx.agencyBranding.findUniqueOrThrow({ where: { agencyId } });
    const termsSnapshot = {
      agencyName: agency.name, timezone: agency.timezone, brandColour: branding.brandColour, tagline: branding.tagline, phone: branding.phone, email: branding.email,
      website: branding.website, address: branding.address, footer: branding.footer, logoAssetId: branding.logoAssetId,
      inclusions: input.inclusions ?? branding.inclusions, exclusions: input.exclusions ?? branding.exclusions, notes: input.notes ?? null, terms: input.terms ?? branding.terms,
    };
    return { vt, rateSnapshot, result, imageAssetIds, termsSnapshot, tax, stored: { input: { ...input, imageAssetIds }, tax } };
  }

  async calculate(p: Principal, agencyId: string, input: DraftInput) {
    return this.db.tenant(agencyId, async (tx) => {
      const b = await this.build(tx, agencyId, p, input);
      return { ...b.result, vehicleName: b.vt.name };
    });
  }

  // ------------------------------------------------------------------ create / edit

  async create(p: Principal, agencyId: string, body: z.infer<typeof createSchema>) {
    const { conversationId, customerId, ...input } = body;
    return this.db.tenant(agencyId, async (tx) => {
      let custId = customerId, convId = conversationId;
      if (convId) {
        const c = await tx.conversation.findFirst({ where: { id: convId, agencyId } });
        if (!c) throw new NotFoundException({ code: 'not_found', message: 'Conversation not found' });
        custId = c.customerId;
      }
      if (!custId) throw new BadRequestException({ code: 'customer_required', message: 'A customer or conversation is required' });
      if (!(await tx.customer.findFirst({ where: { id: custId, agencyId } }))) throw new NotFoundException({ code: 'not_found', message: 'Customer not found' });

      const b = await this.build(tx, agencyId, p, input);
      const agency = await tx.agency.update({ where: { id: agencyId }, data: { quoteSeq: { increment: 1 } } });
      const quoteNumber = `Q-${String(agency.quoteSeq).padStart(4, '0')}`;
      const expiryAt = input.expiryAt ? new Date(input.expiryAt) : new Date(Date.now() + agency.quoteValidityDays * 86400000);
      const quote = await tx.quote.create({ data: { agencyId, quoteNumber, customerId: custId, conversationId: convId, ownerUserId: p.userId, status: 'draft', expiryAt } });
      const v = await this.insertVersion(tx, agencyId, quote.id, 1, p.userId, input, b);
      await tx.quote.update({ where: { id: quote.id }, data: { currentVersionId: v.id } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'quote.created', entityType: 'quote', entityId: quote.id, metadata: { quoteNumber, total: dec(v.total) } });
      return this.detail(tx, agencyId, quote.id);
    });
  }

  private async insertVersion(tx: Tx, agencyId: string, quoteId: string, versionNumber: number, userId: string, input: DraftInput, b: Awaited<ReturnType<QuotesService['build']>>) {
    const v = await tx.quoteVersion.create({
      data: {
        agencyId, quoteId, versionNumber, status: 'draft', trip: input.trip as any, vehicleTypeId: b.vt.id, vehicleName: b.vt.name, rateSnapshot: b.rateSnapshot as any,
        pricingInput: b.stored as any, lines: b.result.lines as any, subtotal: b.result.subtotal, discount: b.result.discount, tax: b.result.tax, total: b.result.total,
        termsSnapshot: b.termsSnapshot as any, createdById: userId,
      },
    });
    await tx.quoteVersionImage.createMany({ data: b.imageAssetIds.map((assetId, i) => ({ agencyId, quoteVersionId: v.id, assetId, sortOrder: i })) });
    return v;
  }

  async updateDraft(p: Principal, agencyId: string, quoteId: string, patch: z.infer<typeof patchSchema>) {
    return this.db.tenant(agencyId, async (tx) => {
      const { quote, version } = await this.current(tx, p, agencyId, quoteId);
      if (version.sentAt) throw new ConflictException({ code: 'version_sent', message: `Version ${version.versionNumber} was sent and is immutable. Create a new version to make changes.` });
      const merged = mergeInput((version.pricingInput as any).input, patch);
      const b = await this.build(tx, agencyId, p, merged, { vehicleTypeId: version.vehicleTypeId, rateSnapshot: version.rateSnapshot });
      await tx.quoteVersion.update({
        where: { id: version.id },
        data: { trip: merged.trip as any, vehicleTypeId: b.vt.id, vehicleName: b.vt.name, rateSnapshot: b.rateSnapshot as any, pricingInput: b.stored as any, lines: b.result.lines as any, subtotal: b.result.subtotal, discount: b.result.discount, tax: b.result.tax, total: b.result.total, termsSnapshot: b.termsSnapshot as any, status: 'draft' },
      });
      await tx.quoteVersionImage.deleteMany({ where: { quoteVersionId: version.id } });
      await tx.quoteVersionImage.createMany({ data: b.imageAssetIds.map((assetId, i) => ({ agencyId, quoteVersionId: version.id, assetId, sortOrder: i })) });
      if (patch.expiryAt !== undefined) await tx.quote.update({ where: { id: quote.id }, data: { expiryAt: patch.expiryAt ? new Date(patch.expiryAt) : null } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'quote.draft_updated', entityType: 'quote', entityId: quoteId, metadata: { version: version.versionNumber, total: b.result.total, discount: b.result.discount } });
      return this.detail(tx, agencyId, quoteId);
    });
  }

  /** Edit/Requote: copies the sent version into a NEW draft version; the sent one is never touched. */
  async newVersion(p: Principal, agencyId: string, quoteId: string, patch: z.infer<typeof patchSchema>) {
    return this.db.tenant(agencyId, async (tx) => {
      const { quote, version } = await this.current(tx, p, agencyId, quoteId);
      if (!version.sentAt) throw new ConflictException({ code: 'draft_exists', message: 'The current version has not been sent yet; edit it directly.' });
      if (['accepted', 'declined'].includes(quote.status) && Object.keys(patch).length === 0) throw new ConflictException({ code: 'closed', message: 'Re-open the quote before revising it' });
      const merged = mergeInput((version.pricingInput as any).input, patch);
      if (!patch.imageAssetIds) merged.imageAssetIds = (await tx.quoteVersionImage.findMany({ where: { quoteVersionId: version.id }, orderBy: { sortOrder: 'asc' } })).map((i) => i.assetId);
      const b = await this.build(tx, agencyId, p, merged, { vehicleTypeId: version.vehicleTypeId, rateSnapshot: version.rateSnapshot });
      const last = await tx.quoteVersion.aggregate({ where: { quoteId }, _max: { versionNumber: true } });
      const nv = await this.insertVersion(tx, agencyId, quoteId, (last._max.versionNumber ?? 0) + 1, p.userId, merged, b);
      await tx.quote.update({ where: { id: quoteId }, data: { currentVersionId: nv.id, status: quote.status === 'sent' ? 'negotiating' : quote.status } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'quote.version_created', entityType: 'quote', entityId: quoteId, metadata: { from: version.versionNumber, to: nv.versionNumber, totalBefore: dec(version.total), totalAfter: b.result.total } });
      return { ...(await this.detail(tx, agencyId, quoteId)), diff: diffResults(asResult(version), b.result) };
    });
  }

  /** Duplicate: a brand-new quote (own number, version 1) pre-filled from the current version. */
  async duplicate(p: Principal, agencyId: string, quoteId: string) {
    const src = await this.db.tenant(agencyId, async (tx) => {
      const { quote, version } = await this.current(tx, p, agencyId, quoteId);
      const imgs = await tx.quoteVersionImage.findMany({ where: { quoteVersionId: version.id }, orderBy: { sortOrder: 'asc' } });
      return { quote, input: { ...(version.pricingInput as any).input, imageAssetIds: imgs.map((i) => i.assetId) } as DraftInput };
    });
    return this.create(p, agencyId, { ...src.input, conversationId: src.quote.conversationId ?? undefined, customerId: src.quote.customerId });
  }

  async diff(p: Principal, agencyId: string, quoteId: string, from: number, to: number) {
    return this.db.tenant(agencyId, async (tx) => {
      await this.current(tx, p, agencyId, quoteId);
      const [a, b] = await Promise.all([from, to].map((n) => tx.quoteVersion.findFirst({ where: { quoteId, agencyId, versionNumber: n } })));
      if (!a || !b) throw new NotFoundException({ code: 'not_found', message: 'Version not found' });
      return diffResults(asResult(a), asResult(b));
    });
  }

  // ------------------------------------------------------------------ reads

  private async visibleFilter(tx: Tx, p: Principal, agencyId: string) {
    if (p.role !== 'SALES') return {};
    const agency = await tx.agency.findUniqueOrThrow({ where: { id: agencyId } });
    if (agency.salesVisibility === 'all') return {};
    const convs = await tx.conversation.findMany({ where: { agencyId, assignedUserId: p.userId }, select: { id: true } });
    return { OR: [{ ownerUserId: p.userId }, { conversationId: { in: convs.map((c) => c.id) } }] };
  }

  private async current(tx: Tx, p: Principal, agencyId: string, quoteId: string) {
    const quote = await tx.quote.findFirst({ where: { id: quoteId, agencyId, ...(await this.visibleFilter(tx, p, agencyId)) } });
    if (!quote) throw new NotFoundException({ code: 'not_found', message: 'Quote not found' });
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: quote.currentVersionId!, agencyId } });
    return { quote, version };
  }

  async list(p: Principal, agencyId: string, q: { search?: string; status?: string; page: number; pageSize: number; conversationId?: string }) {
    return this.db.tenant(agencyId, async (tx) => {
      const vis = await this.visibleFilter(tx, p, agencyId);
      const where: any = { agencyId, ...vis };
      if (q.status) where.status = q.status;
      if (q.conversationId) where.conversationId = q.conversationId;
      if (q.search) {
        const custs = await tx.customer.findMany({ where: { agencyId, OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { phoneE164: { contains: q.search } }] }, select: { id: true } });
        where.AND = [{ OR: [{ quoteNumber: { contains: q.search, mode: 'insensitive' } }, { customerId: { in: custs.map((c) => c.id) } }] }];
      }
      const [total, rows] = await Promise.all([
        tx.quote.count({ where }),
        tx.quote.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      ]);
      const [versions, customers, owners, sent] = await Promise.all([
        tx.quoteVersion.findMany({ where: { id: { in: rows.map((r) => r.currentVersionId!).filter(Boolean) } } }),
        tx.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) } } }),
        tx.user.findMany({ where: { id: { in: rows.map((r) => r.ownerUserId) } }, select: { id: true, name: true } }),
        tx.quoteVersion.groupBy({ by: ['quoteId'], where: { quoteId: { in: rows.map((r) => r.id) }, sentAt: { not: null } }, _max: { sentAt: true } }),
      ]);
      const items = rows.map((r) => {
        const v = versions.find((x) => x.id === r.currentVersionId)!;
        const trip = v.trip as any;
        return {
          id: r.id, quoteNumber: r.quoteNumber, status: effectiveStatus(r), customer: customers.find((c) => c.id === r.customerId)?.name, customerId: r.customerId,
          conversationId: r.conversationId, owner: owners.find((o) => o.id === r.ownerUserId)?.name, version: v.versionNumber, versionStatus: v.status, total: dec(v.total), vehicleName: v.vehicleName,
          destination: (trip.destinations ?? []).join(', '), pickupAt: trip.pickupAt, lastSentAt: sent.find((s) => s.quoteId === r.id)?._max.sentAt ?? null,
          followUpAt: r.followUpAt, expiryAt: r.expiryAt, createdAt: r.createdAt,
        };
      });
      return { items, total, page: q.page, pageSize: q.pageSize };
    });
  }

  async get(p: Principal, agencyId: string, quoteId: string) {
    return this.db.tenant(agencyId, async (tx) => {
      await this.current(tx, p, agencyId, quoteId);
      return this.detail(tx, agencyId, quoteId);
    });
  }

  private async detail(tx: Tx, agencyId: string, quoteId: string) {
    const quote = await tx.quote.findFirstOrThrow({ where: { id: quoteId, agencyId } });
    const versions = await tx.quoteVersion.findMany({ where: { quoteId, agencyId }, orderBy: { versionNumber: 'asc' } });
    const customer = await tx.customer.findFirstOrThrow({ where: { id: quote.customerId, agencyId } });
    const out = await Promise.all(versions.map(async (v) => {
      const imgs = await tx.quoteVersionImage.findMany({ where: { quoteVersionId: v.id }, orderBy: { sortOrder: 'asc' } });
      const attempts = await tx.quoteSendAttempt.findMany({ where: { quoteVersionId: v.id }, orderBy: { createdAt: 'asc' } });
      return {
        id: v.id, versionNumber: v.versionNumber, status: v.status, trip: v.trip, vehicleTypeId: v.vehicleTypeId, vehicleName: v.vehicleName, rateSnapshot: v.rateSnapshot,
        input: (v.pricingInput as any).input, lines: v.lines, subtotal: dec(v.subtotal), discount: dec(v.discount), tax: dec(v.tax), total: dec(v.total), terms: v.termsSnapshot,
        imageAssetIds: imgs.map((i) => i.assetId), createdAt: v.createdAt, sentAt: v.sentAt, createdById: v.createdById, immutable: !!v.sentAt, hasPdf: !!v.pdfAssetId,
        sendAttempts: attempts.map((a) => ({ id: a.id, kind: a.kind, assetId: a.assetId, status: a.status, attempts: a.attempts, lastError: a.lastError })),
      };
    }));
    return {
      id: quote.id, quoteNumber: quote.quoteNumber, status: effectiveStatus(quote), conversationId: quote.conversationId, customer: { id: customer.id, name: customer.name, phone: customer.phoneE164 },
      ownerUserId: quote.ownerUserId, currentVersionId: quote.currentVersionId, expiryAt: quote.expiryAt, followUpAt: quote.followUpAt, createdAt: quote.createdAt, versions: out,
    };
  }

  async preview(p: Principal, agencyId: string, quoteId: string, versionNumber: number) {
    return this.db.tenant(agencyId, async (tx) => {
      await this.current(tx, p, agencyId, quoteId);
      const { model, photoAssets } = await this.model(tx, agencyId, quoteId, versionNumber);
      return { ...model, photos: await Promise.all(photoAssets.map(async (a) => ({ assetId: a.id, url: await this.assets.url(a) }))), logoUrl: await this.logoUrl(tx, model, agencyId) };
    });
  }

  private async logoUrl(tx: Tx, _m: RenderModel, agencyId: string) {
    const b = await tx.agencyBranding.findUnique({ where: { agencyId } });
    const logo = b?.logoAssetId ? await tx.asset.findFirst({ where: { id: b.logoAssetId, agencyId } }) : null;
    return logo ? this.assets.url(logo) : null;
  }

  private async model(tx: Tx, agencyId: string, quoteId: string, versionNumber: number) {
    const quote = await tx.quote.findFirstOrThrow({ where: { id: quoteId, agencyId } });
    const v = await tx.quoteVersion.findFirst({ where: { quoteId, agencyId, versionNumber } });
    if (!v) throw new NotFoundException({ code: 'not_found', message: 'Version not found' });
    const customer = await tx.customer.findFirstOrThrow({ where: { id: quote.customerId, agencyId } });
    const ts = v.termsSnapshot as any;
    const imgs = await tx.quoteVersionImage.findMany({ where: { quoteVersionId: v.id }, orderBy: { sortOrder: 'asc' } });
    const photoAssets = await Promise.all(imgs.map((i) => tx.asset.findFirstOrThrow({ where: { id: i.assetId, agencyId } })));
    const captions = await tx.vehicleTypeImage.findMany({ where: { agencyId, assetId: { in: imgs.map((i) => i.assetId) } } });
    const tax = (v.pricingInput as any).tax;
    const model: RenderModel = {
      quoteNumber: quote.quoteNumber, versionNumber: v.versionNumber, createdAt: v.createdAt, expiryAt: quote.expiryAt, customer: { name: customer.name, phone: customer.phoneE164 },
      brand: { agencyName: ts.agencyName, tagline: ts.tagline, brandColour: ts.brandColour, phone: ts.phone, email: ts.email, website: ts.website, address: ts.address, footer: ts.footer, timezone: ts.timezone },
      trip: v.trip, vehicleName: v.vehicleName, lines: v.lines as any, subtotal: dec(v.subtotal), discount: dec(v.discount), tax: dec(v.tax), total: dec(v.total), taxMode: tax.mode, taxRatePercent: tax.ratePercent,
      inclusions: ts.inclusions, exclusions: ts.exclusions, notes: ts.notes, terms: ts.terms,
    };
    return { model, version: v, quote, photoAssets, captions, logoAssetId: ts.logoAssetId as string | null };
  }

  /** PDF for a version: the stored file for sent versions, rendered on demand for drafts. */
  async pdf(p: Principal, agencyId: string, quoteId: string, versionNumber: number): Promise<{ data: Buffer; filename: string }> {
    return this.db.tenant(agencyId, async (tx) => {
      await this.current(tx, p, agencyId, quoteId);
      const m = await this.model(tx, agencyId, quoteId, versionNumber);
      const filename = `${m.quote.quoteNumber}-v${m.version.versionNumber}.pdf`;
      if (m.version.pdfAssetId) {
        const a = await this.assets.load(tx, agencyId, m.version.pdfAssetId);
        return { data: await this.assets.storage.get(a.storageKey), filename };
      }
      return { data: await this.render(tx, agencyId, m), filename };
    });
  }

  private async render(tx: Tx, agencyId: string, m: Awaited<ReturnType<QuotesService['model']>>) {
    const logoAsset = m.logoAssetId ? await tx.asset.findFirst({ where: { id: m.logoAssetId, agencyId } }) : null;
    const logo = logoAsset ? await this.assets.storage.get(logoAsset.storageKey) : null;
    const photos = await Promise.all(m.photoAssets.map(async (a) => ({ buffer: await this.assets.storage.get(a.storageKey), caption: m.captions.find((c) => c.assetId === a.id)?.caption })));
    return renderQuotePdf(m.model, logo, photos);
  }

  // ------------------------------------------------------------------ status / follow-up

  async setStatus(p: Principal, agencyId: string, quoteId: string, status: string) {
    return this.db.tenant(agencyId, async (tx) => {
      const { quote } = await this.current(tx, p, agencyId, quoteId);
      if (!(TRANSITIONS[quote.status] ?? []).includes(status)) throw new BadRequestException({ code: 'bad_transition', message: `Cannot change a quote from ${quote.status} to ${status}` });
      if (status === 'ready_to_send' || status === 'draft') { /* manual only for unsent quotes */ }
      await tx.quote.update({ where: { id: quoteId }, data: { status } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'quote.status_changed', entityType: 'quote', entityId: quoteId, metadata: { from: quote.status, to: status } });
      return this.detail(tx, agencyId, quoteId);
    });
  }

  async setFollowUp(p: Principal, agencyId: string, quoteId: string, at: string | null) {
    return this.db.tenant(agencyId, async (tx) => {
      await this.current(tx, p, agencyId, quoteId);
      await tx.quote.update({ where: { id: quoteId }, data: { followUpAt: at ? new Date(at) : null } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'quote.follow_up_set', entityType: 'quote', entityId: quoteId, metadata: { at } });
      return this.detail(tx, agencyId, quoteId);
    });
  }

  // ------------------------------------------------------------------ send / retry

  async send(p: Principal, agencyId: string, quoteId: string, versionNumber: number, opts: { followUpAt?: string | null }) {
    const versionId = await this.db.tenant(agencyId, async (tx) => {
      const { quote, version } = await this.current(tx, p, agencyId, quoteId);
      if (version.versionNumber !== versionNumber) throw new ConflictException({ code: 'not_current', message: 'Only the current version can be sent' });
      if (version.sentAt || version.status === 'sending') throw new ConflictException({ code: 'already_sent', message: 'This version was already sent. Use retry for failed items, or create a new version.' });
      if (['accepted', 'declined'].includes(quote.status)) throw new ConflictException({ code: 'closed', message: 'This quote is closed' });

      let convId = quote.conversationId;
      if (!convId) {
        const existing = await tx.conversation.findFirst({ where: { agencyId, customerId: quote.customerId }, orderBy: { lastMessageAt: 'desc' } });
        convId = existing?.id ?? (await tx.conversation.create({ data: { agencyId, customerId: quote.customerId, status: 'open' } })).id;
        await tx.quote.update({ where: { id: quote.id }, data: { conversationId: convId } });
      }
      const m = await this.model(tx, agencyId, quoteId, versionNumber);
      const pdf = await this.render(tx, agencyId, m);
      const asset = await this.assets.storeBuffer(tx, agencyId, p.userId, pdf, 'application/pdf', 'quote_pdf');
      await tx.quoteVersion.update({ where: { id: version.id }, data: { pdfAssetId: asset.id, status: 'sending' } });
      const kinds: { kind: string; assetId?: string }[] = [{ kind: 'text' }, { kind: 'pdf', assetId: asset.id }, ...m.photoAssets.map((a) => ({ kind: 'image', assetId: a.id }))];
      // Strictly increasing timestamps: delivery order (text, PDF, then photos in the staff's order) is derived from createdAt,
      // and a single batch insert would otherwise give every item the same value (an arbitrary order).
      const base = Date.now();
      await tx.quoteSendAttempt.createMany({ data: kinds.map((k, i) => ({ agencyId, quoteVersionId: version.id, kind: k.kind, assetId: k.assetId, createdAt: new Date(base + i) })) });
      await tx.quote.update({ where: { id: quote.id }, data: { followUpAt: opts.followUpAt ? new Date(opts.followUpAt) : quote.followUpAt } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'quote.send_requested', entityType: 'quote', entityId: quoteId, metadata: { version: versionNumber, total: dec(version.total), images: m.photoAssets.length } });
      return version.id;
    });
    return this.execute(agencyId, versionId, p.userId);
  }

  // ------------------------------------------------------------------ WhatsApp template send

  /** The PDF of a version as a stored asset (needed as a document header and as the downloadable copy). Reuses an existing one. */
  async ensurePdfAsset(tx: Tx, agencyId: string, userId: string | null, quoteId: string, versionNumber: number) {
    const m = await this.model(tx, agencyId, quoteId, versionNumber);
    if (m.version.pdfAssetId) return { assetId: m.version.pdfAssetId, model: m };
    const asset = await this.assets.storeBuffer(tx, agencyId, userId, await this.render(tx, agencyId, m), 'application/pdf', 'quote_pdf');
    await tx.quoteVersion.update({ where: { id: m.version.id }, data: { pdfAssetId: asset.id } });
    return { assetId: asset.id, model: m };
  }

  /** Approved templates for sending this version, best match first, plus what staff must confirm for a revised price. */
  async templateOptions(p: Principal, agencyId: string, quoteId: string, versionNumber: number) {
    const info = await this.db.tenant(agencyId, async (tx) => {
      const { quote, version } = await this.current(tx, p, agencyId, quoteId);
      const prev = versionNumber > 1 ? await tx.quoteVersion.findFirst({ where: { quoteId, agencyId, versionNumber: versionNumber - 1 } }) : null;
      const conv = quote.conversationId ? await tx.conversation.findFirst({ where: { id: quote.conversationId, agencyId } }) : null;
      return { version, previousTotal: prev ? dec(prev.total) : null, windowOpen: !!conv?.lastInboundAt && Date.now() - conv.lastInboundAt.getTime() < SERVICE_WINDOW_MS };
    });
    const revised = versionNumber > 1;
    const list = await this.templates.approvedFor(agencyId, revised ? ['revised_quotation', 'quotation'] : ['quotation']);
    const usable = list.filter((t: any) => t.purpose === 'quotation' || t.purpose === 'revised_quotation' || t.purpose === 'custom');
    return { templates: usable, recommendedTemplateId: usable[0]?.id ?? null, windowOpen: info.windowOpen, previousTotal: info.previousTotal, currentTotal: dec(info.version.total), requiresPriceApproval: revised };
  }

  /**
   * Sends a version to the customer with an approved WhatsApp template (text + header media + buttons). Free-form items (PDF,
   * vehicle photos) follow only when the 24h window is open; otherwise they are reported as `deferred` rather than failing.
   * A revised version (v2+) additionally needs the staff member to confirm the exact price with `approvedTotal`.
   */
  async sendWithTemplate(p: Principal, agencyId: string, quoteId: string, versionNumber: number, opts: { templateId: string; includePdf?: boolean; followUpAt?: string | null; approvedTotal?: string }) {
    const planned = await this.db.tenant(agencyId, async (tx) => {
      const { quote, version } = await this.current(tx, p, agencyId, quoteId);
      if (version.versionNumber !== versionNumber) throw new ConflictException({ code: 'not_current', message: 'Only the current version can be sent' });
      if (version.sentAt || version.status === 'sending') throw new ConflictException({ code: 'already_sent', message: 'This version was already sent. Use retry for failed items, or create a new version.' });
      if (['accepted', 'declined'].includes(quote.status)) throw new ConflictException({ code: 'closed', message: 'This quote is closed' });
      const tpl = await tx.whatsappTemplate.findFirst({ where: { id: opts.templateId, agencyId } });
      if (!tpl || tpl.providerStatus !== 'approved') throw new BadRequestException({ code: 'template_not_approved', message: 'Choose a template that Meta has approved.' });
      if (versionNumber > 1 && (!opts.approvedTotal || new Decimal(opts.approvedTotal).toFixed(2) !== dec(version.total))) {
        throw new BadRequestException({ code: 'approval_required', message: `Confirm the revised price (${dec(version.total)}) before sending it to the customer.`, currentTotal: dec(version.total) });
      }
      const spec = this.templates.specOf(tpl);

      let convId = quote.conversationId;
      if (!convId) {
        const existing = await tx.conversation.findFirst({ where: { agencyId, customerId: quote.customerId }, orderBy: { lastMessageAt: 'desc' } });
        convId = existing?.id ?? (await tx.conversation.create({ data: { agencyId, customerId: quote.customerId, status: 'open' } })).id;
        await tx.quote.update({ where: { id: quote.id }, data: { conversationId: convId } });
      }
      const conv = await tx.conversation.findFirstOrThrow({ where: { id: convId, agencyId } });
      const windowOpen = !!conv.lastInboundAt && Date.now() - conv.lastInboundAt.getTime() < SERVICE_WINDOW_MS;

      const { assetId: pdfAssetId, model: m } = await this.ensurePdfAsset(tx, agencyId, p.userId, quoteId, versionNumber);
      if (!version.publicToken) await tx.quoteVersion.update({ where: { id: version.id }, data: { publicToken: randomToken(18) } });
      // Fail now (nothing recorded as sent) if the template cannot be filled for this quote.
      await this.templates.prepare(tx, agencyId, tpl, { quoteId, versionNumber, conversationId: convId, useSnapshot: true });

      const wantPdf = opts.includePdf !== false && spec.header.type !== 'document';
      const kinds: { kind: string; assetId?: string; templateId?: string }[] = [{ kind: 'template', templateId: tpl.id }];
      if (windowOpen) {
        if (wantPdf) kinds.push({ kind: 'pdf', assetId: pdfAssetId });
        for (const a of m.photoAssets) kinds.push({ kind: 'image', assetId: a.id });
      }
      await tx.quoteVersion.update({ where: { id: version.id }, data: { status: 'sending' } });
      const base = Date.now();
      await tx.quoteSendAttempt.createMany({ data: kinds.map((k, i) => ({ agencyId, quoteVersionId: version.id, kind: k.kind, assetId: k.assetId, templateId: k.templateId, createdAt: new Date(base + i) })) });
      await tx.quote.update({ where: { id: quote.id }, data: { followUpAt: opts.followUpAt ? new Date(opts.followUpAt) : quote.followUpAt } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'quote.template_send_requested', entityType: 'quote', entityId: quoteId, metadata: { version: versionNumber, template: tpl.name, total: dec(version.total), approvedTotal: opts.approvedTotal ?? null, windowOpen, images: windowOpen ? m.photoAssets.length : 0 } });
      return { versionId: version.id, deferred: windowOpen ? null : { pdf: wantPdf, images: m.photoAssets.length, reason: 'The 24-hour window is closed. The template message goes out now; the PDF and photos can be sent once the customer replies.' } };
    });
    const result = await this.execute(agencyId, planned.versionId, p.userId);
    return { ...result, deferred: planned.deferred };
  }

  /** The exact template message for a delivery item, rebuilt from the version so retries send identical content. */
  private async templatePayload(agencyId: string, quoteId: string, versionNumber: number, templateId: string | null) {
    return this.db.tenant(agencyId, async (tx) => {
      const tpl = templateId ? await tx.whatsappTemplate.findFirst({ where: { id: templateId, agencyId } }) : null;
      if (!tpl) throw new BadRequestException({ code: 'template_not_found', message: 'The template used for this send no longer exists.' });
      const quote = await tx.quote.findFirstOrThrow({ where: { id: quoteId, agencyId } });
      const prepared = await this.templates.prepare(tx, agencyId, tpl, { quoteId, versionNumber, conversationId: quote.conversationId ?? undefined, useSnapshot: true });
      return { kind: 'template', templateId: tpl.id, variables: prepared.variables, extra: prepared.extra } as const;
    });
  }

  // ------------------------------------------------------------------ public customer view (token only, no login)

  private async byToken(tx: Tx, token: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new NotFoundException({ code: 'not_found', message: 'This quotation link is not valid.' });
    const v = await tx.quoteVersion.findUnique({ where: { publicToken: token } });
    if (!v || !v.sentAt) throw new NotFoundException({ code: 'not_found', message: 'This quotation link is not valid.' });
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: v.quoteId } });
    return { v, quote };
  }

  /** What the customer sees at the link: no phone number, no internal data; an expired quote shows no prices. */
  async publicView(token: string) {
    return this.db.system(async (tx) => {
      const { v, quote } = await this.byToken(tx, token);
      const m = await this.model(tx, v.agencyId, quote.id, v.versionNumber);
      const expired = effectiveStatus(quote) === 'expired' || (!!quote.expiryAt && quote.expiryAt < new Date());
      const logo = m.logoAssetId ? await tx.asset.findFirst({ where: { id: m.logoAssetId, agencyId: v.agencyId } }) : null;
      const photos = await Promise.all(m.photoAssets.map(async (a) => ({ url: await this.assets.url(a), caption: m.captions.find((c) => c.assetId === a.id)?.caption ?? null })));
      const { customer, ...rest } = m.model;
      return { expired, superseded: quote.currentVersionId !== v.id, customerName: customer.name, logoUrl: logo ? await this.assets.url(logo) : null, photos, model: expired ? { ...rest, lines: [], subtotal: null, discount: null, tax: null, total: null } : rest, pdfAvailable: !expired };
    });
  }

  async publicPdf(token: string): Promise<{ data: Buffer; filename: string }> {
    return this.db.system(async (tx) => {
      const { v, quote } = await this.byToken(tx, token);
      if (quote.expiryAt && quote.expiryAt < new Date()) throw new NotFoundException({ code: 'expired', message: 'This quotation has expired.' });
      const m = await this.model(tx, v.agencyId, quote.id, v.versionNumber);
      const data = v.pdfAssetId ? await this.assets.storage.get((await tx.asset.findFirstOrThrow({ where: { id: v.pdfAssetId, agencyId: v.agencyId } })).storageKey) : await this.render(tx, v.agencyId, m);
      return { data, filename: `${quote.quoteNumber}-v${v.versionNumber}.pdf` };
    });
  }

  async retry(p: Principal, agencyId: string, quoteId: string, versionNumber: number) {
    const versionId = await this.db.tenant(agencyId, async (tx) => {
      const { version } = await this.current(tx, p, agencyId, quoteId);
      const v = version.versionNumber === versionNumber ? version : await tx.quoteVersion.findFirst({ where: { quoteId, agencyId, versionNumber } });
      if (!v) throw new NotFoundException({ code: 'not_found', message: 'Version not found' });
      return v.id;
    });
    return this.execute(agencyId, versionId, p.userId);
  }

  /**
   * Processes only the existing pending/failed delivery items, so a retry never re-sends what the customer already has
   * and never creates new delivery records (each item keeps one row and an attempt counter).
   *
   * `opts.auto` marks a queued background retry. Those are bounded (see retry-policy.ts) and are skipped entirely while
   * the WhatsApp connection is degraded or disconnected (e.g. expired credentials) until it is restored. A retry that staff
   * trigger explicitly always runs, which is also how recovery after reconnecting is confirmed.
   */
  async execute(agencyId: string, versionId: string, userId: string | null, opts: { auto?: boolean } = {}) {
    const ctx = await this.db.tenant(agencyId, async (tx) => {
      const v = await tx.quoteVersion.findFirstOrThrow({ where: { id: versionId, agencyId } });
      const quote = await tx.quote.findFirstOrThrow({ where: { id: v.quoteId, agencyId } });
      const attempts = await tx.quoteSendAttempt.findMany({ where: { quoteVersionId: versionId, agencyId, status: { in: ['pending', 'failed'] } }, orderBy: { createdAt: 'asc' } });
      const account = await tx.whatsappAccount.findFirst({ where: { agencyId }, select: { connectionStatus: true } });
      const m = await this.model(tx, agencyId, quote.id, v.versionNumber);
      const caps = new Map(m.captions.map((c) => [c.assetId, c.caption]));
      return { v, quote, attempts, connection: account?.connectionStatus, text: quoteMessageText(m.model), filename: `${quote.quoteNumber}-v${v.versionNumber}.pdf`, caps, convId: quote.conversationId! };
    });

    let items = ctx.attempts;
    if (opts.auto) {
      const unhealthy = ctx.connection === 'degraded' || ctx.connection === 'disconnected';
      items = unhealthy ? [] : items.filter((a) => withinAutoRetryBudget(a.attempts));
    }

    const outcomes: SendOutcome[] = [];
    for (const a of items) {
      let r: OutboundResult;
      try {
        const payload = a.kind === 'template' ? await this.templatePayload(agencyId, ctx.quote.id, ctx.v.versionNumber, a.templateId)
          : a.kind === 'text' ? ({ kind: 'text', text: ctx.text } as const)
          : a.kind === 'pdf' ? ({ kind: 'document', assetId: a.assetId!, filename: ctx.filename, caption: `Quotation ${ctx.quote.quoteNumber}` } as const)
          : ({ kind: 'image', assetId: a.assetId!, caption: ctx.caps.get(a.assetId!) ?? undefined } as const);
        r = await this.outbound.send(agencyId, ctx.convId, payload, { userId, idempotencyKey: `qsa:${a.id}` });
      }
      catch (e: any) {
        // Pre-flight rejections (window closed, template not approved, not connected...) are HTTP 4xx: waiting will not fix them.
        // Anything else was unexpected and may be transient.
        r = { ok: false, messageId: '', status: 'failed', errorCode: e?.response?.code ?? 'error', errorMessage: e?.response?.message ?? e?.message ?? 'Send failed', retryable: !(e instanceof HttpException) };
      }
      outcomes.push({ attemptId: a.id, ok: r.ok, retryable: !r.ok && r.retryable === true });
      await this.db.tenant(agencyId, async (tx) => {
        await tx.quoteSendAttempt.update({ where: { id: a.id }, data: { status: r.ok ? 'sent' : 'failed', attempts: { increment: 1 }, lastError: r.ok ? null : r.errorMessage, messageId: r.messageId || undefined } });
        if (r.ok) await tx.quoteVersion.updateMany({ where: { id: versionId, sentAt: null }, data: { sentAt: new Date() } });
      });
    }
    return this.finalise(agencyId, versionId, outcomes);
  }

  private async finalise(agencyId: string, versionId: string, outcomes: SendOutcome[]) {
    const out = await this.db.tenant(agencyId, async (tx) => {
      const v = await tx.quoteVersion.findFirstOrThrow({ where: { id: versionId, agencyId } });
      const quote = await tx.quote.findFirstOrThrow({ where: { id: v.quoteId, agencyId } });
      const attempts = await tx.quoteSendAttempt.findMany({ where: { quoteVersionId: versionId, agencyId }, orderBy: { createdAt: 'asc' } });
      const okCount = attempts.filter((a) => a.status === 'sent').length;
      const status = okCount === attempts.length ? 'sent' : okCount === 0 ? 'failed' : 'partially_sent';
      await tx.quoteVersion.update({ where: { id: versionId }, data: { status } });
      // The headline item decides whether the customer "has the quote": the template message (which carries the quote
      // link/PDF) for template sends, otherwise the PDF.
      const primary = attempts.find((a) => a.kind === 'template') ?? attempts.find((a) => a.kind === 'pdf');
      const pdfSent = primary?.status === 'sent';
      const nextQuote = pdfSent ? (['draft', 'ready_to_send', 'send_failed', 'negotiating'].includes(quote.status) ? 'sent' : quote.status) : quote.status === 'sent' || quote.status === 'negotiating' ? quote.status : 'send_failed';
      await tx.quote.update({ where: { id: quote.id }, data: { status: nextQuote } });
      const failed = attempts.filter((a) => a.status === 'failed');
      // Automatic retry is scheduled ONLY for items that just failed in a way that can succeed later and that still
      // have budget left. Everything else (expired credentials, closed window, exhausted budget...) needs a person.
      const justFailedRetryable = new Set(outcomes.filter((o) => !o.ok && o.retryable).map((o) => o.attemptId));
      const retryableFailed = failed.filter((a) => justFailedRetryable.has(a.id));
      const eligible = retryableFailed.filter((a) => withinAutoRetryBudget(a.attempts));
      const nextRetryMs = eligible.length ? autoRetryDelayMs(Math.max(...eligible.map((a) => a.attempts))) : null;
      await audit(tx, { agencyId, actorUserId: null, action: 'quote.send_finished', entityType: 'quote', entityId: quote.id, metadata: { version: v.versionNumber, status, failed: failed.length, autoRetryInMs: nextRetryMs } });
      return { quoteId: quote.id, versionNumber: v.versionNumber, versionStatus: status, quoteStatus: nextQuote, attempts: attempts.map((a) => ({ kind: a.kind, assetId: a.assetId, status: a.status, error: a.lastError })), retryable: retryableFailed.length > 0, nextRetryMs };
    });
    if (out.nextRetryMs !== null) await this.jobs.enqueue(agencyId, 'quote.retry', { versionId }, { delayMs: out.nextRetryMs });
    return out;
  }

  /** Called periodically by the worker. */
  async expireOverdue() {
    return this.db.system(async (tx) => (await tx.quote.updateMany({ where: { status: { in: ['sent', 'negotiating'] }, expiryAt: { lt: new Date() } }, data: { status: 'expired' } })).count);
  }
}

const effectiveStatus = (q: { status: string; expiryAt: Date | null }) => (['sent', 'negotiating'].includes(q.status) && q.expiryAt && q.expiryAt < new Date() ? 'expired' : q.status);

function daysBetween(a: string, b?: string | null) {
  if (!b) return 1;
  return Math.max(1, Math.ceil((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
}

function mergeInput(prev: DraftInput, patch: z.infer<typeof patchSchema>): DraftInput {
  const m: any = { ...prev, ...patch };
  if (patch.trip) m.trip = { ...prev.trip, ...patch.trip };
  if (patch.overrides) m.overrides = patch.overrides;
  return draftSchema.parse(m);
}

function asResult(v: any): PricingResult {
  return { currency: 'INR', lines: v.lines, subtotal: dec(v.subtotal), discount: dec(v.discount), taxableBase: '0', tax: dec(v.tax), total: dec(v.total), taxMode: 'exclusive', taxRatePercent: '0' };
}
