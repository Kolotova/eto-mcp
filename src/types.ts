export interface TourResult {
  price: number;
  currency: string;
  date_from: string;
  nights: number;
  operator: string;
  hotel_id: number;
  hotel_name?: string;
  stars?: number;
  rating?: number | string;
  meal?: string;
  room?: string;
  country_name?: string;
  city_name?: string;
  flag_emoji?: string;
  image_url?: string;
  raw?: unknown;
}

export interface SearchToursOutput {
  [key: string]: unknown;
  requestid: string;
  results: TourResult[];
  meta: {
    timed_out: boolean;
    polls: number;
    ms: number;
  };
}
