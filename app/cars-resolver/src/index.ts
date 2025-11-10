import Fastify from 'fastify';
import { z } from 'zod';
import { detectKind, getDealerFromVehicle, parseDealer, listInventorySummary, hydrateVehicles } from './autoscout.js';
import { upsertDealer, upsertVehicles, upsertVehicleImages, markMissingAsUnlisted, logImportStart, logImportEnd, getGarageAI } from './supabase.js';
import { ensureVehicleDoc } from './openai.js';

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT ?? 3002);
const BEARER = process.env.RESOLVER_BEARER ?? '';
const DO_UPSERT = (process.env.UPSERT_TO_SUPABASE ?? 'true') === 'true';
const DO_MARK_UNLISTED = (process.env.MARK_MISSING_AS_UNLISTED ?? 'true') === 'true';
const VS_ENABLED = (process.env.VS_AUTO_SYNC ?? 'false') === 'true';

function assertAuth(req: any) {
  const hdr = req.headers['authorization'] || '';
  if (!hdr.startsWith('Bearer ') || hdr.slice(7) !== BEARER) {
    throw app.httpErrors.unauthorized('Missing/invalid bearer');
  }
}

app.get('/health', async () => ({ ok: true, service: 'cars-resolver' }));

/**
 * POST /cars/connect
 * body: { url: string, depth?: 'summary'|'full' }
 * - Accepte une URL fiche OU vendeur
 * - Retourne dealer détecté + lance premier import (summary ou full)
 */
app.post('/cars/connect', async (req, res) => {
  assertAuth(req);
  const schema = z.object({
    url: z.string().url(),
    depth: z.enum(['summary', 'full']).optional().default('summary')
  });
  const { url, depth } = schema.parse(req.body);
  const kind = detectKind(url);

  let dealerUrl: string;
  let dealerId: string;
  let preVehicle: any | null = null;

  if (kind === 'vehicle') {
    const { dealerUrl: du, vehicle } = await getDealerFromVehicle(url);
    dealerUrl = du;
    preVehicle = vehicle;
  } else {
    dealerUrl = url;
  }

  const dealer = await parseDealer(dealerUrl);
  dealerId = dealer.platform_id;
  if (DO_UPSERT) await upsertDealer(dealer);

  // premier import
  const log = await logImportStart(dealerId);

  try {
    const summary = await listInventorySummary(dealerUrl);
    if (preVehicle) { // s'assurer que la fiche initiale est incluse
      if (!summary.find(s => s.platform_vehicle_id === preVehicle!.platform_vehicle_id)) {
        summary.unshift({ platform_vehicle_id: preVehicle.platform_vehicle_id, url: preVehicle.url, title: preVehicle.title, price_chf: preVehicle.price_chf });
      }
    }

    let upserted = 0;
    let marked = 0;
    const keepIds = summary.map(s => s.platform_vehicle_id);

    if (depth === 'summary') {
      const vehicles = summary.map(s => ({
        platform: 'autoscout24_ch',
        platform_vehicle_id: s.platform_vehicle_id,
        dealer_platform_id: dealerId,
        url: s.url,
        title: s.title,
        price_chf: s.price_chf,
        status: 'listed'
      }));
      if (DO_UPSERT) {
        await upsertVehicles(vehicles as any);
        upserted += vehicles.length;
      }
    } else {
      // full: hydrate chaque fiche (détails + images)
      const hydrated = await hydrateVehicles(dealerId, summary);
      if (DO_UPSERT) {
        await upsertVehicles(hydrated.map(h => ({ ...h.vehicle, status: 'listed' })));
        await upsertVehicleImages(hydrated.flatMap(h => h.images));
        upserted += hydrated.length;
      }
      // Vector Store (optionnel)
      if (VS_ENABLED) {
        const ai = await getGarageAI(dealerId);
        if (ai?.vector_store_id) {
          for (const h of hydrated) await ensureVehicleDoc(ai.vector_store_id, h.vehicle);
        }
      }
    }

    if (DO_UPSERT && DO_MARK_UNLISTED) {
      const r = await markMissingAsUnlisted(dealerId, keepIds);
      marked = r.count ?? 0;
    }

    await logImportEnd(log.id, { items_found: summary.length, items_upserted: upserted, items_marked_unlisted: marked });
    return res.send({ dealer, items_found: summary.length, upserted, marked_unlisted: marked });
  } catch (e:any) {
    await logImportEnd(log.id, { error: String(e?.message || e) });
    throw e;
  }
});

/**
 * POST /cars/resync
 * body: { dealer_profile_url: string, depth?: 'summary'|'full' }
 */
app.post('/cars/resync', async (req, res) => {
  assertAuth(req);
  const schema = z.object({
    dealer_profile_url: z.string().url(),
    depth: z.enum(['summary', 'full']).optional().default('summary')
  });
  const { dealer_profile_url, depth } = schema.parse(req.body);

  const dealer = await parseDealer(dealer_profile_url);
  const dealerId = dealer.platform_id;
  if (DO_UPSERT) await upsertDealer(dealer);

  const log = await logImportStart(dealerId);

  try {
    const summary = await listInventorySummary(dealer_profile_url);
    const keepIds = summary.map(s => s.platform_vehicle_id);

    let upserted = 0;
    if (depth === 'summary') {
      const vehicles = summary.map(s => ({
        platform: 'autoscout24_ch',
        platform_vehicle_id: s.platform_vehicle_id,
        dealer_platform_id: dealerId,
        url: s.url,
        title: s.title,
        price_chf: s.price_chf,
        status: 'listed'
      }));
      if (DO_UPSERT) {
        await upsertVehicles(vehicles as any);
        upserted += vehicles.length;
      }
    } else {
      const hydrated = await hydrateVehicles(dealerId, summary);
      if (DO_UPSERT) {
        await upsertVehicles(hydrated.map(h => ({ ...h.vehicle, status: 'listed' })));
        await upsertVehicleImages(hydrated.flatMap(h => h.images));
        upserted += hydrated.length;
      }
      if (VS_ENABLED) {
        const ai = await getGarageAI(dealerId);
        if (ai?.vector_store_id) {
          for (const h of hydrated) await ensureVehicleDoc(ai.vector_store_id, h.vehicle);
        }
      }
    }

    let marked = 0;
    if (DO_UPSERT && DO_MARK_UNLISTED) {
      const r = await markMissingAsUnlisted(dealerId, keepIds);
      marked = r.count ?? 0;
    }

    await logImportEnd(log.id, { items_found: summary.length, items_upserted: upserted, items_marked_unlisted: marked });
    return res.send({ ok: true, dealer: dealerId, found: summary.length, upserted, marked_unlisted: marked });
  } catch (e:any) {
    await logImportEnd(log.id, { error: String(e?.message || e) });
    throw e;
  }
});

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log('cars-resolver listening on', PORT))
  .catch(err => { console.error(err); process.exit(1); });
