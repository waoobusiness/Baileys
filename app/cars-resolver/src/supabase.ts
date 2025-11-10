import { createClient } from '@supabase/supabase-js';
import type { Dealer, Vehicle } from './types.js';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const sb = createClient(url, key, { auth: { persistSession: false } });

export async function upsertDealer(d: Dealer) {
  const { data, error } = await sb
    .from('dealers')
    .upsert({
      platform: d.platform,
      platform_id: d.platform_id,
      name: d.name ?? null,
      profile_url: d.profile_url,
      address: d.address ?? null,
      rating: d.rating ?? null,
      reviews_count: d.reviews_count ?? null,
      logo_url: d.logo_url ?? null
    }, { onConflict: 'platform,platform_id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function upsertVehicles(vs: Vehicle[]) {
  if (!vs.length) return { count: 0 };
  const { error } = await sb
    .from('vehicles')
    .upsert(vs, { onConflict: 'platform,platform_vehicle_id' });
  if (error) throw error;
  return { count: vs.length };
}
