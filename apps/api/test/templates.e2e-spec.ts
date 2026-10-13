import request from 'supertest';
import { placeholderPng } from '../src/common/placeholder-png';
import { WaSendError } from '../src/providers/whatsapp/whatsapp';
import { bootCloud, CloudWorld, customerWrites } from './cloud-harness';
import { authError } from './fake-cloud';
import { createVehicle, onboard, uid } from './helpers';

const premium = (over: any = {}) => ({
  name: `quote_premium_${uid()}`, language: 'en', category: 'UTILITY',
  spec: {
    purpose: 'quotation', header: { type: 'image', source: 'logo' },
    body: 'Hello {{customer_name}} 👋\n\nThank you for choosing {{agency_name}}.\n\nDestination: {{destination}}\nTravel dates: {{travel_dates}}\nGuests: {{passenger_count}}\nVehicle: {{vehicle_type}}\n\nQuotation amount: {{quote_total}}',
    footer: 'Golden Travels | +91 98450 12345',
    buttons: [{ type: 'url', text: 'View Quotation', url: 'https://app.example.com/q/{{quote_token}}' }, { type: 'phone', text: 'Contact Us', phone: '+919845012345' }],
  },
  ...over,
});
const png = () => placeholderPng(30, 120, 90, 40, 30);

