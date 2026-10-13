import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Db } from '../src/db/db.service';
import { configureApp } from '../src/main';
import { WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { FakeCloud } from './fake-cloud';
import { Client, onboard, superAdmin, Tenant, uid } from './helpers';

/** An app wired to a fake Meta ("cloud mode"), one agency already connected to a fake WhatsApp number. */
export interface CloudWorld { app: INestApplication; fake: FakeCloud; db: Db; sa: Client; T: Tenant; phone: string; waba: string }

export async function bootCloud(label = 'Cloud'): Promise<CloudWorld> {
  const fake = new FakeCloud();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WHATSAPP).useValue(fake).compile();
  const app = configureApp(mod.createNestApplication({ bodyParser: false, logger: false }));
  await app.init();
  const sa = await superAdmin(app);
  const T = await onboard(app, sa, label, { connect: false });
  const phone = `PN-${uid()}`, waba = `WABA-${uid()}`;
  const r = await T.admin.post('/agency/whatsapp/connect', { displayName: `${label} line`, wabaId: waba, phoneNumberId: phone, accessToken: 'EAAG-fake-token-value' });
  if (r.status !== 201) throw new Error(`connect failed ${JSON.stringify(r.body)}`);
  return { app, fake, db: app.get(Db), sa, T, phone, waba };
}

/** A customer message arriving through the webhook (opens the 24 h window and creates the conversation). */
export async function customerWrites(w: Pick<CloudWorld, 'app' | 'phone' | 'waba'>, from: string, text = 'hello', name = 'Test Customer') {
  await request(w.app.getHttpServer()).post('/webhooks/whatsapp').send({
    entry: [{ id: w.waba, changes: [{ field: 'messages', value: { metadata: { phone_number_id: w.phone }, contacts: [{ wa_id: from.slice(1), profile: { name } }], messages: [{ id: `in-${uid()}`, from: from.slice(1), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
  });
}
