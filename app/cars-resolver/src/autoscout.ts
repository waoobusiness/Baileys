import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import type { Dealer, Vehicle, VehicleImage } from './types.js';

const UA = process.env.DEFAULT_USER_AGENT ?? 'Mozilla/5.0';
const MIN = Number(process.env.REQUEST_BACKOFF_MS_MIN ?? 300);
const MAX = Number(process.env.REQUEST_BACKOFF_MS_MAX ?? 700);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 60);

function normUrl(u: string) {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  return 'https://www.autoscout24.ch' + (u.startsWith('/') ? u : `/${u}`);
}

export function detectKind(url: string): 'dealer'|'vehicle' {
  const u = new URL(url);
  if (u.pathname.includes('/s/seller-')) return 'dealer';
  if (u.pathname.includes('/d/')) return 'vehicle';
  throw new Error('URL AutoScout24 non reconnue');
}

async function fetchHtml(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-CH,fr;q=0.9' }, cache: 'no-store' as any });
  if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
  return res.text();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function backoff() { return sleep(MIN + Math.floor(Math.random()*(MAX-MIN))); }

function parseSrcset(srcset?: string | null): string | null {
  if (!srcset) return null;
  const best = srcset.split(',').map(s => s.trim().split(' ')[0]).pop();
  return best || null;
}

export async function getDealerFromVehicle(vehicleUrl: string): Promise<{ dealerUrl: string; vehicle: Partial<Vehicle>; images: VehicleImage[] }> {
  const html = await fetchHtml(vehicleUrl);
  const $ = cheerio.load(html);

  // Seller link
  const sellerA = $('a[href*="/s/seller-"]').first();
  const dealerUrl = normUrl(sellerA.attr('href') || '');

  // Vehicle id
  const idMatch = vehicleUrl.match(/-(\d{6,})$/);
  const platform_vehicle_id = idMatch ? idMatch[1] : '';

  // Title/price
  const title = $('h1').first().text().trim() || $('title').text().trim();
  const price = $('[data-testid="price-vat"], [data-testid="price"]').first().text().replace(/[^0-9]/g, '');
  const price_chf = price ? Number(price) : null;

  // Specs (best effort, selectors tolérants)
  const spec = (lbl: string) => $(`dt:contains("${lbl}")`).next('dd').text().trim();

  const v: Partial<Vehicle> = {
    platform: 'autoscout24_ch',
    platform_vehicle_id,
    dealer_platform_id: '',
    url: vehicleUrl,
    title,
    price_chf,
    brand: spec('Marque') || undefined,
    model: spec('Modèle') || undefined,
    year_month_reg: spec('1ère immatriculation')?.replace(/\s/g, '') || null,
    mileage_km: Number((spec('Kilométrage')||'').replace(/\D/g,'')) || null,
    fuel: spec('Carburant') || null,
    transmission: spec('Boîte de vitesses') || null,
    body_type: spec('Catégorie') || null,
    drivetrain: spec('Roues motrices') || null,
    power_ps: Number((spec('Puissance')||'').replace(/\D/g,'')) || null,
    engine_displacement_cm3: Number((spec('Cylindrée')||'').replace(/\D/g,'')) || null,
    doors: Number((spec('Portes')||'').replace(/\D/g,'')) || null,
    seats: Number((spec('Sièges')||'').replace(/\D/g,'')) || null,
    co2_g_km: Number((spec('CO₂')||'').replace(/\D/g,'')) || null,
    efficiency_label: spec('Classe d\'efficacité') || null,
    colors: { exterior: spec('Couleur extérieure') || null, interior: spec('Couleur intérieure') || null },
    warranty: spec('Garantie') || null,
    import_parallel: /import/i.test(spec('Origine')||'') || null,
    accident: /accident/i.test(spec('État du véhicule')||'') || null,
    ct_expertisee: /expertis|MFK/i.test(spec('Contrôle technique')||'') || null,
    details_json: {
      description: $('[data-testid="vehicle-description"]').text().trim() || null,
      equipment_optional: $('ul[data-testid="optional-equipments"] li').map((_,li)=>$(li).text().trim()).get(),
      equipment_standard: $('ul[data-testid="standard-equipments"] li').map((_,li)=>$(li).text().trim()).get(),
      finance_texts: $('[data-testid="finance"]').map((_,e)=>$(e).text().trim()).get()
    }
  };

  // Images
  const imgs: VehicleImage[] = $('[data-testid="gallery"] img, img[srcset*="/vehicles/"]')
    .map((i, img) => {
      const src = $(img).attr('src') || parseSrcset($(img).attr('srcset'));
      return src ? {
        platform: 'autoscout24_ch',
        platform_vehicle_id,
        url: normUrl(src),
        idx: i
      } as VehicleImage : null;
    }).get().filter(Boolean) as VehicleImage[];

  // Thumbnail
  v.thumbnail = imgs[0]?.url || null;

  return { dealerUrl, vehicle: v, images: imgs };
}

export async function parseDealer(dealerUrl: string): Promise<Dealer> {
  const html = await fetchHtml(dealerUrl);
  const $ = cheerio.load(html);

  const platform_id = (dealerUrl.match(/seller-\d+/)?.[0]) ?? '';
  const name = $('h1, h2').first().text().trim();
  const address = $('[data-testid="address"]').text().trim() || $('address').text().trim();

  const logo = $('img[alt*="logo"]').attr('src') ||
               $('img[srcset*="/seller/logos/"]').attr('srcset') ||
               $('img[src*="/seller/logos/"]').attr('src') || null;
  const logo_url = logo?.includes('srcset') ? parseSrcset(logo) : logo;

  // rating (si visible)
  const ratingTxt = $('[data-testid="rating"]').text().replace(',', '.');
  const rating = ratingTxt ? Number(ratingTxt) : null;
  let reviews_count: number | null = null;
  const rc = $('[data-testid="reviews-count"]').text().replace(/\D/g, '');
  if (rc) reviews_count = Number(rc);

  return {
    platform: 'autoscout24_ch',
    platform_id,
    name,
    profile_url: dealerUrl,
    address: address || undefined,
    rating,
    reviews_count,
    logo_url: logo_url ? normUrl(logo_url) : null
  };
}

// Liste toutes les cartes depuis la page vendeur (summary)
export async function listInventorySummary(dealerUrl: string): Promise<Pick<Vehicle,'platform_vehicle_id'|'url'|'title'|'price_chf'>[]> {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? dealerUrl : `${dealerUrl}?page=${page}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    // cartes
    const cards = $('[data-testid^="listing-card"] a[href^="/"], a[aria-label][href*="/d/"]');
    if (!cards.length) break;

    cards.each((_, a) => {
      const href = normUrl($(a).attr('href')!);
      const id = href.match(/-(\d{6,})$/)?.[1];
      if (!id) return;
      const title = $(a).attr('aria-label') || $(a).text().trim();
      const priceTxt = $(a).closest('[data-testid^="listing-card"]').find('[data-testid="price"]').first().text().replace(/\D/g,'');
      out.push({
        platform_vehicle_id: id,
        url: href,
        title,
        price_chf: priceTxt ? Number(priceTxt) : null
      });
    });

    await backoff();
  }
  // dédoublonnage par id
  const seen = new Set<string>();
  return out.filter(v => (seen.has(v.platform_vehicle_id) ? false : (seen.add(v.platform_vehicle_id), true)));
}

// Enrichit chaque véhicule (détails complets + images)
export async function hydrateVehicles(dealerId: string, items: any[]) {
  const limit = pLimit(4);
  const results: { vehicle: Vehicle; images: VehicleImage[] }[] = [];
  await Promise.all(items.map(it => limit(async () => {
    const { dealerUrl, vehicle, images } = await getDealerFromVehicle(it.url);
    const v: Vehicle = { ...vehicle, dealer_platform_id: dealerId } as Vehicle;
    results.push({ vehicle: v, images });
    await backoff();
  })));
  return results;
}
