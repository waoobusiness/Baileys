export type Dealer = {
  platform: 'autoscout24_ch';
  platform_id: string;          // "seller-24860"
  name?: string;
  profile_url: string;
  address?: string;
  rating?: number | null;
  reviews_count?: number | null;
  logo_url?: string | null;
};

export type Vehicle = {
  platform: 'autoscout24_ch';
  platform_vehicle_id: string;  // "12877180"
  dealer_platform_id: string;   // "seller-24860"
  url: string;
  title?: string;
  brand?: string;
  model?: string;
  price_chf?: number | null;
  year_month_reg?: string | null;
  mileage_km?: number | null;
  fuel?: string | null;
  transmission?: string | null;
  body_type?: string | null;
  drivetrain?: string | null;
  power_ps?: number | null;
  power_kw?: number | null;
  engine_displacement_cm3?: number | null;
  gears?: number | null;
  doors?: number | null;
  seats?: number | null;
  co2_g_km?: number | null;
  efficiency_label?: string | null;
  colors?: { exterior?: string|null; interior?: string|null } | null;
  warranty?: string | null;
  import_parallel?: boolean | null;
  accident?: boolean | null;
  ct_expertisee?: boolean | null;
  thumbnail?: string | null;
  status?: 'listed'|'sold'|'unlisted';
  details_json?: any;
};

export type VehicleImage = {
  platform: 'autoscout24_ch';
  platform_vehicle_id: string;
  url: string;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  idx?: number | null;
};
