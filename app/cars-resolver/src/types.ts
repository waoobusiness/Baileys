export type Dealer = {
  platform: 'autoscout24_ch';
  platform_id: string;          // e.g. "seller-24860"
  name?: string;
  profile_url: string;
  address?: string;
  rating?: number | null;
  reviews_count?: number | null;
  logo_url?: string | null;
};

export type Vehicle = {
  platform: 'autoscout24_ch';
  platform_vehicle_id: string;  // e.g. "12877180"
  dealer_platform_id: string;   // "seller-24860"
  url: string;
  title?: string;
  brand?: string;
  model?: string;
  price_chf?: number | null;
  year_month_reg?: string | null;  // "2023-10"
  mileage_km?: number | null;
  fuel?: string | null;
  transmission?: string | null;
  thumbnail?: string | null;
  details_json?: any;
};
