import request from 'supertest';
import { bootCloud, CloudWorld, customerWrites } from './cloud-harness';
import { createVehicle, tripOutstation, uid } from './helpers';

/** Sending a quotation with an approved WhatsApp template: rich message, window rules, price approval, public link. */
describe('Quotation sent with a WhatsApp template', () => {
  let w: CloudWorld, vehicle: Awaited<ReturnType<typeof createVehicle>>;
  const admin = () => w.T.admin;
  const phone = () => `+9195${Math.floor(10000000 + Math.random() * 89999999)}`;

  const spec = (purpose = 'quotation') => ({
    purpose, header: { type: 'image', source: 'vehicle_photo' },
    body: 'Hello {{customer_name}}, your {{vehicle_type}} quotation {{quote_number}} is {{quote_total}} from {{agency_name}}.',
    footer: 'Reply to this message to book',
    buttons: [{ type: 'url', text: 'View Quotation', url: 'https://app.example.com/q/{{quote_token}}' }],
  });
  const approvedTemplate = async (purpose = 'quotation') => {
    const t = (await admin().post('/agency/whatsapp/templates', { name: `qt_${uid()}`, language: 'en', category: 'UTILITY', spec: spec(purpose) })).body;
    expect((await admin().post(`/agency/whatsapp/templates/${t.id}/submit`)).status).toBe(201);
    await request(w.app.getHttpServer()).post('/webhooks/whatsapp').send({ entry: [{ id: w.waba, time: Math.floor(Date.now() / 1000), changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: `meta-${t.name}`, message_template_name: t.name, message_template_language: 'en' } }] }] });
    return t;
  };
  const convFor = async (from: string) => (await admin().get('/inbox/conversations?pageSize=100')).body.items.find((c: any) => c.customer?.phone === from).id as string;
  const quoteFor = async (from: string, openWindow = true) => {
    await customerWrites(w, from);
    const convId = await convFor(from);
    if (!openWindow) await w.db.tenant(w.T.agencyId, (tx) => tx.conversation.update({ where: { id: convId }, data: { lastInboundAt: new Date(Date.now() - 2 * 86400000) } }));
    return (await admin().post('/quotes', { conversationId: convId, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: [vehicle.images[0].assetId, vehicle.images[1].assetId] })).body;
  };

  beforeAll(async () => { w = await bootCloud('QTpl'); vehicle = await createVehicle(admin(), 'Crysta', 2); });
  afterAll(async () => { await w.app.close(); });

  it('lists approved templates for the quotation, best match first, with the window state', async () => {
    const t = await approvedTemplate();
    const q = await quoteFor(phone());
    const r = await admin().get(`/quotes/${q.id}/versions/1/templates`);
    expect(r.status).toBe(200);
    expect(r.body.templates.map((x: any) => x.id)).toContain(t.id);
    expect(r.body).toMatchObject({ requiresPriceApproval: false, previousTotal: null });
    expect(r.body.windowOpen).toBe(true);
  });

  it('window open: template (header photo, filled body, link button) then PDF and photos; quote becomes sent', async () => {
    const t = await approvedTemplate();
    const q = await quoteFor(phone());
    w.fake.templateSends.length = 0;
    const r = await admin().post(`/quotes/${q.id}/versions/1/send-template`, { templateId: t.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ versionStatus: 'sent', quoteStatus: 'sent', deferred: null });
    expect(r.body.attempts.map((a: any) => a.kind)).toEqual(['template', 'pdf', 'image', 'image']);
    const s = w.fake.templateSends.at(-1)!;
    expect(s.name).toBe(t.name);
    expect(s.header?.kind).toBe('image');
    expect(s.variables.every((v) => v.trim())).toBe(true);
    expect(s.variables.join(' ')).toContain('Q-');
    expect(s.buttons).toEqual([expect.objectContaining({ index: 0, kind: 'url' })]);
  });

  it('window closed: only the template goes out; PDF and photos are reported as deferred, not failed', async () => {
    const t = await approvedTemplate();
    const q = await quoteFor(phone(), false);
    const r = await admin().post(`/quotes/${q.id}/versions/1/send-template`, { templateId: t.id });
    expect(r.status).toBe(201);
    expect(r.body.attempts.map((a: any) => a.kind)).toEqual(['template']);
    expect(r.body.versionStatus).toBe('sent');
    expect(r.body.deferred).toMatchObject({ pdf: true, images: 2 });
  });

  it('refuses a template that Meta has not approved', async () => {
    const draft = (await admin().post('/agency/whatsapp/templates', { name: `qt_${uid()}`, language: 'en', category: 'UTILITY', spec: spec() })).body;
    const q = await quoteFor(phone());
    const r = await admin().post(`/quotes/${q.id}/versions/1/send-template`, { templateId: draft.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('template_not_approved');
  });

  it('a revised version needs the exact price approved by staff before it can be sent', async () => {
    const t = await approvedTemplate('revised_quotation');
    const q = await quoteFor(phone());
    expect((await admin().post(`/quotes/${q.id}/versions/1/send-template`, { templateId: t.id })).status).toBe(201);
    const v2 = (await admin().post(`/quotes/${q.id}/versions`, { discount: { type: 'amount', value: '500' } })).body;
    const total = v2.versions.find((v: any) => v.versionNumber === 2).total;

    const opts = (await admin().get(`/quotes/${q.id}/versions/2/templates`)).body;
    expect(opts.requiresPriceApproval).toBe(true);
    expect(opts.previousTotal).not.toBe(opts.currentTotal);
    expect(opts.templates[0].id).toBe(t.id);                                                  // revised_quotation template ranks first

    const none = await admin().post(`/quotes/${q.id}/versions/2/send-template`, { templateId: t.id });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('approval_required');
    const wrong = await admin().post(`/quotes/${q.id}/versions/2/send-template`, { templateId: t.id, approvedTotal: '1.00' });
    expect(wrong.body.error.code).toBe('approval_required');
    const ok = await admin().post(`/quotes/${q.id}/versions/2/send-template`, { templateId: t.id, approvedTotal: String(total) });
    expect(ok.status).toBe(201);
    expect(ok.body.versionNumber).toBe(2);
  });

  it('the public link shows the quote without login, hides the phone number and serves the PDF; bad tokens are 404', async () => {
    const t = await approvedTemplate();
    const q = await quoteFor(phone());
    w.fake.templateSends.length = 0;
    await admin().post(`/quotes/${q.id}/versions/1/send-template`, { templateId: t.id });
    const token = w.fake.templateSends.at(-1)!.buttons![0].value;
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const view = await request(w.app.getHttpServer()).get(`/public/quotes/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.expired).toBe(false);
    expect(view.body.model.total).toBeTruthy();
    expect(JSON.stringify(view.body)).not.toMatch(/\+91\d{8,}/);                              // customer phone never exposed
    expect(view.body.photos).toHaveLength(2);

    const pdf = await request(w.app.getHttpServer()).get(`/public/quotes/${token}/pdf`).buffer().parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    expect((await request(w.app.getHttpServer()).get('/public/quotes/not-a-real-token-123456789')).status).toBe(404);
    expect((await request(w.app.getHttpServer()).get('/public/quotes/x')).status).toBe(404);
  });

  it('a rejected template message is a failed delivery (never "sent"), is not retried automatically, and can be retried by staff', async () => {
    const t = await approvedTemplate();
    const q = await quoteFor(phone());
    const { authError } = await import('./fake-cloud');
    w.fake.sendError = authError();
    const r = await admin().post(`/quotes/${q.id}/versions/1/send-template`, { templateId: t.id });
    expect(r.body.quoteStatus).toBe('send_failed');
    expect(r.body.retryable).toBe(false);
    w.fake.sendError = undefined;
    const again = await admin().post(`/quotes/${q.id}/versions/1/retry`);
    expect(again.body.versionStatus).toBe('sent');
    expect(again.body.attempts[0]).toMatchObject({ kind: 'template', status: 'sent' });
  });

  it('inbox template send: strict variables, quote data and photos (window open) with provider ids', async () => {
    const t = await approvedTemplate();
    const from = phone();
    await customerWrites(w, from);
    const conv = { id: await convFor(from) };
    const q = (await admin().post('/quotes', { conversationId: conv.id, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: [vehicle.images[0].assetId] })).body;
    // quote is not "sent" yet so there is no public token: the URL button value cannot be filled -> refused, nothing is sent
    w.fake.templateSends.length = 0;
    const blocked = await admin().post(`/inbox/conversations/${conv.id}/messages`, { type: 'template', templateId: t.id, quoteId: q.id });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('template_variables_missing');
    expect(w.fake.templateSends).toHaveLength(0);
    // staff may supply the missing value explicitly
    const ok = await admin().post(`/inbox/conversations/${conv.id}/messages`, { type: 'template', templateId: t.id, quoteId: q.id, values: { quote_token: 'staff-supplied-token-1' }, photoAssetIds: [vehicle.images[1].assetId] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ ok: true });
    expect(ok.body.messageId).toBeTruthy();
    expect(ok.body.photos).toEqual([expect.objectContaining({ ok: true })]);
  });
});
