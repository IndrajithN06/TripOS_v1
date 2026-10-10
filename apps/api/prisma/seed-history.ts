/* Development-only: adds ~45 days of synthetic, backdated activity so the analytics dashboard has something to show.
   Idempotent per agency (skips if history already exists). Refuses to run in production. */
import 'reflect-metadata';
import { calculateQuote } from '@tripos/pricing';
import { PrismaClient } from '@prisma/client';
import { config } from '../src/config/config';
import { toSnapshot } from '../src/modules/vehicles/vehicles.module';

const DAYS = 45;
let seed = 20261010;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const NAMES = ['Aarav Mehta', 'Diya Rao', 'Kabir Singh', 'Ishita Das', 'Rohan Iyer', 'Meera Pillai', 'Arjun Nair', 'Sana Khan', 'Vikram Shah', 'Neha Joshi', 'Karthik R', 'Anita Menon', 'Farhan Ali', 'Pooja Hegde', 'Sanjay Kulkarni'];
const DESTS = ['Coorg', 'Mysore', 'Ooty', 'Chikmagalur', 'Hampi', 'Pondicherry', 'Wayanad', 'Gokarna', 'Kabini', 'Airport transfer'];
const TEXTS = ['Need a cab for {d}, {n} people', 'Looking for a vehicle to {d}', 'Quote for {d} trip please', 'Weekend trip to {d}, family of {n}', 'Tempo traveller needed to {d}'];

