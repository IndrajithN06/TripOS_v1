import { INestApplication } from '@nestjs/common';
import { Db } from '../src/db/db.service';
import { SimulatorWhatsApp, WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { boot, Client, createVehicle, inboundMessage, onboard, superAdmin, Tenant, tripOutstation } from './helpers';

/**
 * Photo selection must be exactly what staff chose, persisted through draft save, vehicle change, requote and send.
 * (The quote builder pre-selects the primary photo and sends the ids explicitly; these tests pin the server side.)
 */
describe('Quote photo selection persistence', () => {
  let app: INestApplication, sa: Client, T: Tenant, wa: SimulatorWhatsApp, db: Db;
  let A: Awaited<ReturnType<typeof createVehicle>>, B: Awaited<ReturnType<typeof createVehicle>>, convId: string;
  const ids = (v: { images: any[] }) => v.images.map((i) => i.assetId);
  const primary = (v: { images: any[] }) => v.images.find((i) => i.isPrimary).assetId as string;

  beforeAll(async () => {
    app = await boot();
    wa = app.get(WHATSAPP) as SimulatorWhatsApp;
    db = app.get(Db);
    sa = await superAdmin(app);
    T = await onboard(app, sa, 'Photos');
    A = await createVehicle(T.admin, 'Urbania-ish', 3);
    B = await createVehicle(T.admin, 'Crysta-ish', 2);
    await inboundMessage(app, T, '+919500000001', 'need a vehicle');
    convId = (await T.admin.get('/inbox/conversations')).body.items[0].id;
  });
  afterAll(async () => { await app.close(); });

  const create = async (vehicle: { id: string }, photos: string[]) => (await T.admin.post('/quotes', { conversationId: convId, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: photos })).body;
  const versionPhotos = async (quoteId: string, n: number) => db.tenant(T.agencyId, async (tx) => {
    const v = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId, versionNumber: n } });
    return (await tx.quoteVersionImage.findMany({ where: { quoteVersionId: v.id }, orderBy: { sortOrder: 'asc' } })).map((i) => i.assetId);
  });
  const get = async (quoteId: string) => (await T.admin.get(`/quotes/${quoteId}`)).body;

  it('a draft keeps exactly the selected photos; changing or clearing the selection replaces the links', async () => {
    const q = await create(A, [primary(A)]);
    expect(q.versions[0].imageAssetIds).toEqual([primary(A)]);
    expect(await versionPhotos(q.id, 1)).toEqual([primary(A)]);

    const two = await T.admin.patch(`/quotes/${q.id}/draft`, { imageAssetIds: [ids(A)[2], ids(A)[1]] });
    expect(two.body.versions[0].imageAssetIds).toEqual([ids(A)[2], ids(A)[1]]);   // order is the user's order
    expect(await versionPhotos(q.id, 1)).toEqual([ids(A)[2], ids(A)[1]]);

    const none = await T.admin.patch(`/quotes/${q.id}/draft`, { imageAssetIds: [] });
    expect(none.body.versions[0].imageAssetIds).toEqual([]);
    expect(await versionPhotos(q.id, 1)).toEqual([]);

    const again = await T.admin.patch(`/quotes/${q.id}/draft`, { imageAssetIds: [ids(A)[0]] }); // can choose something else afterwards
    expect(again.body.versions[0].imageAssetIds).toEqual([ids(A)[0]]);
  });

  it('changing the vehicle: the previous vehicle\'s photos are rejected, the new vehicle\'s primary persists, old links are gone', async () => {
    const q = await create(A, [primary(A)]);
    const stale = await T.admin.patch(`/quotes/${q.id}/draft`, { vehicleTypeId: B.id, imageAssetIds: [primary(A)] });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('bad_images');
    const unchanged = await get(q.id);                                             // nothing half-saved
    expect(unchanged.versions[0].vehicleName).toBe('Urbania-ish');
    expect(unchanged.versions[0].imageAssetIds).toEqual([primary(A)]);

    const ok = await T.admin.patch(`/quotes/${q.id}/draft`, { vehicleTypeId: B.id, imageAssetIds: [primary(B)] });
    expect(ok.status).toBe(200);
    expect(ok.body.versions[0].vehicleName).toBe('Crysta-ish');
    expect(await versionPhotos(q.id, 1)).toEqual([primary(B)]);
    expect((await versionPhotos(q.id, 1)).some((a) => ids(A).includes(a))).toBe(false);
  });

  it('sending creates exactly one image message per selected photo, in order, and none when nothing is selected', async () => {
    const chosen = [ids(A)[2], ids(A)[0]];
    const q = await create(A, chosen);
    const imagesBefore = wa.sent.filter((s) => s.kind === 'image').length;
    const r = await T.admin.post(`/quotes/${q.id}/versions/1/send`);
    expect(r.body.versionStatus).toBe('sent');
    const items = (await get(q.id)).versions[0].sendAttempts;
    expect(items.map((i: any) => i.kind)).toEqual(['text', 'pdf', 'image', 'image']);
    expect(items.filter((i: any) => i.kind === 'image').map((i: any) => i.assetId)).toEqual(chosen);
    expect(wa.sent.filter((s) => s.kind === 'image').length - imagesBefore).toBe(2);
    const audit = (await T.admin.get('/agency/audit')).body.find((a: any) => a.action === 'quote.send_requested' && a.entityId === q.id);
    expect(audit.metadata.images).toBe(2);

    const bare = await create(A, []);
    const before = wa.sent.filter((s) => s.kind === 'image').length;
    await T.admin.post(`/quotes/${bare.id}/versions/1/send`);
    expect((await get(bare.id)).versions[0].sendAttempts.map((i: any) => i.kind)).toEqual(['text', 'pdf']);
    expect(wa.sent.filter((s) => s.kind === 'image').length).toBe(before);
  });

  it('requote keeps or replaces the selection as asked, never alters the sent version, and rejects stale photos on a vehicle change', async () => {
    const q = await create(A, [primary(A)]);
    await T.admin.post(`/quotes/${q.id}/versions/1/send`);

    const keep = await T.admin.post(`/quotes/${q.id}/versions`, { notes: 'revised wording' });   // no photo list supplied
    expect(keep.status).toBe(201);
    expect(keep.body.versions[1].imageAssetIds).toEqual([primary(A)]);

    const replaced = await T.admin.patch(`/quotes/${q.id}/draft`, { imageAssetIds: [ids(A)[1], ids(A)[2]] });
    expect(replaced.body.versions[1].imageAssetIds).toEqual([ids(A)[1], ids(A)[2]]);
    expect(await versionPhotos(q.id, 1)).toEqual([primary(A)]);                                  // v1 untouched
    expect((await T.admin.patch(`/quotes/${q.id}/draft`, { imageAssetIds: [] })).body.versions[1].imageAssetIds).toEqual([]);

    // a sent version's photos cannot be changed even with raw SQL
    await expect(db.system((tx) => tx.$executeRaw`DELETE FROM "QuoteVersionImage" WHERE "quoteVersionId" IN (SELECT id FROM "QuoteVersion" WHERE "quoteId" = ${q.id}::uuid AND "versionNumber" = 1)`)).rejects.toThrow(/cannot change/i);

    // second quote: switching vehicle on requote without a fresh, matching photo list must not silently carry A's photos to B
    const q2 = await create(A, [primary(A)]);
    await T.admin.post(`/quotes/${q2.id}/versions/1/send`);
    const carry = await T.admin.post(`/quotes/${q2.id}/versions`, { vehicleTypeId: B.id });
    expect(carry.status).toBe(400);
    expect(carry.body.error.code).toBe('bad_images');
    const sw = await T.admin.post(`/quotes/${q2.id}/versions`, { vehicleTypeId: B.id, imageAssetIds: [primary(B)] });
    expect(sw.status).toBe(201);
    expect(sw.body.versions[1].vehicleName).toBe('Crysta-ish');
    expect(await versionPhotos(q2.id, 2)).toEqual([primary(B)]);
    expect(await versionPhotos(q2.id, 1)).toEqual([primary(A)]);
  });
});
