import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Db } from '../src/db/db.service';
import { boot, Client, createVehicle, inboundMessage, onboard, superAdmin, Tenant, tripOutstation } from './helpers';

/** Customers module: isolated test database, simulated WhatsApp. Nothing here reaches Meta or a real customer. */
describe('Customers', () => {
  let app: INestApplication, sa: Client, A: Tenant, B: Tenant, db: Db, vehicle: Awaited<ReturnType<typeof createVehicle>>;
  const num = () => Math.floor(10000000 + Math.random() * 89999999);
  const phone = () => `+9199${num()}`; // canonical form, as the webhook stores it
  const spaced = (p: string) => `${p.slice(0, 3)} ${p.slice(3, 8)} ${p.slice(8)}`; // "+91 99xxx xxxxx" style typed by staff

  beforeAll(async () => {
    app = await boot(); db = app.get(Db);
    sa = await superAdmin(app);
    A = await onboard(app, sa, 'CrmA'); B = await onboard(app, sa, 'CrmB');
    vehicle = await createVehicle(A.admin, 'CrmCar', 1);
  });
  afterAll(async () => { await app.close(); });

  const create = (who: Client, body: object) => who.post('/customers', body);
  const mk = async (who: Client = A.admin, name = 'Test Person', p = phone()) => { const r = await create(who, { name, phone: p }); expect(r.status).toBe(201); return r.body as { id: string; phone: string; name: string }; };
  const auditOf = (id: string) => db.system((tx) => tx.auditLog.findMany({ where: { entityType: 'customer', entityId: id }, orderBy: { createdAt: 'asc' } }));
  const quoteFor = async (customerId: string, who: Client = A.admin) => {
    const r = await who.post('/quotes', { customerId, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: [] });
    expect(r.status).toBe(201); return r.body;
  };

  it('creates a customer by hand: the phone is stored in the canonical +digits form, with an audit entry that holds no personal data', async () => {
    const p = phone();
    const r = await create(A.admin, { name: '  Asha Rao ', phone: spaced(p), email: 'ASHA@Example.com', notes: 'Prefers morning pickups' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Asha Rao', phone: p, email: 'asha@example.com', notes: 'Prefers morning pickups' });
    const row = await db.system((tx) => tx.customer.findFirstOrThrow({ where: { id: r.body.id } }));
    expect(row).toMatchObject({ agencyId: A.agencyId, phoneE164: p });
    const audit = await auditOf(r.body.id);
    expect(audit.map((a) => a.action)).toEqual(['customer.created']);
    expect(audit[0]).toMatchObject({ actorUserId: A.adminId, agencyId: A.agencyId });
    expect(JSON.stringify(audit[0].metadata)).not.toContain('Asha');
    expect(JSON.stringify(audit[0].metadata)).not.toContain(p);
  });

  it('refuses bad input with clear codes: no country code, junk phone, short name, bad email', async () => {
    const bad = await create(A.admin, { name: 'No Country', phone: '9876543210' });
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('invalid_phone');
    expect((await create(A.admin, { name: 'Junk', phone: 'abc' })).body.error.code).toBe('invalid_phone');
    expect((await create(A.admin, { name: 'X', phone: phone() })).status).toBe(400);
    expect((await create(A.admin, { name: 'Bad Email', phone: phone(), email: 'not-an-email' })).status).toBe(400);
    expect((await create(A.admin, { phone: phone() })).status).toBe(400);
    expect((await create(A.admin, { name: 'Empty email is fine', phone: phone(), email: '' })).status).toBe(201);
  });

  it('one person is one row: a duplicate (any formatting) is 409, and the webhook resolves to the manually created customer', async () => {
    const p = phone();
    const c = await mk(A.admin, 'Manual Name', p);
    const dup = await create(A.admin, { name: 'Again', phone: spaced(p) });
    expect(dup.status).toBe(409); expect(dup.body.error.code).toBe('customer_exists');
    expect((await create(A.admin, { name: 'Again', phone: `00${p.slice(1)}` })).status).toBe(409);

    await inboundMessage(app, A, p, 'Hello, I need a cab'); // same "+digits" shape the Meta parser produces
    expect(await db.system((tx) => tx.customer.count({ where: { agencyId: A.agencyId, phoneE164: p } }))).toBe(1);
    const d = await A.admin.get(`/customers/${c.id}`);
    expect(d.status).toBe(200);
    expect(d.body.name).toBe('Manual Name'); // the webhook never overwrites a name staff typed
    expect(d.body.conversations).toHaveLength(1);
  });

  it('a customer created by the webhook shows up in the list and detail, and can be renamed without the next message undoing it', async () => {
    const p = phone();
    await inboundMessage(app, A, p, 'first message');
    const found = (await A.admin.get(`/customers?search=${p.slice(-8)}`)).body.items;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ phone: p, conversations: 1, quotes: 0 });
    expect((await A.admin.patch(`/customers/${found[0].id}`, { name: 'Renamed By Staff' })).status).toBe(200);
    await inboundMessage(app, A, p, 'second message');
    expect((await A.admin.get(`/customers/${found[0].id}`)).body.name).toBe('Renamed By Staff');
  });

  it('edits name, email and notes; clears email/notes; never changes the phone; audits field NAMES only', async () => {
    const c = await mk(A.admin, 'Edit Me');
    const r = await A.admin.patch(`/customers/${c.id}`, { name: 'Edited Name', email: 'e@example.com', notes: 'secret note text' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ name: 'Edited Name', email: 'e@example.com', notes: 'secret note text', phone: c.phone });
    const cleared = await A.admin.patch(`/customers/${c.id}`, { email: '', notes: null });
    expect(cleared.body).toMatchObject({ email: null, notes: null });
    expect((await A.admin.patch(`/customers/${c.id}`, { phone: phone() })).status).toBe(400); // phone is immutable
    expect((await A.admin.patch(`/customers/${c.id}`, {})).status).toBe(400);
    expect((await A.admin.patch(`/customers/${c.id}`, { name: 'X' })).status).toBe(400);
    expect((await A.admin.get(`/customers/${c.id}`)).body.phone).toBe(c.phone);
    const audit = (await auditOf(c.id)).filter((a) => a.action === 'customer.updated');
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit.map((a) => a.metadata))).not.toContain('secret note text');
    expect(audit[0].metadata).toMatchObject({ fields: ['name', 'email', 'notes'] });
  });

  it('lists with search (name, phone digits, email), paging and counts of conversations and live quotes', async () => {
    const tag = `Zed${num()}`;
    const a = await mk(A.admin, `${tag} One`), b = await mk(A.admin, `${tag} Two`), c = await mk(A.admin, `${tag} Three`);
    await A.admin.patch(`/customers/${a.id}`, { email: `${tag.toLowerCase()}@mail.test` });
    expect((await A.admin.get(`/customers?search=${tag}&pageSize=2&page=1`)).body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect((await A.admin.get(`/customers?search=${tag}&pageSize=2&page=2`)).body.items).toHaveLength(1);
    expect((await A.admin.get(`/customers?search=${tag.toLowerCase()}@mail`)).body.items.map((i: any) => i.id)).toEqual([a.id]);
    expect((await A.admin.get(`/customers?search=${b.phone.slice(-9)}`)).body.items.map((i: any) => i.id)).toContain(b.id);
    expect((await A.admin.get(`/customers?search=${encodeURIComponent('%')}`)).status).toBe(200);

    const q1 = await quoteFor(c.id), q2 = await quoteFor(c.id);
    let row = (await A.admin.get(`/customers?search=${tag}%20Three`)).body.items[0];
    expect(row).toMatchObject({ id: c.id, quotes: 2 });
    expect((await A.admin.del(`/quotes/${q1.id}`)).status).toBe(200); // a soft-deleted quote stops counting
    row = (await A.admin.get(`/customers?search=${tag}%20Three`)).body.items[0];
    expect(row.quotes).toBe(1);
    const detail = (await A.admin.get(`/customers/${c.id}`)).body;
    expect(detail.quotes.map((q: any) => q.id)).toEqual([q2.id]);
    expect(detail.quotes[0]).toMatchObject({ quoteNumber: q2.quoteNumber, status: 'draft', version: 1 });
    expect(detail.quotes[0].total).toBeTruthy();
    expect(JSON.stringify(detail)).not.toContain(q1.quoteNumber);
  });

  it('a quote can be started for a customer without any WhatsApp conversation (the empty-agency case)', async () => {
    const c = await mk(A.admin, 'No Chat Yet');
    const q = await quoteFor(c.id);
    expect(q.customer).toMatchObject({ id: c.id });
    const d = (await A.admin.get(`/customers/${c.id}`)).body;
    expect(d.conversations).toHaveLength(0);
    expect(d.quotes).toHaveLength(1);
  });

  it('is tenant-isolated: another agency cannot read, search or edit a customer, and may reuse the same phone number', async () => {
    const p = phone();
    const mine = await mk(A.admin, 'Isolated Person', p);
    expect((await B.admin.get(`/customers/${mine.id}`)).status).toBe(404);
    expect((await B.admin.patch(`/customers/${mine.id}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await B.sales.get(`/customers/${mine.id}`)).status).toBe(404);
    expect((await B.admin.get(`/customers?search=${p.slice(-8)}`)).body.items).toHaveLength(0);
    expect((await A.admin.get(`/customers/${mine.id}`)).body.name).toBe('Isolated Person');
    const theirs = await create(B.admin, { name: 'Same Number Other Agency', phone: p });
    expect(theirs.status).toBe(201); expect(theirs.body.id).not.toBe(mine.id);
  });

  it('roles: agency admin and sales may use it; the platform super admin and anonymous callers may not', async () => {
    expect((await A.sales.get('/customers')).status).toBe(200);
    expect((await create(A.sales, { name: 'Sales Made', phone: phone() })).status).toBe(201);
    expect((await sa.get('/customers')).status).toBe(403);
    expect((await sa.post('/customers', { name: 'Nope', phone: phone() })).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/customers')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/customers').set('x-tripos-csrf', '1').send({ name: 'Nope', phone: phone() })).status).toBe(401);
    expect((await A.admin.get('/customers/not-a-uuid')).status).toBe(400);
    expect((await A.admin.get('/customers/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await A.sales.get('/me')).body.permissions).toContain('customers.use');
  });

  it('"assigned only" visibility: a sales user sees customers linked to them (assigned chat, own quote, created by them) and no others', async () => {
    const adminsOnly = await mk(A.admin, 'Admin Only'), madeBySales = await mk(A.sales, 'Made By Sales');
    const chatP = phone(); await inboundMessage(app, A, chatP, 'hello');
    const chatCust = (await A.admin.get(`/customers?search=${chatP.slice(-8)}`)).body.items[0];
    const convId = (await A.admin.get(`/customers/${chatCust.id}`)).body.conversations[0].id;
    const quoteCust = await mk(A.admin, 'Sales Owns A Quote');
    await quoteFor(quoteCust.id, A.sales);
    expect((await A.admin.patch(`/inbox/conversations/${convId}`, { assignedUserId: A.salesId })).status).toBe(200);

    expect((await A.admin.patch('/agency/settings', { salesVisibility: 'assigned' })).status).toBe(200);
    try {
      const seen = (await A.sales.get('/customers?pageSize=100')).body.items.map((i: any) => i.id);
      expect(seen).toEqual(expect.arrayContaining([madeBySales.id, chatCust.id, quoteCust.id]));
      expect(seen).not.toContain(adminsOnly.id);
      expect((await A.sales.get(`/customers/${adminsOnly.id}`)).status).toBe(404);
      expect((await A.sales.patch(`/customers/${adminsOnly.id}`, { name: 'Nope' })).status).toBe(404);
      expect((await A.admin.get(`/customers/${adminsOnly.id}`)).body.name).toBe('Admin Only'); // the refused edit really changed nothing
      expect((await A.sales.get(`/customers/${adminsOnly.id}`)).body?.error?.code).toBe('not_found'); // and the 404 is for THAT customer, not a substitute
      expect((await A.sales.get(`/customers/${madeBySales.id}`)).status).toBe(200);
      const chat = (await A.sales.get(`/customers/${chatCust.id}`)).body;
      expect(chat.conversations[0].assignedUser).toMatchObject({ id: A.salesId });
      expect((await A.admin.get('/customers?pageSize=100')).body.items.map((i: any) => i.id)).toContain(adminsOnly.id); // admins still see all
    } finally { await A.admin.patch('/agency/settings', { salesVisibility: 'all' }); }
    expect((await A.sales.get(`/customers/${adminsOnly.id}`)).status).toBe(200); // "all" shows everyone again
  });
});
