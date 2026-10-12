import { INestApplication } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/main';
import { placeholderPng } from '../src/common/placeholder-png';
import { Db } from '../src/db/db.service';
import { InboundService } from '../src/modules/webhooks/webhooks.module';

export const PW = 'TestPassword!123';
export const uid = () => Math.random().toString(36).slice(2, 9);

export async function boot() {
  const app = await createApp();
  await app.init();
  return app;
}

/** A cookie-holding API client that always sends the CSRF header, like the web app does. */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  constructor(private readonly app: INestApplication) { this.agent = request.agent(app.getHttpServer()); }
  async login(email: string, password = PW) {
    const r = await this.agent.post('/auth/login').set('x-tripos-csrf', '1').send({ email, password });
    if (r.status !== 201 && r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
    return this;
  }
  get(url: string) { return this.agent.get(url); }
  post(url: string, body?: object) { return this.agent.post(url).set('x-tripos-csrf', '1').send(body ?? {}); }
  patch(url: string, body: object) { return this.agent.patch(url).set('x-tripos-csrf', '1').send(body); }
  put(url: string, body: object) { return this.agent.put(url).set('x-tripos-csrf', '1').send(body); }
  del(url: string) { return this.agent.delete(url).set('x-tripos-csrf', '1'); }
}

export async function superAdmin(app: INestApplication) {
  const email = `super-${uid()}@test.local`;
  await app.get(Db).system(async (tx) => { await tx.user.create({ data: { name: 'Super', email, role: 'SUPER_ADMIN', status: 'active', passwordHash: await bcrypt.hash(PW, 4) } }); });
  return new Client(app).login(email);
}

export interface Tenant { agencyId: string; slug: string; admin: Client; sales: Client; adminEmail: string; salesEmail: string; salesId: string; adminId: string; phoneNumberId: string }

/** Full onboarding through the public API: super admin creates the agency, invites are accepted, WhatsApp (simulated) is connected. */
export async function onboard(app: INestApplication, sa: Client, label = 'Agency'): Promise<Tenant> {
  const slug = `${label.toLowerCase()}-${uid()}`;
  const adminEmail = `admin-${slug}@test.local`, salesEmail = `sales-${slug}@test.local`;
  const created = await sa.post('/platform/agencies', { name: `${label} ${slug}`, slug, adminName: 'Admin', adminEmail });
  if (created.status !== 201) throw new Error(`create agency failed ${JSON.stringify(created.body)}`);
  const acceptInvite = async (url: string) => {
    const token = new URL(url).searchParams.get('token');
    const r = await request(app.getHttpServer()).post('/auth/accept-invite').set('x-tripos-csrf', '1').send({ token, password: PW });
    if (r.status !== 201) throw new Error(`accept failed ${JSON.stringify(r.body)}`);
  };
  await acceptInvite(created.body.inviteUrl);
  const admin = await new Client(app).login(adminEmail);
  const inv = await admin.post('/agency/users', { name: 'Sales Person', email: salesEmail, role: 'SALES' });
  await acceptInvite(inv.body.inviteUrl);
  const sales = await new Client(app).login(salesEmail);
  const wa = await admin.post('/agency/whatsapp/connect', { displayName: `${label} line` });
  const users = (await admin.get('/agency/users')).body;
  return {
    agencyId: created.body.id, slug, admin, sales, adminEmail, salesEmail, phoneNumberId: wa.body.phoneNumberId,
    salesId: users.find((u: any) => u.email === salesEmail).id, adminId: users.find((u: any) => u.email === adminEmail).id,
  };
}

export const RATE = {
  local8h80kmPrice: '3500', local4h40kmPrice: '2200', extraHourRate: '300', extraKmRate: '23', outstationRatePerKm: '20', minKmPerDay: 300, driverBattaPerDay: '800',
};

export async function createVehicle(admin: Client, name = 'Crysta', images = 2) {
  const r = await admin.post('/agency/vehicle-types', { name, category: 'suv', seats: 7, description: 'Test', amenities: ['AC'], rate: RATE });
  if (r.status !== 201) throw new Error(`vehicle create failed ${JSON.stringify(r.body)}`);
  const imgs: any[] = [];
  for (let i = 0; i < images; i++) {
    const up = await admin.agent.post(`/agency/vehicle-types/${r.body.id}/images`).set('x-tripos-csrf', '1')
      .attach('file', placeholderPng(40 + i * 60, 120, 90, 64, 48), { filename: `p${i}.png`, contentType: 'image/png' }).field('caption', `Photo ${i + 1}`);
    if (up.status !== 201) throw new Error(`upload failed ${JSON.stringify(up.body)}`);
    imgs.push(up.body);
  }
  return { id: r.body.id as string, images: imgs };
}

export async function inboundMessage(app: INestApplication, t: Tenant, from: string, text: string, id = `m-${uid()}`) {
  return app.get(InboundService).process([{ kind: 'message', phoneNumberId: t.phoneNumberId, providerMessageId: id, from, name: 'Test Customer', type: 'text', text, timestamp: new Date() }]);
}

export const tripOutstation = () => ({
  tripType: 'outstation', pickupAt: new Date(Date.now() + 86400000).toISOString(), returnAt: new Date(Date.now() + 4 * 86400000).toISOString(),
  pickupLocation: 'Bangalore', destinations: ['Coorg'], passengers: 5, days: 3, km: 750,
});
