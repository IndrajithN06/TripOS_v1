import { INestApplication } from '@nestjs/common';
import { Db } from '../src/db/db.service';
import { SimulatorWhatsApp, WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { boot, Client, createVehicle, inboundMessage, onboard, superAdmin, Tenant, tripOutstation } from './helpers';

/** Delivery order is part of the contract: text first, then the PDF, then photos in the order staff chose. */
describe('Quote delivery order is deterministic', () => {
  let app: INestApplication, sa: Client, T: Tenant, wa: SimulatorWhatsApp;
  beforeAll(async () => { app = await boot(); wa = app.get(WHATSAPP) as SimulatorWhatsApp; sa = await superAdmin(app); T = await onboard(app, sa, 'Order'); });
  afterAll(async () => { await app.close(); });

  it('every delivery item has its own timestamp, and sends happen text -> pdf -> photos in the chosen order', async () => {
    const v = await createVehicle(T.admin, 'OrderCar', 4);
    await inboundMessage(app, T, '+919500000099', 'hi');
    const conv = (await T.admin.get('/inbox/conversations')).body.items[0].id;
    for (let round = 0; round < 5; round++) {                                  // repeat: ties would make this flaky
      const chosen = [v.images[3].assetId, v.images[1].assetId, v.images[2].assetId, v.images[0].assetId];
      const q = (await T.admin.post('/quotes', { conversationId: conv, vehicleTypeId: v.id, trip: tripOutstation(), imageAssetIds: chosen })).body;
      const sentBefore = wa.sent.length;
      const r = await T.admin.post(`/quotes/${q.id}/versions/1/send`);
      expect(r.body.attempts.map((a: any) => a.kind)).toEqual(['text', 'pdf', 'image', 'image', 'image', 'image']);
      expect(r.body.attempts.filter((a: any) => a.kind === 'image').map((a: any) => a.assetId)).toEqual(chosen);
      expect(wa.sent.slice(sentBefore).map((s) => s.kind)).toEqual(['text', 'document', 'image', 'image', 'image', 'image']);
      const rows = await app.get(Db).tenant(T.agencyId, (tx) => tx.quoteSendAttempt.findMany({ where: { quoteVersionId: q.currentVersionId } }));
      expect(new Set(rows.map((x) => x.createdAt.getTime())).size).toBe(rows.length);
    }
  });
});
