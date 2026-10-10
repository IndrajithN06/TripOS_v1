import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { calculateQuote, diffResults, PricingInput, PricingResult } from '@tripos/pricing';
import { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { AssetService } from '../../common/assets';
import { Principal } from '../../common/auth';
import { Db, Tx } from '../../db/db.service';
import { OutboundService } from '../inbox/outbound.service';
import { JobsService } from '../jobs/jobs.service';
import { money, toSnapshot } from '../vehicles/vehicles.module';
import { quoteMessageText, renderQuotePdf, RenderModel } from './quote-render';

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
  constructor(private readonly db: Db, private readonly assets: AssetService, private readonly outbound: OutboundService, private readonly jobs: JobsService) {}

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
      await tx.quoteSendAttempt.createMany({ data: kinds.map((k) => ({ agencyId, quoteVersionId: version.id, kind: k.kind, assetId: k.assetId })) });
      await tx.quote.update({ where: { id: quote.id }, data: { followUpAt: opts.followUpAt ? new Date(opts.followUpAt) : quote.followUpAt } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'quote.send_requested', entityType: 'quote', entityId: quoteId, metadata: { version: versionNumber, total: dec(version.total), images: m.photoAssets.length } });
      return version.id;
    });
    return this.execute(agencyId, versionId, p.userId);
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

  /** Processes only pending/failed attempts, so retries never re-send what the customer already has. */
  async execute(agencyId: string, versionId: string, userId: string | null) {
    const ctx = await this.db.tenant(agencyId, async (tx) => {
      const v = await tx.quoteVersion.findFirstOrThrow({ where: { id: versionId, agencyId } });
      const quote = await tx.quote.findFirstOrThrow({ where: { id: v.quoteId, agencyId } });
      const attempts = await tx.quoteSendAttempt.findMany({ where: { quoteVersionId: versionId, agencyId, status: { in: ['pending', 'failed'] } }, orderBy: { createdAt: 'asc' } });
      const m = await this.model(tx, agencyId, quote.id, v.versionNumber);
      const caps = new Map(m.captions.map((c) => [c.assetId, c.caption]));
      return { v, quote, attempts, text: quoteMessageText(m.model), filename: `${quote.quoteNumber}-v${v.versionNumber}.pdf`, caps, convId: quote.conversationId! };
    });

    for (const a of ctx.attempts) {
      const payload = a.kind === 'text' ? ({ kind: 'text', text: ctx.text } as const)
        : a.kind === 'pdf' ? ({ kind: 'document', assetId: a.assetId!, filename: ctx.filename, caption: `Quotation ${ctx.quote.quoteNumber}` } as const)
        : ({ kind: 'image', assetId: a.assetId!, caption: ctx.caps.get(a.assetId!) ?? undefined } as const);
      let r;
      try { r = await this.outbound.send(agencyId, ctx.convId, payload, { userId, idempotencyKey: `qsa:${a.id}` }); }
      catch (e: any) { r = { ok: false, messageId: '', status: 'failed', errorCode: e?.response?.code ?? 'error', errorMessage: e?.response?.message ?? e?.message ?? 'Send failed' }; }
      await this.db.tenant(agencyId, async (tx) => {
        await tx.quoteSendAttempt.update({ where: { id: a.id }, data: { status: r.ok ? 'sent' : 'failed', attempts: { increment: 1 }, lastError: r.ok ? null : r.errorMessage, messageId: r.messageId || undefined } });
        if (r.ok) await tx.quoteVersion.updateMany({ where: { id: versionId, sentAt: null }, data: { sentAt: new Date() } });
      });
    }
    return this.finalise(agencyId, versionId);
  }

  private async finalise(agencyId: string, versionId: string) {
    const out = await this.db.tenant(agencyId, async (tx) => {
      const v = await tx.quoteVersion.findFirstOrThrow({ where: { id: versionId, agencyId } });
      const quote = await tx.quote.findFirstOrThrow({ where: { id: v.quoteId, agencyId } });
      const attempts = await tx.quoteSendAttempt.findMany({ where: { quoteVersionId: versionId, agencyId }, orderBy: { createdAt: 'asc' } });
      const okCount = attempts.filter((a) => a.status === 'sent').length;
      const status = okCount === attempts.length ? 'sent' : okCount === 0 ? 'failed' : 'partially_sent';
      await tx.quoteVersion.update({ where: { id: versionId }, data: { status } });
      const pdfSent = attempts.find((a) => a.kind === 'pdf')?.status === 'sent';
      const nextQuote = pdfSent ? (['draft', 'ready_to_send', 'send_failed', 'negotiating'].includes(quote.status) ? 'sent' : quote.status) : quote.status === 'sent' || quote.status === 'negotiating' ? quote.status : 'send_failed';
      await tx.quote.update({ where: { id: quote.id }, data: { status: nextQuote } });
      const failed = attempts.filter((a) => a.status === 'failed');
      await audit(tx, { agencyId, actorUserId: null, action: 'quote.send_finished', entityType: 'quote', entityId: quote.id, metadata: { version: v.versionNumber, status, failed: failed.length } });
      return { quoteId: quote.id, versionNumber: v.versionNumber, versionStatus: status, quoteStatus: nextQuote, attempts: attempts.map((a) => ({ kind: a.kind, assetId: a.assetId, status: a.status, error: a.lastError })), retryable: failed.some((a) => !/window_closed|closed|not_connected|approved/i.test(a.lastError ?? '')) };
    });
    if (out.versionStatus !== 'sent') await this.jobs.enqueue(agencyId, 'quote.retry', { versionId }, { delayMs: 60_000 });
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
