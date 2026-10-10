import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SimulatorWhatsApp, WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { boot, Client, inboundMessage, onboard, superAdmin, Tenant, uid } from './helpers';

const accept = (app: INestApplication, url: string, password: string) =>
  request(app.getHttpServer()).post('/auth/accept-invite').set('x-tripos-csrf', '1').send({ token: new URL(url).searchParams.get('token'), password });

describe('Invites, password reset and dashboard alerts', () => {
  let app: INestApplication, T: Tenant;
  beforeAll(async () => { app = await boot(); T = await onboard(app, await superAdmin(app), 'Inv'); });
  afterAll(async () => { await app.close(); });

  it('a new sales member can set a password and sign in, even if the email is typed with spaces/capitals', async () => {
    const email = `new.sales-${uid()}@test.local`;
    const inv = await T.admin.post('/agency/users', { name: 'New Sales', email: `  ${email.toUpperCase()}  ` });
    expect(inv.status).toBe(201);
    expect((await accept(app, inv.body.inviteUrl, 'BrandNewPass!1')).status).toBe(201);
    const c = new Client(app);
    const r = await c.agent.post('/auth/login').set('x-tripos-csrf', '1').send({ email: `  ${email}  `, password: 'BrandNewPass!1' });
    expect(r.status).toBe(201);
    expect((await c.get('/me')).body.user.role).toBe('SALES');
  });

  it('rejects the old password after a reset, and the reset link works once', async () => {
    const email = `reset-${uid()}@test.local`;
    const inv = await T.admin.post('/agency/users', { name: 'Reset Me', email });
    await accept(app, inv.body.inviteUrl, 'FirstPassword!1');
    const users = (await T.admin.get('/agency/users')).body;
    const id = users.find((u: any) => u.email === email).id;
    const re = await T.admin.post(`/agency/users/${id}/reinvite`);
    expect(re.status).toBe(201);
    expect((await accept(app, re.body.inviteUrl, 'SecondPassword!2')).status).toBe(201);
    expect((await accept(app, re.body.inviteUrl, 'ThirdPassword!3')).status).toBe(400); // single use
    const login = (pw: string) => new Client(app).agent.post('/auth/login').set('x-tripos-csrf', '1').send({ email, password: pw });
    expect((await login('FirstPassword!1')).status).toBe(401);
    expect((await login('SecondPassword!2')).status).toBe(201);
  });

  it('only admins of the same agency can reinvite; disabled users cannot be reinvited', async () => {
    const other = await onboard(app, await superAdmin(app), 'InvOther');
    expect((await T.sales.post(`/agency/users/${T.salesId}/reinvite`)).status).toBe(403);
    expect((await other.admin.post(`/agency/users/${T.salesId}/reinvite`)).status).toBe(404);
    const email = `dis-${uid()}@test.local`;
    const inv = await T.admin.post('/agency/users', { name: 'To Disable', email });
    const id = (await T.admin.get('/agency/users')).body.find((u: any) => u.email === email).id;
    await T.admin.patch(`/agency/users/${id}`, { status: 'disabled' });
    expect((await T.admin.post(`/agency/users/${id}/reinvite`)).status).toBe(400);
    expect(inv.status).toBe(201);
  });

  it('dashboard counts only unresolved failed messages', async () => {
    const wa = app.get(WHATSAPP) as SimulatorWhatsApp;
    await inboundMessage(app, T, '+919600000001', 'hello');
    const conv = (await T.admin.get('/inbox/conversations')).body.items[0].id;
    wa.failNext.text = 1;
    const failed = await T.admin.post(`/inbox/conversations/${conv}/messages`, { type: 'text', text: 'will fail' });
    expect(failed.body.ok).toBe(false);
    expect((await T.admin.get('/dashboard')).body.alerts.failedMessages).toBe(1);
    await T.admin.post(`/inbox/conversations/${conv}/messages/${failed.body.messageId}/retry`);
    expect((await T.admin.get('/dashboard')).body.alerts.failedMessages).toBe(0);
  });
});
