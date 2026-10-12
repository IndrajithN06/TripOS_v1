import { INestApplication } from '@nestjs/common';
import { boot, Client, createVehicle, inboundMessage, onboard, superAdmin, Tenant, tripOutstation } from './helpers';

describe('Dashboard analytics', () => {
  let app: INestApplication, A: Tenant, B: Tenant;

  beforeAll(async () => {
    app = await boot();
    const sa = await superAdmin(app);
    A = await onboard(app, sa, 'AnA');
    B = await onboard(app, sa, 'AnB');
    const v = await createVehicle(A.admin, 'Crysta', 1);
    for (const [i, phone] of ['+919700000001', '+919700000002', '+919700000003'].entries()) await inboundMessage(app, A, phone, `Need a cab ${i}`);
    const convs = (await A.admin.get('/inbox/conversations')).body.items;
    const quotes: string[] = [];
    for (const c of convs.slice(0, 2)) quotes.push((await A.admin.post('/quotes', { conversationId: c.id, vehicleTypeId: v.id, trip: tripOutstation(), imageAssetIds: [v.images[0].assetId] })).body.id);
    for (const q of quotes) await A.admin.post(`/quotes/${q}/versions/1/send`);
    await A.admin.post(`/quotes/${quotes[0]}/status`, { status: 'accepted' });
    // one outbound reply so first-response time exists
    await A.admin.post(`/inbox/conversations/${convs[2].id}/messages`, { type: 'text', text: 'Hello!' });
    await inboundMessage(app, B, '+919700000009', 'B enquiry');
  });
  afterAll(async () => { await app.close(); });

  it('numbers reconcile with the underlying records', async () => {
    const d = (await A.admin.get('/dashboard/analytics')).body;
    expect(d.kpis.enquiries).toBe(3);
    expect(d.kpis.quotesCreated).toBe(2);
    expect(d.kpis.accepted).toBe(1);
    expect(d.funnel.map((f: any) => f.value)).toEqual([3, 2, 2, 1]);
    expect(d.kpis.conversionRate).toBe(50);
    expect(d.series.reduce((a: number, s: any) => a + s.enquiries, 0)).toBe(3);
    expect(d.series.reduce((a: number, s: any) => a + s.quotesSent, 0)).toBe(2);
    expect(d.series.reduce((a: number, s: any) => a + s.accepted, 0)).toBe(1);
    expect(d.heatmap.flat().reduce((a: number, n: number) => a + n, 0)).toBe(3);
    expect(d.kpis.deliverySuccessRate).toBe(100);
    expect(d.kpis.medianFirstResponseSeconds).not.toBeNull();
    // pipeline = the one open (sent) quote's CURRENT version total; the accepted one is excluded
    const open = (await A.admin.get('/quotes?status=sent')).body.items;
    expect(open).toHaveLength(1);
    expect(d.kpis.pipelineValue).toBe(open[0].total);
    expect(d.topVehicles[0]).toMatchObject({ name: 'Crysta', quotes: 2 });
    expect(d.statusBreakdown.find((s: any) => s.status === 'accepted').count).toBe(1);
  });

  it('is tenant-scoped', async () => {
    const b = (await B.admin.get('/dashboard/analytics')).body;
    expect(b.kpis.enquiries).toBe(1);
    expect(b.kpis.quotesCreated).toBe(0);
    expect(b.topVehicles).toHaveLength(0);
  });

  it('limits sales users to their own quotes and hides pipeline value', async () => {
    const s = (await A.sales.get('/dashboard/analytics')).body;
    expect(s.scope).toBe('limited');
    expect(s.kpis.pipelineValue).toBeNull();
    expect(s.kpis.quotesCreated).toBe(0); // quotes were created by the admin
  });

  it('rejects bad ranges and unauthenticated access', async () => {
    expect((await A.admin.get('/dashboard/analytics?from=garbage')).status).toBe(400);
    expect((await new Client(app).get('/dashboard/analytics')).status).toBe(401);
  });
});
