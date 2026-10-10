import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Db } from '../src/db/db.service';
import { boot, Client, createVehicle, inboundMessage, onboard, superAdmin, Tenant, tripOutstation, uid } from './helpers';

describe('Scenarios 1, 2, 10: onboarding, tenant isolation, permissions', () => {
  let app: INestApplication, sa: Client, A: Tenant, B: Tenant;
  let aVehicle: Awaited<ReturnType<typeof createVehicle>>, aConv: string, aQuote: string;

  beforeAll(async () => {
    app = await boot();
    sa = await superAdmin(app);
    A = await onboard(app, sa, 'AgencyA');
    B = await onboard(app, sa, 'AgencyB');
    aVehicle = await createVehicle(A.admin, 'A-Crysta');
    await inboundMessage(app, A, '+919800000001', 'Need a cab Bangalore to Coorg');
    aConv = (await A.admin.get('/inbox/conversations')).body.items[0].id;
    const q = await A.sales.post('/quotes', { conversationId: aConv, vehicleTypeId: aVehicle.id, trip: tripOutstation(), imageAssetIds: [aVehicle.images[0].assetId] });
    expect(q.status).toBe(201);
    aQuote = q.body.id;
  });
  afterAll(async () => { await app.close(); });

  it('Scenario 2: Super Admin onboarding produced two independent active agencies', async () => {
    const list = (await sa.get('/platform/agencies')).body as any[];
    const a = list.find((x) => x.id === A.agencyId), b = list.find((x) => x.id === B.agencyId);
    expect(a.status).toBe('active'); expect(b.status).toBe('active');
    expect((await A.admin.get('/me')).body.agency.id).toBe(A.agencyId);
  });

  it('Agency B cannot read any of Agency A\'s records by ID', async () => {
    const bad = [
      B.admin.get(`/agency/vehicle-types/${aVehicle.id}`), B.admin.get(`/quotes/${aQuote}`), B.admin.get(`/inbox/conversations/${aConv}`),
      B.admin.get(`/inbox/conversations/${aConv}/messages`), B.admin.get(`/quotes/${aQuote}/versions/1/preview`), B.admin.get(`/quotes/${aQuote}/versions/1/pdf`),
    ];
    for (const r of await Promise.all(bad)) expect(r.status).toBe(404);
  });

  it('Agency B cannot modify Agency A\'s records', async () => {
    const attempts = await Promise.all([
      B.admin.patch(`/agency/vehicle-types/${aVehicle.id}`, { name: 'hijacked' }),
      B.admin.post(`/agency/vehicle-types/${aVehicle.id}/archive`),
      B.admin.del(`/agency/vehicle-types/${aVehicle.id}/images/${aVehicle.images[0].id}`),
      B.admin.patch(`/quotes/${aQuote}/draft`, { notes: 'x' }),
      B.admin.post(`/quotes/${aQuote}/status`, { status: 'ready_to_send' }),
      B.admin.post(`/inbox/conversations/${aConv}/messages`, { type: 'text', text: 'hi' }),
      B.admin.post(`/inbox/conversations/${aConv}/notes`, { text: 'x' }),
      B.admin.patch(`/inbox/conversations/${aConv}`, { status: 'closed' }),
    ]);
    for (const r of attempts) expect([404, 400]).toContain(r.status);
    expect((await A.admin.get(`/agency/vehicle-types/${aVehicle.id}`)).body.name).toBe('A-Crysta');
  });

  it('lists never include another tenant\'s rows (search + pagination)', async () => {
    expect((await B.admin.get('/quotes?search=Q-0001')).body.items).toHaveLength(0);
    expect((await B.admin.get('/inbox/conversations?search=Coorg')).body.items).toHaveLength(0);
    expect((await B.admin.get('/agency/vehicle-types')).body).toHaveLength(0);
    expect((await B.admin.get('/agency/users')).body.every((u: any) => u.email.includes(B.slug))).toBe(true);
  });

  it('cannot reference another tenant\'s objects in request payloads', async () => {
    const bVehicle = await createVehicle(B.admin, 'B-Crysta', 1);
    // A's vehicle, B's session
    expect((await B.sales.post('/quotes/calculate', { vehicleTypeId: aVehicle.id, trip: tripOutstation() })).status).toBe(404);
    // B's quote may not use A's conversation or A's photos
    expect((await B.sales.post('/quotes', { conversationId: aConv, vehicleTypeId: bVehicle.id, trip: tripOutstation() })).status).toBe(404);
    const withForeignImage = await B.sales.post('/quotes/calculate', { vehicleTypeId: bVehicle.id, trip: tripOutstation(), imageAssetIds: [aVehicle.images[0].assetId] });
    expect(withForeignImage.status).toBe(400);
    // Cannot assign a conversation to a user of another agency
    expect((await A.admin.patch(`/inbox/conversations/${aConv}`, { assignedUserId: B.salesId })).status).toBe(400);
  });

  it('a client-supplied agencyId is ignored; tenant comes from the session', async () => {
    const r = await B.admin.post('/agency/vehicle-types', { agencyId: A.agencyId, name: 'Smuggled', category: 'sedan', seats: 4, rate: { local8h80kmPrice: '1', local4h40kmPrice: '1', extraHourRate: '1', extraKmRate: '1', outstationRatePerKm: '1', minKmPerDay: 1, driverBattaPerDay: '1' } });
    expect(r.status).toBe(201);
    expect((await A.admin.get('/agency/vehicle-types')).body.map((v: any) => v.name)).not.toContain('Smuggled');
  });

  it('signed media URLs reject tampering', async () => {
    const url: string = (await A.admin.get(`/agency/vehicle-types/${aVehicle.id}`)).body.images[0].url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    expect((await request(app.getHttpServer()).get(path)).status).toBe(200);
    expect((await request(app.getHttpServer()).get(path.replace(/sig=[0-9a-f]+/, 'sig=deadbeef'))).status).toBe(404);
    expect((await request(app.getHttpServer()).get(path.replace(/agencies%2F[0-9a-f-]+/, `agencies%2F${B.agencyId}`))).status).toBe(404);
  });

  it('PostgreSQL RLS blocks cross-tenant reads even without an application WHERE clause', async () => {
    const db = app.get(Db);
    const rows = await db.tenant(B.agencyId, (tx) => tx.quote.findMany()); // deliberately unfiltered
    expect(rows).toHaveLength(0);
    const own = await db.tenant(A.agencyId, (tx) => tx.quote.findMany());
    expect(own.length).toBeGreaterThan(0);
    await expect(db.tenant(B.agencyId, (tx) => tx.customer.create({ data: { agencyId: A.agencyId, name: 'x', phoneE164: '+910000000000' } }))).rejects.toThrow();
  });

  it('Scenario 10: Sales cannot reach admin, settings, or platform functions', async () => {
    for (const r of await Promise.all([
      A.sales.get('/agency/users'), A.sales.post('/agency/users', { name: 'x y', email: 'x@y.com' }), A.sales.patch('/agency/branding', { tagline: 'x' }),
      A.sales.patch('/agency/settings', { taxEnabled: true }), A.sales.post('/agency/vehicle-types', {}), A.sales.post('/agency/whatsapp/connect', { displayName: 'x' }),
      A.sales.get('/platform/agencies'), A.sales.get('/agency/audit'),
    ])) expect(r.status).toBe(403);
    expect((await A.sales.get('/agency/vehicle-types')).status).toBe(200); // read/select only
    expect((await A.sales.patch(`/agency/vehicle-types/${aVehicle.id}`, { name: 'x' })).status).toBe(403);
  });

  it('Agency Admin cannot use platform functions; Super Admin cannot read agency data', async () => {
    expect((await A.admin.post('/platform/agencies', {})).status).toBe(403);
    expect((await A.admin.get('/platform/agencies')).status).toBe(403);
    for (const r of await Promise.all([sa.get('/inbox/conversations'), sa.get('/quotes'), sa.get(`/inbox/conversations/${aConv}/messages`), sa.get('/agency/vehicle-types')])) expect(r.status).toBe(403);
  });

  it('unauthenticated and CSRF-less requests are rejected', async () => {
    expect((await request(app.getHttpServer()).get('/quotes')).status).toBe(401);
    expect((await A.admin.agent.post('/quotes/calculate').send({})).status).toBe(403); // no x-tripos-csrf
    expect((await A.admin.agent.post('/quotes/calculate').set('x-tripos-csrf', '1').set('Origin', 'https://evil.example').send({})).status).toBe(403);
  });

  it('suspension takes effect immediately and is reversible', async () => {
    const C = await onboard(app, sa, 'AgencyC');
    expect((await C.admin.get('/me')).status).toBe(200);
    await sa.patch(`/platform/agencies/${C.agencyId}`, { status: 'suspended' });
    const r = await C.admin.get('/me');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('agency_suspended');
    await sa.patch(`/platform/agencies/${C.agencyId}`, { status: 'active' });
    expect((await C.admin.get('/me')).status).toBe(200);
  });

  it('support access requires an explicit, time-limited, audited grant', async () => {
    expect((await sa.get(`/platform/support/${A.agencyId}/conversations`)).status).toBe(403);
    expect((await sa.post('/platform/support-access', { agencyId: A.agencyId, reason: 'short', minutes: 10 })).status).toBe(400);
    expect((await sa.post('/platform/support-access', { agencyId: A.agencyId, reason: 'Customer reported a missing message', minutes: 10 })).status).toBe(201);
    expect((await sa.get(`/platform/support/${A.agencyId}/conversations`)).status).toBe(200);
    const audit = (await A.admin.get('/agency/audit')).body.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['platform.support_access_granted', 'platform.support_conversations_viewed']));
  });

  it('disabled users lose access immediately', async () => {
    const email = `tmp-${uid()}@test.local`;
    const inv = await A.admin.post('/agency/users', { name: 'Temp User', email });
    const token = new URL(inv.body.inviteUrl).searchParams.get('token');
    await request(app.getHttpServer()).post('/auth/accept-invite').set('x-tripos-csrf', '1').send({ token, password: 'TestPassword!123' });
    const c = await new Client(app).login(email);
    expect((await c.get('/me')).status).toBe(200);
    await A.admin.patch(`/agency/users/${inv.body.id}`, { status: 'disabled' });
    expect((await c.get('/me')).status).toBe(401);
  });
});
