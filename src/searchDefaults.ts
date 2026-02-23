import type { SearchToursInput } from "./schemas.js";

export const DEFAULT_SEARCH_TOURS_ARGS: SearchToursInput = {
  departure_id: 1,
  date_from: "2026-06-01",
  date_to: "2026-06-20",
  nights_min: 6,
  nights_max: 10,
  adults: 2,
  children: 0,
  budget_max: 0,
  meal: 0,
  rating: 0,
  limit: 5,
  offset: 0,
  sort: "price_asc"
};
