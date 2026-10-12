/* Development seed. Synthetic data only. Refuses to run in production. */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { placeholderPng } from '../src/common/placeholder-png';
import { AppModule } from '../src/app.module';
import { AssetService } from '../src/common/assets';
import { Principal } from '../src/common/auth';
import { config } from '../src/config/config';
import { Db } from '../src/db/db.service';
import { InboundService } from '../src/modules/webhooks/webhooks.module';
import { QuotesService } from '../src/modules/quotes/quotes.service';

export const DEV_PASSWORD = process.env.SEED_PASSWORD ?? 'DevPassword!123';

const AGENCIES = [
  { name: 'Golden Travels (demo)', slug: 'golden-demo', colour: '#b7791f', admin: 'admin@golden.test', sales: 'sales@golden.test', phone: '+91 80000 11111', tag: 'Comfortable journeys across Karnataka', hue: [183, 121, 31] },
  { name: 'Lakshya Tours (demo)', slug: 'lakshya-demo', colour: '#3468e8', admin: 'admin@lakshya.test', sales: 'sales@lakshya.test', phone: '+91 80000 22222', tag: 'Your trip, our wheels', hue: [52, 104, 232] },
];
const VEHICLES = [
  { name: 'Sedan (Dzire)', category: 'sedan', seats: 4, desc: 'Compact AC sedan for city and airport runs', rate: ['2400', '1500', '260', '14', '12', 250, '500'], amen: ['AC', 'Music system'] },
  { name: 'Innova Crysta', category: 'suv', seats: 7, desc: 'Premium SUV with captain seats', rate: ['4200', '2700', '350', '23', '20', 300, '800'], amen: ['AC', 'Charging ports', 'Captain seats'] },
  { name: 'Tempo Traveller', category: 'tempo traveller', seats: 14, desc: '14-seater for groups', rate: ['6500', '4200', '500', '32', '28', 300, '1000'], amen: ['AC', 'Pushback seats'] },
];

