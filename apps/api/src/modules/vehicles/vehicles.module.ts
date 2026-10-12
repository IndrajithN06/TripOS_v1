import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RateSnapshot } from '@tripos/pricing';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { AssetService, MAX_IMAGE_BYTES } from '../../common/assets';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { Db, Tx } from '../../db/db.service';

export const money = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,14}(\.\d{1,2})?$/.test(v), 'Enter a non-negative amount with at most 2 decimals');
const optMoney = money.nullable().optional();

export const rateSchema = z.object({
  local8hHours: z.number().int().min(1).max(24).default(8), local8hKm: z.number().int().min(1).max(1000).default(80), local8h80kmPrice: money,
  local4hHours: z.number().int().min(1).max(24).default(4), local4hKm: z.number().int().min(1).max(1000).default(40), local4h40kmPrice: money,
  extraHourRate: money, extraKmRate: money, outstationRatePerKm: money, minKmPerDay: z.number().int().min(0).max(2000), driverBattaPerDay: money,
  defaultToll: optMoney, defaultParking: optMoney, defaultPermit: optMoney, defaultInterstateTax: optMoney,
});
const typeSchema = z.object({
  name: z.string().min(2).max(80), category: z.string().min(2).max(40), seats: z.number().int().min(1).max(80),
  description: z.string().max(600).nullable().optional(), amenities: z.array(z.string().max(40)).max(20).default([]),
});

export function toSnapshot(r: any): RateSnapshot {
  const s = (v: any) => (v === null || v === undefined ? undefined : v.toString());
  return {
    local8h80kmPrice: r.local8h80kmPrice.toString(), local4h40kmPrice: r.local4h40kmPrice.toString(),
    localSlabA: { hours: r.local8hHours, km: r.local8hKm }, localSlabB: { hours: r.local4hHours, km: r.local4hKm },
    extraHourRate: r.extraHourRate.toString(), extraKmRate: r.extraKmRate.toString(), outstationRatePerKm: r.outstationRatePerKm.toString(),
    minKmPerDay: r.minKmPerDay, driverBattaPerDay: r.driverBattaPerDay.toString(),
    defaults: { toll: s(r.defaultToll), parking: s(r.defaultParking), permit: s(r.defaultPermit), interstateTax: s(r.defaultInterstateTax) },
  };
}

@Controller('agency/vehicle-types')
export class VehiclesController {
  constructor(private readonly db: Db, private readonly assets: AssetService) {}

  private async view(tx: Tx, agencyId: string, vt: any) {
    const [rate, images] = await Promise.all([
      tx.vehicleRate.findFirst({ where: { agencyId, vehicleTypeId: vt.id }, orderBy: { effectiveAt: 'desc' } }),
      tx.vehicleTypeImage.findMany({ where: { agencyId, vehicleTypeId: vt.id }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const assets = await tx.asset.findMany({ where: { id: { in: images.map((i) => i.assetId) } } });
    const byId = new Map(assets.map((a) => [a.id, a]));
    return {
      ...vt,
      rate: rate && Object.fromEntries(Object.entries(rate).map(([k, v]) => [k, v !== null && typeof v === 'object' && 'toFixed' in (v as any) ? v.toString() : v])),
      images: await Promise.all(images.map(async (i) => ({ id: i.id, assetId: i.assetId, sortOrder: i.sortOrder, isPrimary: i.isPrimary, caption: i.caption, altText: i.altText, url: await this.assets.url(byId.get(i.assetId)!) }))),
    };
  }

  @Get()
  list(@CurrentUser() p: Principal, @Query('includeArchived') inc?: string) {
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const types = await tx.vehicleType.findMany({ where: { agencyId, ...(inc === 'true' ? {} : { active: true }) }, orderBy: { name: 'asc' } });
      return Promise.all(types.map((t) => this.view(tx, agencyId, t)));
    });
  }

  @Get(':id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const t = await tx.vehicleType.findFirst({ where: { id, agencyId } });
      if (!t) throw new NotFoundException({ code: 'not_found', message: 'Vehicle type not found' });
      return this.view(tx, agencyId, t);
    });
  }

