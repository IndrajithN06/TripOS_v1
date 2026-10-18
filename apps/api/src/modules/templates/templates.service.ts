import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { WhatsappTemplate } from '@prisma/client';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { AssetService } from '../../common/assets';
import { config } from '../../config/config';
import { Db, Tx } from '../../db/db.service';
import { TemplateExtra } from '../inbox/outbound.service';
import { WaSendError, WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';
import { RenderModel, renderQuotePdf } from '../quotes/quote-render';
import { mapTemplateStatus, WhatsappAccountService } from '../whatsapp/whatsapp-account.service';
import {
  buildSendParts, compile, extractVariables, PURPOSES, Preview, renderPreview, requiredVariables, resolveValues, sampleFor, TemplateSpec, toMetaComponents, toNamedBody,
  validateTemplate, VARIABLES,
} from './template-spec';

// ------------------------------------------------------------------------------------------- input schemas

const buttonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quick_reply'), text: z.string().trim().max(60) }),
  z.object({ type: z.literal('url'), text: z.string().trim().max(60), url: z.string().trim().max(2100) }),
  z.object({ type: z.literal('phone'), text: z.string().trim().max(60), phone: z.string().trim().max(30) }),
]);
export const specSchema = z.object({
  purpose: z.enum(['quotation', 'followup', 'enquiry_ack', 'revised_quotation', 'custom']).default('custom'),
  header: z.object({ type: z.enum(['none', 'text', 'image', 'document']).default('none'), source: z.enum(['logo', 'vehicle_photo', 'custom', 'quote_pdf']).optional(), text: z.string().max(200).optional() }).default({ type: 'none' }),
  body: z.string().max(2000),
  footer: z.string().max(200).optional().nullable().transform((v) => v ?? undefined),
  buttons: z.array(buttonSchema).max(12).default([]),
});
const common = { name: z.string().trim().max(80), language: z.string().trim().default('en'), category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']).default('UTILITY'), headerMediaAssetId: z.string().uuid().nullable().optional() };
/** Builder form (named variables) or the older form (positional body + variable names), both accepted. */
export const templateInputSchema = z.union([
  z.object({ ...common, spec: specSchema }),
  z.object({ ...common, body: z.string().min(3).max(1024), variableSchema: z.array(z.string()).default([]), purpose: z.enum(['quotation', 'followup', 'enquiry_ack', 'revised_quotation', 'custom']).optional() }),
]);
export type TemplateInput = z.infer<typeof templateInputSchema>;

export interface PrepareContext { conversationId?: string; quoteId?: string; versionNumber?: number; useSnapshot?: boolean; overrides?: Record<string, string>; headerAssetId?: string }
export interface PreparedTemplate { variables: string[]; extra: TemplateExtra; preview: Preview; values: Record<string, string> }

const EDITABLE = ['local_draft', 'rejected'];

@Injectable()
export class TemplatesService {
  constructor(private readonly db: Db, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider, private readonly assets: AssetService, private readonly accounts: WhatsappAccountService) {}

  // ----------------------------------------------------------------------------------------- views

  specOf(t: WhatsappTemplate): TemplateSpec {
    if (t.spec) return specSchema.parse(t.spec) as TemplateSpec;
    // Templates imported from Meta (or created before the builder existed): body + variable names only.
    return { purpose: (t.purpose as TemplateSpec['purpose']) ?? 'custom', header: { type: 'none' }, body: toNamedBody(t.body, (t.variableSchema as string[]) ?? []), buttons: [] };
  }

  view(t: WhatsappTemplate) {
    const spec = this.specOf(t);
    const registered = t.providerStatus !== 'local_draft' && !!t.providerTemplateId;
    return {
      id: t.id, name: t.name, language: t.language, category: t.category, purpose: t.purpose, purposeLabel: PURPOSES[t.purpose as keyof typeof PURPOSES] ?? t.purpose,
      status: t.providerStatus,
      /** Same value as `status`, and the body-variable names: kept so existing clients that read these fields keep working. */
      providerStatus: t.providerStatus, variableSchema: t.variableSchema,
      rejectedReason: t.rejectedReason, providerTemplateId: t.providerTemplateId, lastSyncedAt: t.lastSyncedAt,
      /** Where it lives: a TripOS draft that Meta has never seen, a template TripOS submitted, or one imported from Meta's manager. */
      origin: t.providerStatus === 'local_draft' ? 'local_draft' : t.spec ? 'submitted_by_tripos' : 'imported_from_meta',
      localDraft: t.providerStatus === 'local_draft', registeredWithMeta: registered,
      /** True only when a real provider (not the simulator) has reported this status. */
      providerConfirmed: registered && !this.wa.simulated,
      editable: EDITABLE.includes(t.providerStatus) && !!t.spec,
      spec, body: t.body, variables: compile(spec).bodyVariables, required: requiredVariables(spec),
      headerMediaAssetId: t.headerMediaAssetId, createdAt: t.createdAt, updatedAt: t.updatedAt,
    };
  }

  async list(agencyId: string, f: { status?: string; purpose?: string }) {
    return this.db.tenant(agencyId, async (tx) => {
      const rows = await tx.whatsappTemplate.findMany({ where: { agencyId, ...(f.status ? { providerStatus: f.status } : {}), ...(f.purpose ? { purpose: f.purpose } : {}) }, orderBy: [{ name: 'asc' }] });
      return rows.map((t) => this.view(t));
    });
  }

  private async load(tx: Tx, agencyId: string, id: string) {
    const t = await tx.whatsappTemplate.findFirst({ where: { id, agencyId } });
    if (!t) throw new NotFoundException({ code: 'not_found', message: 'Template not found' });
    return t;
  }

  async get(agencyId: string, id: string) { return this.db.tenant(agencyId, async (tx) => this.view(await this.load(tx, agencyId, id))); }

  // ----------------------------------------------------------------------------------------- create / update / duplicate / delete

  private normalise(input: TemplateInput) {
    if ('spec' in input) return { name: input.name, language: input.language, category: input.category, spec: input.spec as TemplateSpec, headerMediaAssetId: input.headerMediaAssetId ?? null };
    const placeholders = [...input.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const max = placeholders.length ? Math.max(...placeholders) : 0;
    if (input.variableSchema.length !== max) throw new BadRequestException({ code: 'variable_mismatch', message: `Template body uses ${max} variable(s) but ${input.variableSchema.length} are described` });
    return {
      name: input.name, language: input.language, category: input.category, headerMediaAssetId: null,
      spec: { purpose: input.purpose ?? 'custom', header: { type: 'none' }, body: toNamedBody(input.body, input.variableSchema), buttons: [] } as TemplateSpec,
    };
  }

  private async checked(tx: Tx, agencyId: string, n: ReturnType<TemplatesService['normalise']>) {
    const v = validateTemplate(n);
    if (v.errors.length) throw new BadRequestException({ code: 'template_invalid', message: v.errors[0].message, issues: v.errors.map((e) => ({ path: e.field, message: e.message })) });
    if (n.spec.header.type === 'image' && n.spec.header.source === 'custom') {
      const a = n.headerMediaAssetId ? await tx.asset.findFirst({ where: { id: n.headerMediaAssetId, agencyId, mimeType: { in: ['image/jpeg', 'image/png'] } } }) : null;
      if (!a) throw new BadRequestException({ code: 'template_invalid', message: 'Upload an image for the header, or choose another header source.', issues: [{ path: 'header.source', message: 'Upload an image for the header.' }] });
    }
    return v.warnings;
  }

  private data(n: ReturnType<TemplatesService['normalise']>) {
    const c = compile(n.spec);
    return { name: n.name, language: n.language, category: n.category, purpose: n.spec.purpose, spec: n.spec as object, body: c.body, variableSchema: c.bodyVariables, headerMediaAssetId: n.spec.header.type === 'image' && n.spec.header.source === 'custom' ? n.headerMediaAssetId : null };
  }

  async create(agencyId: string, actorId: string, input: TemplateInput) {
    const n = this.normalise(input);
    return this.db.tenant(agencyId, async (tx) => {
      const warnings = await this.checked(tx, agencyId, n);
      const t = await tx.whatsappTemplate.create({ data: { agencyId, ...this.data(n), providerStatus: 'local_draft' } });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'template.created', entityType: 'template', entityId: t.id, metadata: { purpose: t.purpose } });
      return { ...this.view(t), warnings: warnings.map((w) => ({ path: w.field, message: w.message })) };
    });
  }

  async update(agencyId: string, actorId: string, id: string, input: TemplateInput) {
    const n = this.normalise(input);
    return this.db.tenant(agencyId, async (tx) => {
      const t = await this.load(tx, agencyId, id);
      if (!EDITABLE.includes(t.providerStatus)) throw new ConflictException({ code: 'template_locked', message: `A template that is ${t.providerStatus} cannot be edited. Duplicate it to make a changed version.` });
      const warnings = await this.checked(tx, agencyId, n);
      const u = await tx.whatsappTemplate.update({ where: { id }, data: this.data(n) });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'template.updated', entityType: 'template', entityId: id });
      return { ...this.view(u), warnings: warnings.map((w) => ({ path: w.field, message: w.message })) };
    });
  }

  async duplicate(agencyId: string, actorId: string, id: string) {
    return this.db.tenant(agencyId, async (tx) => {
      const t = await this.load(tx, agencyId, id);
      const spec = this.specOf(t);
      const taken = new Set((await tx.whatsappTemplate.findMany({ where: { agencyId, language: t.language }, select: { name: true } })).map((x) => x.name));
      const base = t.name.replace(/_copy(_\d+)?$/, '').slice(0, 50);
      let name = `${base}_copy`;
      for (let i = 2; taken.has(name); i++) name = `${base}_copy_${i}`;
      const n = { name, language: t.language, category: t.category as 'UTILITY' | 'MARKETING' | 'AUTHENTICATION', spec, headerMediaAssetId: t.headerMediaAssetId };
      const c = await tx.whatsappTemplate.create({ data: { agencyId, ...this.data(n as any), providerStatus: 'local_draft' } });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'template.duplicated', entityType: 'template', entityId: c.id, metadata: { from: id } });
      return this.view(c);
    });
  }

  async remove(agencyId: string, actorId: string, id: string) {
    return this.db.tenant(agencyId, async (tx) => {
      const t = await this.load(tx, agencyId, id);
      if (t.providerStatus !== 'local_draft') throw new ConflictException({ code: 'template_locked', message: 'Only local drafts can be deleted. Templates registered with Meta must be removed in Meta Business Manager.' });
      await tx.whatsappTemplate.delete({ where: { id } });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'template.deleted', entityType: 'template', entityId: id });
      return { ok: true };
    });
  }

  /** Uploads an image used by a custom template header. Stored privately for this agency only. */
  async uploadMedia(agencyId: string, actorId: string, file: { buffer: Buffer } | undefined) {
    return this.db.tenant(agencyId, async (tx) => {
      const a = await this.assets.storeImage(tx, agencyId, actorId, file, 'template_media');
      return { assetId: a.id, url: await this.assets.url(a) };
    });
  }

  // ----------------------------------------------------------------------------------------- context, preview, prepare

  /** Real business data for the variables, from a conversation (customer) and/or a quote version. `useSnapshot` uses the branding the version was issued with. */
  async loadContext(tx: Tx, agencyId: string, o: { conversationId?: string; quoteId?: string; versionNumber?: number; useSnapshot?: boolean }) {
    const [agency, branding] = await Promise.all([tx.agency.findUniqueOrThrow({ where: { id: agencyId } }), tx.agencyBranding.findUniqueOrThrow({ where: { agencyId } })]);
    let customerName = '';
    let customerId: string | undefined;
    if (o.conversationId) {
      const conv = await tx.conversation.findFirst({ where: { id: o.conversationId, agencyId } });
      if (!conv) throw new NotFoundException({ code: 'not_found', message: 'Conversation not found' });
      customerId = conv.customerId;
    }
    let quote, version;
    if (o.quoteId) {
      quote = await tx.quote.findFirst({ where: { id: o.quoteId, agencyId, deletedAt: null } });
      if (!quote) throw new NotFoundException({ code: 'not_found', message: 'Quote not found' });
      version = await tx.quoteVersion.findFirst({ where: o.versionNumber ? { quoteId: quote.id, agencyId, versionNumber: o.versionNumber } : { id: quote.currentVersionId!, agencyId } });
      if (!version) throw new NotFoundException({ code: 'not_found', message: 'Quote version not found' });
      customerId ??= quote.customerId;
    }
    if (customerId) customerName = (await tx.customer.findFirst({ where: { id: customerId, agencyId } }))?.name ?? '';
    const snap = (version?.termsSnapshot ?? {}) as any;
    const brand = o.useSnapshot && version
      ? { name: snap.agencyName ?? agency.name, phone: snap.phone, email: snap.email, website: snap.website, logoAssetId: (snap.logoAssetId ?? null) as string | null }
      : { name: agency.name, phone: branding.phone, email: branding.email, website: branding.website, logoAssetId: branding.logoAssetId };
    const trip = (version?.trip ?? {}) as any;
    const images = version ? (await tx.quoteVersionImage.findMany({ where: { quoteVersionId: version.id }, orderBy: { sortOrder: 'asc' } })).map((i) => i.assetId) : [];
    const values = resolveValues({
      customerName, agency: brand, timezone: agency.timezone, publicBaseUrl: config().PUBLIC_QUOTE_BASE_URL ?? config().APP_URL,
      quote: version && quote ? { number: quote.quoteNumber, version: version.versionNumber, total: version.total.toString(), destinations: trip.destinations ?? [], pickupLocation: trip.pickupLocation, pickupAt: trip.pickupAt, returnAt: trip.returnAt, passengers: trip.passengers, vehicleName: version.vehicleName, validUntil: quote.expiryAt, publicToken: version.publicToken } : undefined,
    });
    return { values, agency, branding: brand, tz: agency.timezone, quote, version, imageAssetIds: images, pdfAssetId: version?.pdfAssetId ?? null, logoAssetId: brand.logoAssetId, brandColour: branding.brandColour };
  }

  private async defaultHeaderAsset(tx: Tx, agencyId: string, t: WhatsappTemplate, spec: TemplateSpec, ctx: Awaited<ReturnType<TemplatesService['loadContext']>>): Promise<string | null> {
    switch (spec.header.source) {
      case 'logo': return ctx.logoAssetId;
      case 'custom': return t.headerMediaAssetId;
      case 'quote_pdf': return ctx.pdfAssetId;
      case 'vehicle_photo': {
        if (ctx.imageAssetIds[0]) return ctx.imageAssetIds[0];
        if (!ctx.version) return null;
        const primary = await tx.vehicleTypeImage.findFirst({ where: { agencyId, vehicleTypeId: ctx.version.vehicleTypeId }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] });
        return primary?.assetId ?? null;
      }
      default: return null;
    }
  }

  /** What the customer would see. Builder: samples fill every gap. With real context: strict, gaps reported in `missing`. */
  async preview(agencyId: string, input: { spec?: TemplateSpec; templateId?: string; values?: Record<string, string>; conversationId?: string; quoteId?: string; versionNumber?: number }) {
    return this.db.tenant(agencyId, async (tx) => {
      let t: WhatsappTemplate | null = null;
      if (input.templateId) t = await this.load(tx, agencyId, input.templateId);
      const spec = input.spec ?? (t ? this.specOf(t) : null);
      if (!spec) throw new BadRequestException({ code: 'spec_required', message: 'Provide a template definition or a template id' });
      const ctx = await this.loadContext(tx, agencyId, input);
      const strict = !!(input.conversationId || input.quoteId);
      // Even the builder preview should look like THIS agency: real name/phone/contact, then catalogue samples for the rest.
      const brandSamples: Record<string, string> = { agency_name: ctx.branding.name, ...(ctx.branding.phone ? { agency_phone: ctx.branding.phone } : {}), ...(ctx.branding.email ? { agency_email: ctx.branding.email } : {}), ...(ctx.branding.website ? { agency_website: ctx.branding.website } : {}) };
      // An unsent version has no public link yet (it is minted at send time): show the shape of it so the preview is not blocked.
      const linkPending: Record<string, string> = ctx.version && !ctx.version.publicToken ? { quote_token: VARIABLES.quote_token.sample, quote_link: VARIABLES.quote_link.sample } : {};
      const values = { ...(strict ? {} : brandSamples), ...linkPending, ...ctx.values, ...Object.fromEntries(Object.entries(input.values ?? {}).filter(([, v]) => v.trim())) };
      const preview = renderPreview(spec, values, !strict);
      const media = await this.previewMedia(tx, agencyId, spec, t, ctx);
      const validation = t ? { errors: [], warnings: [] } : validateTemplate({ name: 'preview_only', language: 'en', category: 'UTILITY', spec });
      return { preview, headerMedia: media, brand: { name: ctx.branding.name, colour: ctx.brandColour }, values, issues: validation.errors.map((e) => ({ path: e.field, message: e.message })), warnings: validation.warnings.map((w) => ({ path: w.field, message: w.message })) };
    });
  }

  private async previewMedia(tx: Tx, agencyId: string, spec: TemplateSpec, t: WhatsappTemplate | null, ctx: Awaited<ReturnType<TemplatesService['loadContext']>>) {
    const h = spec.header;
    if (h.type !== 'image' && h.type !== 'document') return null;
    if (h.type === 'document') return { kind: 'document' as const, label: ctx.quote ? `${ctx.quote.quoteNumber}-v${ctx.version!.versionNumber}.pdf` : 'Quotation PDF (attached when sent)', url: null, missing: null };
    const id = t ? await this.defaultHeaderAsset(tx, agencyId, t, spec, ctx) : h.source === 'logo' ? ctx.logoAssetId : h.source === 'vehicle_photo' ? (ctx.imageAssetIds[0] ?? (await tx.vehicleTypeImage.findFirst({ where: { agencyId }, orderBy: { sortOrder: 'asc' } }))?.assetId ?? null) : null;
    const asset = id ? await tx.asset.findFirst({ where: { id, agencyId } }) : null;
    return { kind: 'image' as const, label: h.source === 'logo' ? 'Agency logo' : h.source === 'vehicle_photo' ? 'Vehicle photo' : 'Uploaded image', url: asset ? await this.assets.url(asset) : null, missing: asset ? null : h.source === 'logo' ? 'Upload your logo in Settings → Profile & branding.' : h.source === 'vehicle_photo' ? 'Pick a vehicle photo when sending (or add photos to a vehicle).' : 'No image uploaded yet.' };
  }

  /**
   * Turns a template + business context into exactly what must be sent. Strict: refuses (400, listing what is missing) rather
   * than sending a message with blanks or without its header media.
   */
  async prepare(tx: Tx, agencyId: string, t: WhatsappTemplate, c: PrepareContext): Promise<PreparedTemplate> {
    const spec = this.specOf(t);
    const compiled = compile(spec);
    const ctx = await this.loadContext(tx, agencyId, c);
    const values = { ...ctx.values, ...Object.fromEntries(Object.entries(c.overrides ?? {}).filter(([, v]) => v.trim())) };
    const { parts, missing } = buildSendParts(compiled, values);
    if (!parts) throw new BadRequestException({ code: 'template_variables_missing', message: `Fill in: ${missing.map((m) => VARIABLES[m]?.label ?? m).join(', ')}`, missing });

    const extra: TemplateExtra = { headerText: parts.headerText, buttons: parts.buttons.length ? parts.buttons : undefined };
    if (spec.header.type === 'image' || spec.header.type === 'document') {
      const id = c.headerAssetId ?? (await this.defaultHeaderAsset(tx, agencyId, t, spec, ctx));
      const wantMime = spec.header.type === 'image' ? ['image/jpeg', 'image/png'] : ['application/pdf'];
      const asset = id ? await tx.asset.findFirst({ where: { id, agencyId, mimeType: { in: wantMime } } }) : null;
      if (!asset) throw new BadRequestException({ code: 'template_media_required', message: spec.header.type === 'document' ? 'This template carries the quotation PDF: choose a quotation to send.' : spec.header.source === 'logo' ? 'This template shows your logo: upload one in Settings → Profile & branding.' : 'This template needs a header image: choose one before sending.' });
      extra.header = { assetId: asset.id, kind: spec.header.type, filename: spec.header.type === 'document' ? (ctx.quote ? `${ctx.quote.quoteNumber}-v${ctx.version!.versionNumber}.pdf` : 'quotation.pdf') : undefined };
    }
    return { variables: parts.bodyParams, extra, preview: renderPreview(spec, values, false), values };
  }

  // ----------------------------------------------------------------------------------------- submit to Meta

  private exampleSampler(agency: { name: string }, branding: { phone: string | null; email: string | null; website: string | null }) {
    return (n: string) => (n === 'agency_name' ? agency.name : n === 'agency_phone' && branding.phone ? branding.phone : n === 'agency_email' && branding.email ? branding.email : n === 'agency_website' && branding.website ? branding.website : sampleFor(n));
  }

  /** The example file Meta reviews for an image/document header, from the template's own source. */
  private async exampleMedia(tx: Tx, agencyId: string, t: WhatsappTemplate, spec: TemplateSpec) {
    const fromAsset = async (id: string | null | undefined, what: string) => {
      const a = id ? await tx.asset.findFirst({ where: { id, agencyId } }) : null;
      if (!a) throw new BadRequestException({ code: 'header_media_missing', message: what });
      return { data: await this.assets.storage.get(a.storageKey), mimeType: a.mimeType, filename: `header.${a.mimeType === 'image/png' ? 'png' : 'jpg'}` };
    };
    if (spec.header.type === 'document') {
      const [agency, branding] = await Promise.all([tx.agency.findUniqueOrThrow({ where: { id: agencyId } }), tx.agencyBranding.findUniqueOrThrow({ where: { agencyId } })]);
      const logo = branding.logoAssetId ? await tx.asset.findFirst({ where: { id: branding.logoAssetId, agencyId } }) : null;
      const pdf = await renderQuotePdf(sampleRenderModel(agency.name, branding, agency.timezone), logo ? await this.assets.storage.get(logo.storageKey) : null, []);
      return { data: pdf, mimeType: 'application/pdf', filename: 'sample-quotation.pdf' };
    }
    switch (spec.header.source) {
      case 'logo': return fromAsset((await tx.agencyBranding.findUniqueOrThrow({ where: { agencyId } })).logoAssetId, 'Upload your agency logo in Settings → Profile & branding before submitting a template with a logo header.');
      case 'custom': return fromAsset(t.headerMediaAssetId, 'Upload a header image before submitting.');
      default: {
        const photo = await tx.vehicleTypeImage.findFirst({ where: { agencyId }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] });
        return fromAsset(photo?.assetId, 'Add a photo to a vehicle type first: Meta needs an example image to review a vehicle-photo header.');
      }
    }
  }

  async submit(agencyId: string, actorId: string, id: string) {
    // Template first: an id from another agency is a plain 404, whatever the state of this agency's WhatsApp connection.
    const t = await this.db.tenant(agencyId, (tx) => this.load(tx, agencyId, id));
    const account = await this.accounts.load(agencyId);
    if (!EDITABLE.includes(t.providerStatus)) throw new BadRequestException({ code: 'already_submitted', message: `This template is already ${t.providerStatus}` });
    const spec = this.specOf(t);
    const v = validateTemplate({ name: t.name, language: t.language, category: t.category, spec });
    if (v.errors.length) throw new BadRequestException({ code: 'template_invalid', message: v.errors[0].message, issues: v.errors.map((e) => ({ path: e.field, message: e.message })) });

    const creds = this.accounts.creds(account);
    const guard = (what: string) => async (e: unknown): Promise<never> => {
      if (e instanceof WaSendError && (e.kind === 'auth' || e.kind === 'account')) await this.accounts.recordFailure(agencyId, e);
      throw this.accounts.failure(e, what);
    };
    const { sampler, example } = await this.db.tenant(agencyId, async (tx) => {
      const [agency, branding] = await Promise.all([tx.agency.findUniqueOrThrow({ where: { id: agencyId } }), tx.agencyBranding.findUniqueOrThrow({ where: { agencyId } })]);
      return { sampler: this.exampleSampler(agency, branding), example: spec.header.type === 'image' || spec.header.type === 'document' ? await this.exampleMedia(tx, agencyId, t, spec) : null };
    });
    const headerHandle = example ? await this.wa.uploadTemplateExample(creds, example).catch(guard('Could not upload the header example to Meta')) : undefined;
    const components = toMetaComponents(compile(spec), { headerHandle, sample: sampler });
    const res = await this.wa.submitTemplate(creds, { name: t.name, language: t.language, category: t.category, components }).catch(guard('Meta rejected the template submission'));

    // Submitted is NOT approved: the provider's own status (normally PENDING) is what we store.
    const status = mapTemplateStatus(res.status) ?? 'pending';
    return this.db.tenant(agencyId, async (tx) => {
      const u = await tx.whatsappTemplate.update({ where: { id: t.id }, data: { providerTemplateId: res.providerTemplateId, providerStatus: this.wa.simulated && status === 'pending' ? 'submitted' : status, rejectedReason: null, lastSyncedAt: new Date() } });
      await audit(tx, { agencyId, actorUserId: actorId, action: 'template.submitted', entityType: 'template', entityId: t.id, metadata: { providerStatus: u.providerStatus, header: spec.header.type, buttons: spec.buttons.length } });
      return { ...this.view(u), warnings: v.warnings.map((w) => ({ path: w.field, message: w.message })) };
    });
  }

  /** Templates an agency may send, best match for a purpose first. */
  async approvedFor(agencyId: string, purposes: string[]) {
    const all = (await this.list(agencyId, { status: 'approved' }));
    const rank = (p: string) => { const i = purposes.indexOf(p); return i === -1 ? 99 : i; };
    return all.sort((a, b) => rank(a.purpose) - rank(b.purpose) || a.name.localeCompare(b.name));
  }

  extractVariables = extractVariables;
}

