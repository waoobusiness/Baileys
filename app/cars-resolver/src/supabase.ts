import { createClient } from '@supabase/supabase-js';
import type { Dealer, Vehicle, VehicleImage } from './types.js';

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
  const { error } = await sb.from('vehicles').upsert(vs, { onConflict: 'platform,platform_vehicle_id' });
  if (error) throw error;
  return { count: vs.length };
}

export async function upsertVehicleImages(imgs: VehicleImage[]) {
  if (!imgs.length) return { count: 0 };
  const { error } = await sb.from('vehicle_images').upsert(imgs, { onConflict: 'platform,platform_vehicle_id,url' });
  if (error) throw error;
  return { count: imgs.length };
}

export async function markMissingAsUnlisted(dealer_platform_id: string, keepIds: string[]) {
  const { error, count } = await sb
    .from('vehicles')
    .update({ status: 'unlisted' })
    .neq('status', 'unlisted')
    .eq('dealer_platform_id', dealer_platform_id)
    .not('platform_vehicle_id', 'in', `(${keepIds.join(',') || 'null'})`);
  if (error) throw error;
  return { count };
}

export async function logImportStart(dealer_platform_id: string) {
  const { data, error } = await sb.from('imports_log')
    .insert({ dealer_platform_id })
    .select().single();
  if (error) throw error;
  return data;
}

export async function logImportEnd(id: number, patch: Partial<{items_found:number;items_upserted:number;items_marked_unlisted:number;error:string}>) {
  const { error } = await sb.from('imports_log')
    .update({ ...patch, run_ended_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function getGarageAI(dealer_platform_id: string) {
  const { data, error } = await sb
    .from('garage_ai')
    .select('assistant_id, vector_store_id')
    .eq('dealer_platform_id', dealer_platform_id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}
