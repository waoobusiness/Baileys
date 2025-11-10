import OpenAI from 'openai';
import type { Vehicle } from './types.js';

const apiKey = process.env.OPENAI_API_KEY!;
const vsPrefix = process.env.VS_PREFIX ?? 'cars-';
const enabled = (process.env.VS_AUTO_SYNC ?? 'false') === 'true';

const client = apiKey ? new OpenAI({ apiKey }) : null;

export async function ensureVehicleDoc(vectorStoreId: string, v: Vehicle) {
  if (!enabled || !client) return;

  // Document = JSON lisible par l’assistant (1 doc / véhicule)
  const content = JSON.stringify({
    __kind: 'vehicle',
    platform: v.platform,
    id: v.platform_vehicle_id,
    dealer_id: v.dealer_platform_id,
    url: v.url,
    title: v.title,
    price_chf: v.price_chf,
    brand: v.brand,
    model: v.model,
    year_month_reg: v.year_month_reg,
    mileage_km: v.mileage_km,
    fuel: v.fuel,
    transmission: v.transmission,
    body_type: v.body_type,
    drivetrain: v.drivetrain,
    power_ps: v.power_ps,
    power_kw: v.power_kw,
    colors: v.colors,
    warranty: v.warranty,
    details: v.details_json
  }, null, 2);

  // Trick simple: on (re)uploade en remplaçant la version précédente
  const file = new File([content], `${vsPrefix}${v.platform}-${v.platform_vehicle_id}.json`, { type: 'application/json' });
  const uploaded = await client.files.create({ file, purpose: 'assistants' });
  await client.beta.vectorStores.files.create(vectorStoreId, { file_id: uploaded.id });
}
