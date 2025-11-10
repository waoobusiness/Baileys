import * as cheerio from 'cheerio';
import type { Dealer, Vehicle } from './types.js';

const UA = process.env.DEFAULT_USER_AGENT ?? 'Mozilla/5.0';

function normUrl(u: string) {
  if (u.startsWith('http')) return u;
  return 'https://www.autoscout24.ch' + u;
}

export function detectKind(url: string): 'dealer'|'vehicle' {
  const u = new URL(url);
  if (u.pathname.includes('/s/seller-')) return 'dealer';
  if (u.pathname.includes('/d/')) return 'vehicle';
  throw new Error('URL AutoScout24 non reconnue');
}

async function fetchHtml(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-CH,fr;q=0.9' }, cache: 'no-store' as any });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  return res.text();
}

export async function getDealerFromVehicle(vehicleUrl: string): Promise<{ dealerUrl: string; vehicle: Partial<Vehicle> }> {
  const html = await fetchHtml(vehicleUrl);
  const $ = cheerio.load(html);

  // seller link
  const sellerA = $('a[href*="/s/seller-"]').first();
  const dealerUrl = normUrl(sellerA.attr('href') || '');

  // quick vehicle info
  const idMatch = vehicleUrl.match(/-(\d{6,})$/);
  const platform_vehicle_id = idMatch ? idMatch[1] : '';
  const title = $('h1').first().text().trim() || $('title').text().trim();
  const price = $('[data-testid="price-vat"] , [data-testid="price"]').first().text().replace(/[^0-9]/g, '');
  const price_chf = price ? Number(price) : null;
  const thumb = $('img').first().attr('src') || null;

  return {
    dealerUrl,
    vehicle: {
      platform: 'autoscout24_ch',
      platform_vehicle_id,
      dealer_platform_id: '', // filled after dealer parsed
      url: vehicleUrl,
      title,
      price_chf,
      thumbnail: thumb
    }
  };
}

export async function parseDealer(dealerUrl: string): Promise<Dealer> {
  const html = await fetchHtml(dealerUrl);
  const $ = cheerio.load(html);

  const platform_id = (dealerUrl.match(/seller-\d+/)?.[0]) ?? '';
  const name = $('h1, h2').first().text().trim();
  const address = $('[data-testid="address"]').text().trim() || $('address').text().trim();
  const logo = $('img[alt*="logo"]').attr('src') || $('img[src*="/seller/logos/"]').attr('src') || null;

  // ratings if present
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
    logo_url: logo ? normUrl(logo) : null
  };
}

export async function listInventory(dealerUrl: string, maxPages = 40, depth: 'summary'|'full' = 'summary'): Promise<Vehicle[]> {
  const dealerId = (dealerUrl.match(/seller-\d+/)?.[0]) ?? '';
  const items: Vehicle[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? dealerUrl : `${dealerUrl}?page=${page}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const links = $('a[href^="/fr/d/"], a[href^="/de/d/"], a[href^="/it/d/"]')
      .map((_, a) => normUrl($(a).attr('href')!))
      .get()
      .filter((v, i, arr) => arr.indexOf(v) === i);

    if (!links.length) break;

    for (const vUrl of links) {
      const idMatch = vUrl.match(/-(\d{6,})$/);
      const platform_vehicle_id = idMatch ? idMatch[1] : '';
      const title = $( `a[href*="${platform_vehicle_id}"]` ).attr('aria-label') || undefined;

      const card = $(`a[href*="${platform_vehicle_id}"]`).closest('[data-testid^="listing-card"]');
      const priceTxt = card.find('[data-testid="price"]').first().text().replace(/[^0-9]/g,'');
      const price_chf = priceTxt ? Number(priceTxt) : null;

      const vehicle: Vehicle = {
        platform: 'autoscout24_ch',
        platform_vehicle_id,
        dealer_platform_id: dealerId,
        url: vUrl,
        title,
        price_chf,
        brand: undefined,
        model: undefined,
        year_month_reg: null,
        mileage_km: null,
        fuel: null,
        transmission: null,
        thumbnail: null,
        details_json: depth === 'summary' ? null : {}
      };
      items.push(vehicle);
    }

    // petit backoff pour éviter d'être trop agressif
    await new Promise(r => setTimeout(r, 350 + Math.floor(Math.random()*250)));
  }

  return items;
}