/** Sample quotation used as the example document when a template has a PDF header. */
export function sampleRenderModel(agencyName: string, b: { brandColour: string; tagline: string | null; phone: string | null; email: string | null; website: string | null; address: string | null; footer: string | null }, timezone: string): RenderModel {
  const now = new Date();
  return {
    quoteNumber: 'Q-0001', versionNumber: 1, createdAt: now, expiryAt: new Date(now.getTime() + 7 * 86400000),
    customer: { name: VARIABLES.customer_name.sample, phone: '+91 98000 00000' },
    brand: { agencyName, tagline: b.tagline, brandColour: b.brandColour, phone: b.phone, email: b.email, website: b.website, address: b.address, footer: b.footer, timezone },
    trip: { pickupLocation: 'Bangalore Airport', pickupAt: new Date(now.getTime() + 2 * 86400000).toISOString(), returnAt: new Date(now.getTime() + 5 * 86400000).toISOString(), destinations: ['Coorg'], passengers: 5, itinerary: 'Day 1: Bangalore to Coorg\nDay 2: Sightseeing\nDay 3: Return' },
    vehicleName: 'Innova Crysta',
    lines: [{ label: 'Outstation distance (900 km billable)', quantity: '900', unitAmount: '20.00', amount: '18000.00' }, { label: 'Driver batta (per day)', quantity: '3', unitAmount: '800.00', amount: '2400.00' }],
    subtotal: '20400.00', discount: '0.00', tax: '0.00', total: '20400.00', taxMode: 'exclusive', taxRatePercent: '0',
    inclusions: 'Fuel, driver, vehicle', exclusions: 'Toll, parking, permits', notes: null, terms: 'Sample document for template review.',
  };
}