  @Roles('AGENCY_ADMIN')
  @Post()
  create(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(typeSchema.extend({ rate: rateSchema }), body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const { rate, ...fields } = b;
      const t = await tx.vehicleType.create({ data: { agencyId, ...fields } });
      await tx.vehicleRate.create({ data: { agencyId, vehicleTypeId: t.id, ...rate } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'vehicle_type.created', entityType: 'vehicle_type', entityId: t.id });
      return this.view(tx, agencyId, t);
    });
  }

  @Roles('AGENCY_ADMIN')
  @Patch(':id')
  update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(typeSchema.partial().extend({ rate: rateSchema.optional() }), body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const existing = await tx.vehicleType.findFirst({ where: { id, agencyId } });
      if (!existing) throw new NotFoundException({ code: 'not_found', message: 'Vehicle type not found' });
      const { rate, ...fields } = b;
      const t = Object.keys(fields).length ? await tx.vehicleType.update({ where: { id }, data: fields }) : existing;
      if (rate) {
        // Rate cards are append-only: old rows remain as history; quotes keep their own snapshot anyway.
        const before = await tx.vehicleRate.findFirst({ where: { agencyId, vehicleTypeId: id }, orderBy: { effectiveAt: 'desc' } });
        await tx.vehicleRate.create({ data: { agencyId, vehicleTypeId: id, ...rate } });
        await audit(tx, { agencyId, actorUserId: p.userId, action: 'vehicle_rate.changed', entityType: 'vehicle_type', entityId: id, metadata: { before: before && toSnapshot(before), after: rate } });
      } else await audit(tx, { agencyId, actorUserId: p.userId, action: 'vehicle_type.updated', entityType: 'vehicle_type', entityId: id });
      return this.view(tx, agencyId, t);
    });
  }

  @Roles('AGENCY_ADMIN')
  @Post(':id/archive')
  archive(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.setActive(p, id, false); }

  @Roles('AGENCY_ADMIN')
  @Post(':id/restore')
  restore(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.setActive(p, id, true); }

  private setActive(p: Principal, id: string, active: boolean) {
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const r = await tx.vehicleType.updateMany({ where: { id, agencyId }, data: { active } });
      if (!r.count) throw new NotFoundException({ code: 'not_found', message: 'Vehicle type not found' });
      await audit(tx, { agencyId, actorUserId: p.userId, action: active ? 'vehicle_type.restored' : 'vehicle_type.archived', entityType: 'vehicle_type', entityId: id });
      return { id, active };
    });
  }

  // ---- images ----
  @Roles('AGENCY_ADMIN')
  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  upload(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File, @Body() body: Record<string, string>) {
    const agencyId = agencyOf(p);
    const meta = parse(z.object({ caption: z.string().max(200).optional(), altText: z.string().max(200).optional() }), body ?? {});
    return this.db.tenant(agencyId, async (tx) => {
      if (!(await tx.vehicleType.findFirst({ where: { id, agencyId } }))) throw new NotFoundException({ code: 'not_found', message: 'Vehicle type not found' });
      const count = await tx.vehicleTypeImage.count({ where: { agencyId, vehicleTypeId: id } });
      if (count >= 12) throw new BadRequestException({ code: 'too_many_images', message: 'A vehicle type can have at most 12 photos' });
      const asset = await this.assets.storeImage(tx, agencyId, p.userId, file, 'vehicle_image');
      const img = await tx.vehicleTypeImage.create({ data: { agencyId, vehicleTypeId: id, assetId: asset.id, sortOrder: count, isPrimary: count === 0, caption: meta.caption, altText: meta.altText } });
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'vehicle_image.uploaded', entityType: 'vehicle_type', entityId: id, metadata: { imageId: img.id } });
      return { id: img.id, assetId: asset.id, url: await this.assets.url(asset), isPrimary: img.isPrimary, sortOrder: img.sortOrder };
    });
  }

  @Roles('AGENCY_ADMIN')
  @Put(':id/images/order')
  reorder(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1) }), body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const imgs = await tx.vehicleTypeImage.findMany({ where: { agencyId, vehicleTypeId: id } });
      if (imgs.length !== ids.length || !imgs.every((i) => ids.includes(i.id))) throw new BadRequestException({ code: 'bad_order', message: 'Order must list every image exactly once' });
      await Promise.all(ids.map((imgId, idx) => tx.vehicleTypeImage.update({ where: { id: imgId }, data: { sortOrder: idx } })));
      return { ok: true };
    });
  }

  @Roles('AGENCY_ADMIN')
  @Patch(':id/images/:imageId')
  updateImage(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('imageId', ParseUUIDPipe) imageId: string, @Body() body: unknown) {
    const b = parse(z.object({ caption: z.string().max(200).nullable().optional(), altText: z.string().max(200).nullable().optional(), isPrimary: z.literal(true).optional() }), body);
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const img = await tx.vehicleTypeImage.findFirst({ where: { id: imageId, vehicleTypeId: id, agencyId } });
      if (!img) throw new NotFoundException({ code: 'not_found', message: 'Image not found' });
      if (b.isPrimary) await tx.vehicleTypeImage.updateMany({ where: { agencyId, vehicleTypeId: id }, data: { isPrimary: false } });
      await tx.vehicleTypeImage.update({ where: { id: imageId }, data: b });
      return { ok: true };
    });
  }

  @Roles('AGENCY_ADMIN')
  @Delete(':id/images/:imageId')
  remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('imageId', ParseUUIDPipe) imageId: string) {
    const agencyId = agencyOf(p);
    return this.db.tenant(agencyId, async (tx) => {
      const img = await tx.vehicleTypeImage.findFirst({ where: { id: imageId, vehicleTypeId: id, agencyId } });
      if (!img) throw new NotFoundException({ code: 'not_found', message: 'Image not found' });
      await tx.vehicleTypeImage.delete({ where: { id: imageId } });
      const rest = await tx.vehicleTypeImage.findMany({ where: { agencyId, vehicleTypeId: id }, orderBy: { sortOrder: 'asc' } });
      if (img.isPrimary && rest[0]) await tx.vehicleTypeImage.update({ where: { id: rest[0].id }, data: { isPrimary: true } });
      // The file is kept if any sent quote version references it, so history stays intact.
      const referenced = await tx.quoteVersionImage.count({ where: { agencyId, assetId: img.assetId } });
      if (!referenced) {
        const a = await tx.asset.delete({ where: { id: img.assetId } });
        await this.assets.storage.delete(a.storageKey);
      }
      await audit(tx, { agencyId, actorUserId: p.userId, action: 'vehicle_image.removed', entityType: 'vehicle_type', entityId: id, metadata: { imageId } });
      return { ok: true };
    });
  }
}