describe('WhatsApp template builder', () => {
  let w: CloudWorld, B: Awaited<ReturnType<typeof onboard>>;
  beforeAll(async () => { w = await bootCloud('Tpl'); B = await onboard(w.app, w.sa, 'TplOther', { connect: false }); });
  afterAll(async () => { await w.app.close(); });
  const admin = () => w.T.admin, sales = () => w.T.sales;
  const mk = async (body = premium()) => (await admin().post('/agency/whatsapp/templates', body)).body;
  const uploadLogo = () => admin().agent.post('/agency/branding/logo').set('x-tripos-csrf', '1').attach('file', png(), { filename: 'logo.png', contentType: 'image/png' });

  describe('drafts', () => {
    it('creates a premium rich template as a LOCAL draft, compiled to Meta positional form', async () => {
      const r = await admin().post('/agency/whatsapp/templates', premium());
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'local_draft', origin: 'local_draft', localDraft: true, registeredWithMeta: false, providerConfirmed: false, editable: true, purpose: 'quotation', providerTemplateId: null });
      expect(r.body.body).toBe('Hello {{1}} 👋\n\nThank you for choosing {{2}}.\n\nDestination: {{3}}\nTravel dates: {{4}}\nGuests: {{5}}\nVehicle: {{6}}\n\nQuotation amount: {{7}}');
      expect(r.body.variables).toEqual(['customer_name', 'agency_name', 'destination', 'travel_dates', 'passenger_count', 'vehicle_type', 'quote_total']);
      expect(r.body.required).toContain('quote_token');
      expect(r.body.spec.buttons).toHaveLength(2);
      expect(r.body.warnings).toEqual([]);
    });

    it('still accepts the older positional form (body with {{1}} plus variable names)', async () => {
      const r = await admin().post('/agency/whatsapp/templates', { name: `legacy_${uid()}`, body: 'Hi {{1}}, quote {{2}} is ready', variableSchema: ['customer_name', 'quote_number'] });
      expect(r.status).toBe(201);
      expect(r.body.spec.body).toBe('Hi {{customer_name}}, quote {{quote_number}} is ready');
      expect((await admin().post('/agency/whatsapp/templates', { name: `legacy_${uid()}`, body: 'Hi {{1}} {{2}}', variableSchema: ['only_one'] })).body.error.code).toBe('variable_mismatch');
    });

    it('rejects definitions that break Meta rules, with field-level issues', async () => {
      const bad = premium({ name: 'Bad Name', spec: { ...premium().spec, footer: 'Call {{agency_phone}}', buttons: [{ type: 'url', text: 'View', url: 'http://insecure.example.com' }] } });
      const r = await admin().post('/agency/whatsapp/templates', bad);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('template_invalid');
      expect(r.body.error.issues.map((i: any) => i.path).sort()).toEqual(['buttons[0]', 'footer', 'name']);
    });

    it('requires an uploaded image for a custom image header, and that image must belong to this agency', async () => {
      const spec = { ...premium().spec, header: { type: 'image', source: 'custom' } };
      expect((await admin().post('/agency/whatsapp/templates', premium({ spec }))).status).toBe(400);
      const up = await admin().agent.post('/agency/whatsapp/templates/media/upload').set('x-tripos-csrf', '1').attach('file', png(), { filename: 'h.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      expect((await admin().post('/agency/whatsapp/templates', premium({ spec, headerMediaAssetId: up.body.assetId }))).status).toBe(201);
      expect((await B.admin.post('/agency/whatsapp/templates', premium({ spec, headerMediaAssetId: up.body.assetId }))).status).toBe(400); // another agency's file
      const pdf = await admin().agent.post('/agency/whatsapp/templates/media/upload').set('x-tripos-csrf', '1').attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(pdf.status).toBe(400);
    });

    it('edits drafts, duplicates into new drafts, and deletes only drafts', async () => {
      const t = await mk();
      const edited = await admin().patch(`/agency/whatsapp/templates/${t.id}`, premium({ name: t.name, spec: { ...premium().spec, footer: 'Edited footer' } }));
      expect(edited.status).toBe(200);
      expect(edited.body.spec.footer).toBe('Edited footer');

      const d1 = (await admin().post(`/agency/whatsapp/templates/${t.id}/duplicate`)).body;
      const d2 = (await admin().post(`/agency/whatsapp/templates/${t.id}/duplicate`)).body;
      expect([d1.name, d2.name]).toEqual([`${t.name}_copy`, `${t.name}_copy_2`]);
      expect(d1).toMatchObject({ status: 'local_draft', purpose: 'quotation', providerTemplateId: null });
      expect(d1.spec).toEqual(edited.body.spec);

      expect((await admin().del(`/agency/whatsapp/templates/${d2.id}`)).body.ok).toBe(true);
      expect((await admin().get(`/agency/whatsapp/templates/${d2.id}`)).status).toBe(404);
    });

    it('duplicates an imported Meta template into an editable draft', async () => {
      w.fake.templates = [{ providerTemplateId: 'm-imp', name: 'imported_hello', language: 'en_US', category: 'UTILITY', status: 'APPROVED', body: 'Hello {{1}}, welcome to {{2}}' }];
      await admin().post('/agency/whatsapp/templates/sync');
      const imp = (await admin().get('/agency/whatsapp/templates')).body.find((x: any) => x.name === 'imported_hello');
      expect(imp).toMatchObject({ origin: 'imported_from_meta', status: 'approved', editable: false, registeredWithMeta: true });
      const dup = (await admin().post(`/agency/whatsapp/templates/${imp.id}/duplicate`)).body;
      expect(dup).toMatchObject({ name: 'imported_hello_copy', status: 'local_draft', editable: true });
      expect(dup.spec.body).toBe('Hello {{variable_1}}, welcome to {{variable_2}}');
    });
  });

  describe('permissions and isolation', () => {
    it('sales can read, preview and list variables but cannot manage templates', async () => {
      const t = await mk();
      const reads = await Promise.all([sales().get('/agency/whatsapp/templates'), sales().get(`/agency/whatsapp/templates/${t.id}`), sales().get('/agency/whatsapp/templates/variables'), sales().post('/agency/whatsapp/templates/preview', { templateId: t.id })]);
      expect(reads.map((r) => r.status)).toEqual([200, 200, 200, 201]);   // (POST preview is a read-only action)
      for (const r of await Promise.all([
        sales().post('/agency/whatsapp/templates', premium()), sales().patch(`/agency/whatsapp/templates/${t.id}`, premium()), sales().post(`/agency/whatsapp/templates/${t.id}/duplicate`),
        sales().del(`/agency/whatsapp/templates/${t.id}`), sales().post(`/agency/whatsapp/templates/${t.id}/submit`), sales().agent.post('/agency/whatsapp/templates/media/upload').set('x-tripos-csrf', '1').attach('file', png(), 'x.png'),
      ])) expect(r.status).toBe(403);
      expect((await w.sa.get('/agency/whatsapp/templates')).status).toBe(403);
    });

    it('another agency cannot see or touch these templates', async () => {
      const t = await mk();
      expect((await B.admin.get('/agency/whatsapp/templates')).body.some((x: any) => x.id === t.id)).toBe(false);
      for (const r of await Promise.all([
        B.admin.get(`/agency/whatsapp/templates/${t.id}`), B.admin.patch(`/agency/whatsapp/templates/${t.id}`, premium()), B.admin.post(`/agency/whatsapp/templates/${t.id}/duplicate`),
        B.admin.del(`/agency/whatsapp/templates/${t.id}`), B.admin.post(`/agency/whatsapp/templates/${t.id}/submit`), B.admin.post('/agency/whatsapp/templates/preview', { templateId: t.id }),
      ])) expect(r.status).toBe(404);
      expect((await admin().get(`/agency/whatsapp/templates/${t.id}`)).status).toBe(200);
    });

    it('unauthenticated access is refused', async () => {
      expect((await request(w.app.getHttpServer()).get('/agency/whatsapp/templates')).status).toBe(401);
    });
  });

  describe('preview', () => {
    it('shows the agency real name and phone with sample values for the rest, and explains a missing logo', async () => {
      await admin().patch('/agency/branding', { phone: '+91 98450 99999', brandColour: '#0e7490' });
      const r = await admin().post('/agency/whatsapp/templates/preview', { spec: premium().spec });
      expect(r.status).toBe(201);
      expect(r.body.preview.body).toContain('Hello Rahul Shetty 👋');
      expect(r.body.preview.body).toContain(`choosing ${r.body.brand.name}.`);
      expect(r.body.preview.body).toContain('Quotation amount: ₹21,000.00');
      expect(r.body.preview.buttons).toEqual([{ type: 'url', text: 'View Quotation', target: 'https://app.example.com/q/AbC123xyz' }, { type: 'phone', text: 'Contact Us', target: '+919845012345' }]);
      expect(r.body.brand.colour).toBe('#0e7490');
      expect(r.body.headerMedia).toMatchObject({ kind: 'image', url: null });
      expect(r.body.headerMedia.missing).toMatch(/logo/i);
      expect(r.body.missing ?? r.body.preview.missing).toEqual([]);
    });

    it('shows the logo once uploaded, and reports validation problems of an unsaved spec', async () => {
      expect((await uploadLogo()).status).toBe(201);
      const r = await admin().post('/agency/whatsapp/templates/preview', { spec: premium().spec });
      expect(r.body.headerMedia.url).toMatch(/\/media\/local\?key=/);
      const bad = await admin().post('/agency/whatsapp/templates/preview', { spec: { ...premium().spec, footer: 'x'.repeat(70) } });
      expect(bad.body.issues.map((i: any) => i.path)).toContain('footer');
    });

    it('with a real conversation the preview is strict: real customer, gaps listed', async () => {
      await customerWrites(w, '+919811000001', 'Need a cab', 'Asha Verma');
      const conv = (await admin().get('/inbox/conversations')).body.items.find((c: any) => c.customer.name === 'Asha Verma').id;
      const r = await admin().post('/agency/whatsapp/templates/preview', { spec: premium().spec, conversationId: conv });
      expect(r.body.preview.body).toContain('Hello Asha Verma 👋');
      expect(r.body.preview.missing.sort()).toEqual(['destination', 'passenger_count', 'quote_token', 'quote_total', 'travel_dates', 'vehicle_type']);
      expect(r.body.preview.body).toContain('{{destination}}');          // never silently filled with a sample for a real customer
    });
  });

  describe('submitting to Meta', () => {
    it('compiles to Meta components, uploads the header example, stores PENDING (never approved) and labels it as registered', async () => {
      const t = await mk(premium());
      w.fake.submissions.length = 0; w.fake.uploads.length = 0;
      const r = await admin().post(`/agency/whatsapp/templates/${t.id}/submit`);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'pending', registeredWithMeta: true, localDraft: false, origin: 'submitted_by_tripos', providerConfirmed: true, providerTemplateId: `meta-${t.name}` });
      expect(r.body.status).not.toBe('approved');
      expect(w.fake.uploads).toEqual([expect.objectContaining({ mimeType: 'image/png', filename: 'header.png' })]);
      const sub = w.fake.submissions[0];
      expect(sub).toMatchObject({ name: t.name, language: 'en', category: 'UTILITY' });
      expect(sub.components.map((c: any) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
      expect(sub.components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::handle-1'] } });
      expect((sub.components[1] as any).text).toContain('Hello {{1}} 👋');
      expect((sub.components[1] as any).example.body_text[0]).toHaveLength(7);
      expect((sub.components[1] as any).example.body_text[0][1]).toBe((await admin().get('/me')).body.agency.name);   // real agency name as the example
      expect((sub.components[3] as any).buttons).toEqual([
        { type: 'URL', text: 'View Quotation', url: 'https://app.example.com/q/{{1}}', example: ['https://app.example.com/q/AbC123xyz'] },
        { type: 'PHONE_NUMBER', text: 'Contact Us', phone_number: '+919845012345' },
      ]);
      // submitted templates are locked
      expect((await admin().patch(`/agency/whatsapp/templates/${t.id}`, premium({ name: t.name }))).body.error.code).toBe('template_locked');
      expect((await admin().del(`/agency/whatsapp/templates/${t.id}`)).status).toBe(409);
      expect((await admin().post(`/agency/whatsapp/templates/${t.id}/submit`)).body.error.code).toBe('already_submitted');
    });

    it('a document header uploads a generated sample quotation PDF as the example', async () => {
      const t = await mk(premium({ spec: { ...premium().spec, header: { type: 'document', source: 'quote_pdf' } } }));
      w.fake.uploads.length = 0; w.fake.submissions.length = 0;
      expect((await admin().post(`/agency/whatsapp/templates/${t.id}/submit`)).status).toBe(201);
      expect(w.fake.uploads[0]).toMatchObject({ mimeType: 'application/pdf', filename: 'sample-quotation.pdf' });
      expect(w.fake.uploads[0].bytes).toBeGreaterThan(1500);
      expect(w.fake.submissions[0].components[0]).toMatchObject({ type: 'HEADER', format: 'DOCUMENT' });
    });

    it('a vehicle-photo header needs a vehicle photo to exist (Meta needs an example image)', async () => {
      const w2 = await bootCloud('NoPhoto');
      const t = (await w2.T.admin.post('/agency/whatsapp/templates', premium({ spec: { ...premium().spec, header: { type: 'image', source: 'vehicle_photo' } } }))).body;
      const r = await w2.T.admin.post(`/agency/whatsapp/templates/${t.id}/submit`);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('header_media_missing');
      await createVehicle(w2.T.admin, 'PhotoCar', 1);
      expect((await w2.T.admin.post(`/agency/whatsapp/templates/${t.id}/submit`)).status).toBe(201);
      await w2.app.close();
    });

    it('a logo header cannot be submitted before a logo is uploaded', async () => {
      const w2 = await bootCloud('NoLogo');
      const t = (await w2.T.admin.post('/agency/whatsapp/templates', premium())).body;
      const r = await w2.T.admin.post(`/agency/whatsapp/templates/${t.id}/submit`);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/logo/i);
      expect(w2.fake.submissions).toHaveLength(0);
      await w2.app.close();
    });

    it('surfaces Meta rejections of the submission and keeps the draft', async () => {
      const t = await mk(premium({ spec: { ...premium().spec, header: { type: 'none' } } }));
      w.fake.submitError = new WaSendError('Template name already exists in this language', '100', false, 'unknown');
      const r = await admin().post(`/agency/whatsapp/templates/${t.id}/submit`);
      w.fake.submitError = undefined;
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/already exists/);
      expect((await admin().get(`/agency/whatsapp/templates/${t.id}`)).body.status).toBe('local_draft');
    });

    it('a credential failure during submission flags the connection instead of failing silently', async () => {
      const w2 = await bootCloud('AuthFail');
      const t = (await w2.T.admin.post('/agency/whatsapp/templates', premium({ spec: { ...premium().spec, header: { type: 'none' } } }))).body;
      w2.fake.submitError = authError();
      const r = await w2.T.admin.post(`/agency/whatsapp/templates/${t.id}/submit`);
      expect(r.status).toBe(400);
      expect((await w2.T.admin.get('/agency/whatsapp')).body.connectionStatus).toBe('degraded');
      await w2.app.close();
    });

    it('Meta approval arrives only by the provider (webhook), and only then is it shown as approved', async () => {
      const t = await mk(premium({ spec: { ...premium().spec, header: { type: 'none' } } }));
      await admin().post(`/agency/whatsapp/templates/${t.id}/submit`);
      expect((await admin().get(`/agency/whatsapp/templates/${t.id}`)).body.status).toBe('pending');
      await request(w.app.getHttpServer()).post('/webhooks/whatsapp').send({ entry: [{ id: w.waba, time: Math.floor(Date.now() / 1000), changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: `meta-${t.name}`, message_template_name: t.name, message_template_language: 'en' } }] }] });
      const v = (await admin().get(`/agency/whatsapp/templates/${t.id}`)).body;
      expect(v).toMatchObject({ status: 'approved', providerConfirmed: true, registeredWithMeta: true });
      expect((await admin().get('/agency/whatsapp/templates?status=approved')).body.map((x: any) => x.id)).toContain(t.id);
    });
  });
});
