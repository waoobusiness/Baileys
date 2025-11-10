import Fastify from 'fastify';
import { z } from 'zod';
import { detectKind, getDealerFromVehicle, parseDealer, listInventory } from './autoscout.js';
import { upsertDealer, upsertVehicles } from './supabase.js';

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT ?? 3002);
const BEARER = process.env.RESOLVER_BEARER ?? '';

function assertAuth(req: any) {
  const hdr = req.headers['authorization'] || '';
  if (!hdr.startsWith('Bearer ') || hdr.slice(7) !== BEARER) {
    throw app.httpErrors.unauthorized('Missing/invalid bearer');
  }
}

app.get('/health', async () => ({ ok: true, service: 'cars-resolver' }));

// POST /cars/connect  { url, depth? }
app.post('/cars/connect', async (req, res) => {
  assertAuth(req);
  const schema = z.object({
    url: z.string().url(),
    depth: z.enum(['summary', 'full']).optional().default('summary')
  });
  const { url, depth } = schema.parse(req.body);

  const kind = detectKind(url);

  let dealerUrl: string;
  let firstVehicle: any | null = null;

  if (kind === 'vehicle') {
    const { dealerUrl: du, vehicle } = await getDealerFromVehicle(url);
    dealerUrl = du;
    firstVehicle = vehicle;
  } else {
    dealerUrl = url;
  }

  const dealer = await parseDealer(dealerUrl);
  if (firstVehicle) firstVehicle.dealer_platform_id = dealer.platform_id;

  if (process.env.UPSERT_TO_SUPABASE === 'true') {
    await upsertDealer(dealer);
  }

  // inventory (first sync)
  const inventory = await listInventory(dealerUrl, 40, depth);
  if (firstVehicle) {
    inventory.unshift(firstVehicle as any);
  }

  if (process.env.UPSERT_TO_SUPABASE === 'true') {
    await upsertVehicles(inventory);
  }

  return res.send({
    platform: 'autoscout24_ch',
    source_type: kind,
    dealer,
    inventory_count: inventory.length
  });
});

// POST /cars/resync { dealer_profile_url, depth? }
app.post('/cars/resync', async (req, res) => {
  assertAuth(req);
  const schema = z.object({
    dealer_profile_url: z.string().url(),
    depth: z.enum(['summary', 'full']).optional().default('summary')
  });
  const { dealer_profile_url, depth } = schema.parse(req.body);

  const dealer = await parseDealer(dealer_profile_url);
  if (process.env.UPSERT_TO_SUPABASE === 'true') {
    await upsertDealer(dealer);
  }
  const inventory = await listInventory(dealer_profile_url, 40, depth);
  if (process.env.UPSERT_TO_SUPABASE === 'true') {
    await upsertVehicles(inventory);
  }

  return res.send({ ok: true, dealer: dealer.platform_id, items: inventory.length });
});

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log('cars-resolver listening on', PORT))
  .catch(err => { console.error(err); process.exit(1); });