async function main() {
  if (config().isProd) throw new Error('Refusing to run in production');
  const db = new PrismaClient();
  const agencies = await db.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.bypass','on',true)`; return tx.agency.findMany({ where: { slug: { in: ['golden-demo', 'lakshya-demo'] } } }); });

  for (const ag of agencies) {
    const volume = ag.slug === 'golden-demo' ? 1 : 0.55;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.agency_id', ${ag.id}, true)`;
      if (await tx.customer.count({ where: { agencyId: ag.id, phoneE164: { startsWith: '+9177' } } })) { console.log(`history exists for ${ag.slug}`); return; }
      const users = await tx.user.findMany({ where: { agencyId: ag.id, status: 'active' } });
      const sales = users.find((u) => u.role === 'SALES')!, admin = users.find((u) => u.role === 'AGENCY_ADMIN')!;
      const vts = await tx.vehicleType.findMany({ where: { agencyId: ag.id } });
      const rates = new Map<string, any>();
      for (const v of vts) rates.set(v.id, await tx.vehicleRate.findFirstOrThrow({ where: { vehicleTypeId: v.id }, orderBy: { effectiveAt: 'desc' } }));
      const branding = await tx.agencyBranding.findUniqueOrThrow({ where: { agencyId: ag.id } });
      let seq = ag.quoteSeq + 100; // leave room; numbers only need to be unique
      let n = 0;

      for (let d = DAYS; d >= 0; d--) {
        const dow = new Date(Date.now() - d * 86400000).getDay();
        // busier weekends and a gentle upward trend
        const base = (dow === 0 || dow === 6 ? 3.2 : 2.1) * (0.8 + 0.4 * ((DAYS - d) / DAYS)) * volume;
        const count = Math.max(0, Math.round(base + (rnd() - 0.5) * 2.4));
        for (let i = 0; i < count; i++) {
          // enquiries cluster in the morning and evening
          const hr = pick([9, 10, 10, 11, 12, 14, 15, 17, 18, 18, 19, 20, 21, 7, 22]);
          const at = new Date(Date.now() - d * 86400000); at.setHours(hr, Math.floor(rnd() * 60), 0, 0);
          if (at > new Date()) continue;
          const phone = `+9177${String(10000000 + n * 7919 % 89999999).slice(0, 8)}`;
          n++;
          const cust = await tx.customer.create({ data: { agencyId: ag.id, name: pick(NAMES), phoneE164: phone, createdAt: at } });
          const dest = pick(DESTS), pax = 2 + Math.floor(rnd() * 10);
          const conv = await tx.conversation.create({ data: { agencyId: ag.id, customerId: cust.id, createdAt: at, lastMessageAt: at, lastInboundAt: at, status: d > 3 && rnd() < 0.5 ? 'closed' : 'open', assignedUserId: rnd() < 0.6 ? sales.id : null } });
          await tx.message.create({ data: { agencyId: ag.id, conversationId: conv.id, direction: 'inbound', type: 'text', text: pick(TEXTS).replace('{d}', dest).replace('{n}', String(pax)), status: 'received', simulated: true, createdAt: at, providerMessageId: `hist.${ag.slug}.${n}` } });
          if (rnd() < 0.92) {
            const reply = new Date(at.getTime() + (2 + rnd() * rnd() * 90) * 60000);
            await tx.message.create({ data: { agencyId: ag.id, conversationId: conv.id, direction: 'outbound', type: 'text', text: 'Thanks for reaching out! Sharing details shortly.', status: 'read', simulated: true, sentByUserId: sales.id, createdAt: reply } });
          }
          if (rnd() > 0.72) continue; // not every enquiry becomes a quote

          const vt = pick(vts), rate = rates.get(vt.id)!;
          const outstation = rnd() < 0.7, days = 1 + Math.floor(rnd() * 4), km = days * (250 + Math.floor(rnd() * 200));
          const snap = toSnapshot(rate);
          const disc = rnd() < 0.3 ? { type: 'percent' as const, value: String(pick([3, 5, 8])) } : undefined;
          const price = calculateQuote({
            tripType: outstation ? 'outstation' : 'local_8h_80km', rate: snap, days, km, hours: 8 + Math.floor(rnd() * 4), includeDriverBatta: true, discount: disc,
            extraCharges: rnd() < 0.5 ? [{ label: 'Estimated toll', amount: String(pick([300, 450, 700])), taxable: false }] : [],
            tax: { enabled: ag.taxEnabled, ratePercent: ag.taxRatePercent.toString(), mode: ag.taxMode as 'exclusive' },
          });
          const createdAt = new Date(reply0(at)), sentAt = new Date(createdAt.getTime() + 20 * 60000 + rnd() * 3600000);
          const roll = rnd();
          const status = roll < 0.3 ? 'accepted' : roll < 0.45 ? 'declined' : roll < 0.7 ? 'negotiating' : roll < 0.9 ? 'sent' : roll < 0.95 ? 'draft' : 'send_failed';
          const sent = !['draft', 'send_failed'].includes(status);
          seq++;
          const q = await tx.quote.create({ data: { agencyId: ag.id, quoteNumber: `Q-${String(seq).padStart(4, '0')}`, customerId: cust.id, conversationId: conv.id, ownerUserId: rnd() < 0.7 ? sales.id : admin.id, status, createdAt, expiryAt: new Date(createdAt.getTime() + 7 * 86400000), followUpAt: status === 'sent' && rnd() < 0.4 ? new Date(Date.now() - 86400000) : null } });
          const ts = { agencyName: ag.name, timezone: ag.timezone, brandColour: branding.brandColour, tagline: branding.tagline, phone: branding.phone, email: branding.email, website: branding.website, address: branding.address, footer: branding.footer, logoAssetId: null, inclusions: branding.inclusions, exclusions: branding.exclusions, notes: null, terms: branding.terms };
          const v = await tx.quoteVersion.create({ data: {
            agencyId: ag.id, quoteId: q.id, versionNumber: 1, status: sent ? 'sent' : status === 'send_failed' ? 'failed' : 'draft', createdById: q.ownerUserId, createdAt, sentAt: sent ? sentAt : null,
            trip: { tripType: outstation ? 'outstation' : 'local_8h_80km', pickupAt: new Date(createdAt.getTime() + 2 * 86400000).toISOString(), pickupLocation: 'Bangalore', destinations: [dest], passengers: pax, days } as any,
            vehicleTypeId: vt.id, vehicleName: vt.name, rateSnapshot: snap as any, pricingInput: { input: {}, tax: { enabled: ag.taxEnabled, ratePercent: ag.taxRatePercent.toString(), mode: ag.taxMode } } as any,
            lines: price.lines as any, subtotal: price.subtotal, discount: price.discount, tax: price.tax, total: price.total, termsSnapshot: ts as any,
          } });
          await tx.quote.update({ where: { id: q.id }, data: { currentVersionId: v.id } });
          if (sent) {
            const kinds = ['text', 'pdf', 'image'];
            for (const k of kinds) await tx.quoteSendAttempt.create({ data: { agencyId: ag.id, quoteVersionId: v.id, kind: k, status: k === 'image' && rnd() < 0.08 ? 'failed' : 'sent', attempts: 1, createdAt: sentAt } });
          }
          await tx.auditLog.create({ data: { agencyId: ag.id, actorUserId: q.ownerUserId, action: 'quote.created', entityType: 'quote', entityId: q.id, createdAt } });
          if (status === 'accepted') await tx.auditLog.create({ data: { agencyId: ag.id, actorUserId: q.ownerUserId, action: 'quote.status_changed', entityType: 'quote', entityId: q.id, metadata: { from: 'sent', to: 'accepted' }, createdAt: new Date(sentAt.getTime() + (1 + rnd() * 36) * 3600000) } });
        }
      }
      await tx.agency.update({ where: { id: ag.id }, data: { quoteSeq: seq } });
      console.log(`history added for ${ag.slug}: ${n} enquiries`);
    }, { timeout: 120000 });
  }
  await db.$disconnect();
}
const reply0 = (d: Date) => d.getTime() + 10 * 60000;
void main().catch((e) => { console.error(e); process.exit(1); });