async function main() {
  if (config().isProd) throw new Error('Refusing to seed a production environment');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const db = app.get(Db), assets = app.get(AssetService), quotes = app.get(QuotesService), inbound = app.get(InboundService);
  const hash = await bcrypt.hash(DEV_PASSWORD, 10);

  await db.system(async (tx) => {
    await tx.user.upsert({ where: { email: 'superadmin@tripos.local' }, update: {}, create: { name: 'Platform Owner', email: 'superadmin@tripos.local', role: 'SUPER_ADMIN', status: 'active', passwordHash: hash } });
  });

  for (const a of AGENCIES) {
    if (await db.system((tx) => tx.agency.findUnique({ where: { slug: a.slug } }))) { console.log(`skip ${a.slug} (exists)`); continue; }
    const ids = await db.system(async (tx) => {
      const ag = await tx.agency.create({ data: { name: a.name, slug: a.slug, status: 'active', taxEnabled: true, taxRatePercent: 5, taxMode: 'exclusive' } });
      await tx.agencyBranding.create({ data: { agencyId: ag.id, brandColour: a.colour, tagline: a.tag, phone: a.phone, email: `hello@${a.slug}.test`, website: `https://${a.slug}.test`, address: 'MG Road, Bengaluru (synthetic)', footer: `${a.name} · ${a.phone}`, terms: 'Toll, parking and permits extra unless stated. Advance of 30% confirms the booking. Cancellation: free up to 24h before pickup.', inclusions: 'Fuel, driver, vehicle', exclusions: 'Toll, parking, interstate permit, driver night halt' } });
      const admin = await tx.user.create({ data: { agencyId: ag.id, name: `${a.slug} Admin`, email: a.admin, role: 'AGENCY_ADMIN', status: 'active', passwordHash: hash } });
      const sales = await tx.user.create({ data: { agencyId: ag.id, name: `${a.slug} Sales`, email: a.sales, role: 'SALES', status: 'active', passwordHash: hash } });
      await tx.whatsappAccount.create({ data: { agencyId: ag.id, mode: 'simulator', phoneNumberId: `sim-${ag.id.slice(0, 8)}`, displayName: a.name, webhookSubscribed: true } });
      await tx.whatsappTemplate.createMany({ data: [
        { agencyId: ag.id, name: 'quote_followup', body: 'Hi {{1}}, following up on your quotation {{2}}. Shall we confirm?', variableSchema: ['customer_name', 'quote_number'], providerStatus: 'approved' },
        { agencyId: ag.id, name: 'festival_offer', category: 'MARKETING', body: 'Hi {{1}}, special weekend rates on SUVs!', variableSchema: ['customer_name'], providerStatus: 'local_draft' },
      ] });
      return { agencyId: ag.id, adminId: admin.id, salesId: sales.id, phoneNumberId: `sim-${ag.id.slice(0, 8)}` };
    });

    const vtIds: Record<string, string> = {};
    await db.tenant(ids.agencyId, async (tx) => {
      for (const [i, v] of VEHICLES.entries()) {
        const [p8, p4, xh, xk, os, min, batta] = v.rate as [string, string, string, string, string, number, string];
        const vt = await tx.vehicleType.create({ data: { agencyId: ids.agencyId, name: v.name, category: v.category, seats: v.seats, description: v.desc, amenities: v.amen } });
        vtIds[v.name] = vt.id;
        await tx.vehicleRate.create({ data: { agencyId: ids.agencyId, vehicleTypeId: vt.id, local8h80kmPrice: p8, local4h40kmPrice: p4, extraHourRate: xh, extraKmRate: xk, outstationRatePerKm: os, minKmPerDay: min, driverBattaPerDay: batta } });
        for (let k = 0; k < 3; k++) {
          const asset = await assets.storeBuffer(tx, ids.agencyId, ids.adminId, placeholderPng(a.hue[0] + i * 20 + k * 25, a.hue[1] + k * 30, a.hue[2] + i * 15), 'image/png', 'vehicle_image');
          await tx.vehicleTypeImage.create({ data: { agencyId: ids.agencyId, vehicleTypeId: vt.id, assetId: asset.id, sortOrder: k, isPrimary: k === 0, caption: ['Exterior', 'Interior', 'Boot space'][k], altText: `${v.name} ${['exterior', 'interior', 'boot'][k]} (synthetic placeholder)` } });
        }
      }
    });

    const msg = (from: string, name: string, text: string) => inbound.process([{ kind: 'message', phoneNumberId: ids.phoneNumberId, providerMessageId: `seed.${a.slug}.${from}.${Math.random().toString(36).slice(2)}`, from, name, type: 'text', text, timestamp: new Date() }]);
    await msg('+919900000001', 'Rahul Shetty', 'Hi, need an Innova Crysta from Bangalore to Coorg for 3 days, 5 people. Budget around 25000');
    await msg('+919900000002', 'Priya Nair', 'Looking for a sedan for local city tour tomorrow, 4 hours');
    await msg('+919900000003', 'Suresh Kumar', 'Hello, need tempo traveller Bangalore to Mysore, 12 people');

    const admin: Principal = { userId: ids.adminId, agencyId: ids.agencyId, role: 'AGENCY_ADMIN', name: 'Admin', email: a.admin, canOverrideRates: true, mfaEnabled: false };
    const conv = await db.tenant(ids.agencyId, (tx) => tx.conversation.findMany({ where: { agencyId: ids.agencyId }, orderBy: { createdAt: 'asc' } }));
    const imgs = await db.tenant(ids.agencyId, (tx) => tx.vehicleTypeImage.findMany({ where: { agencyId: ids.agencyId, vehicleTypeId: vtIds['Innova Crysta'] }, orderBy: { sortOrder: 'asc' } }));
    const q = await quotes.create(admin, ids.agencyId, {
      conversationId: conv[0].id, vehicleTypeId: vtIds['Innova Crysta'], overrides: {}, includeDriverBatta: true, imageAssetIds: imgs.slice(0, 2).map((i) => i.assetId),
      trip: { tripType: 'outstation', pickupAt: new Date(Date.now() + 2 * 86400000).toISOString(), returnAt: new Date(Date.now() + 5 * 86400000).toISOString(), pickupLocation: 'Bangalore', destinations: ['Coorg'], passengers: 5, days: 3, km: 750, itinerary: 'Day 1: Bangalore to Coorg. Day 2: Local sightseeing. Day 3: Return.' },
      extraCharges: [{ label: 'Estimated toll', amount: '600', taxable: false }],
    } as any);
    await quotes.send(admin, ids.agencyId, q.id, 1, {});
    await quotes.create(admin, ids.agencyId, {
      conversationId: conv[1].id, vehicleTypeId: vtIds['Sedan (Dzire)'], overrides: {}, includeDriverBatta: true, imageAssetIds: [],
      trip: { tripType: 'local_4h_40km', pickupAt: new Date(Date.now() + 86400000).toISOString(), pickupLocation: 'Indiranagar', destinations: ['City tour'], passengers: 4, hours: 5, km: 55 }, extraCharges: [],
    } as any);
    console.log(`seeded ${a.slug}: ${a.admin} / ${a.sales}`);
  }
  console.log(`\nDev password for all seeded users: ${DEV_PASSWORD}\nSuper admin: superadmin@tripos.local`);
  await app.close();
}
void main().catch((e) => { console.error(e); process.exit(1); });
