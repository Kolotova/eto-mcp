import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

import { DEFAULT_SEARCH_TOURS_ARGS } from "./searchDefaults.js";
import type { SearchToursOutput, TourResult } from "./types.js";

type MockInput = {
  seed?: unknown;
  sort?: unknown;
  limit?: unknown;
  offset?: unknown;
  period?: unknown;
  country_id?: unknown;
  country_name?: unknown;
  destination?: unknown;
  city_name?: unknown;
  resort_name?: unknown;
  departure_id?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  nights_min?: unknown;
  nights_max?: unknown;
  adults?: unknown;
  children?: unknown;
  budget_max?: unknown;
  budget_min?: unknown;
  rating?: unknown;
  meal?: unknown;
};

type Rng = () => number;

type Destination = {
  id: number;
  name: string;
  slug: string;
  flag: string;
  resorts: string[];
  priceFactor: number;
};

const DESTINATIONS: Destination[] = [
  {
    id: 47,
    name: "Turkey",
    slug: "turkey",
    flag: "🇹🇷",
    resorts: ["Antalya", "Kemer", "Belek", "Alanya", "Side"],
    priceFactor: 1.0
  },
  {
    id: 54,
    name: "Egypt",
    slug: "egypt",
    flag: "🇪🇬",
    resorts: ["Hurghada", "Sharm El Sheikh", "Marsa Alam"],
    priceFactor: 0.92
  },
  {
    id: 29,
    name: "Thailand",
    slug: "thailand",
    flag: "🇹🇭",
    resorts: ["Phuket", "Krabi", "Khao Lak", "Pattaya", "Samui"],
    priceFactor: 1.08
  },
  {
    id: 63,
    name: "UAE",
    slug: "uae",
    flag: "🇦🇪",
    resorts: ["Dubai", "Abu Dhabi", "Ras Al Khaimah"],
    priceFactor: 1.25
  },
  {
    id: 90,
    name: "Maldives",
    slug: "maldives",
    flag: "🇲🇻",
    resorts: ["North Malé Atoll", "South Malé Atoll", "Ari Atoll", "Baa Atoll"],
    priceFactor: 1.35
  },
  {
    id: 91,
    name: "Seychelles",
    slug: "seychelles",
    flag: "🇸🇨",
    resorts: ["Mahé", "Praslin", "La Digue"],
    priceFactor: 1.32
  }
];

const DESTINATION_BY_ID = new Map<number, Destination>(DESTINATIONS.map((d) => [d.id, d]));
const COUNTRY_ALIASES: Record<string, string> = {
  turkey: "Turkey",
  turkiye: "Turkey",
  egypt: "Egypt",
  thailand: "Thailand",
  uae: "UAE",
  "united arab emirates": "UAE",
  emirates: "UAE",
  maldives: "Maldives",
  seychelles: "Seychelles"
};

const HOTEL_BRANDS = [
  "Asteria",
  "Blue Horizon",
  "Coral Elite",
  "Royal Palm",
  "Sunwave",
  "Marina Crown",
  "Vista Mare",
  "Grand Azure",
  "Luna Coast",
  "Sea Breeze",
  "Crystal Bay",
  "Imperial Sands"
];
const OPERATORS = ["TUI", "Coral", "Anex", "Pegas", "Tez Tour", "Biblio Globus", "Fun&Sun"];
const ROOMS = ["Standard", "Superior", "Deluxe", "Family Room", "Junior Suite", "Suite"];
const MEAL_CODES = ["RO", "BB", "HB", "FB", "AI"] as const;
const imagePoolCache = new Map<string, string[]>();

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  return value;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function makeSeedFromInput(input: MockInput): string {
  if (input.seed !== undefined && input.seed !== null && String(input.seed).trim() !== "") {
    return String(input.seed);
  }

  const seedPayload = {
    date_from: normalizeDate(input.date_from) ?? "",
    date_to: normalizeDate(input.date_to) ?? "",
    country_id: toFiniteNumber(input.country_id) ?? 0,
    country_name: normalizeText(input.country_name) ?? "",
    destination: normalizeText(input.destination) ?? "",
    period: normalizeText(input.period) ?? "",
    departure_id: toFiniteNumber(input.departure_id) ?? 0,
    adults: toFiniteNumber(input.adults) ?? 0,
    children: toFiniteNumber(input.children) ?? 0,
    nights_min: toFiniteNumber(input.nights_min) ?? 0,
    nights_max: toFiniteNumber(input.nights_max) ?? 0,
    budget_max: toFiniteNumber(input.budget_max) ?? 0,
    budget_min: toFiniteNumber(input.budget_min) ?? 0,
    rating: toFiniteNumber(input.rating) ?? 0,
    meal: typeof input.meal === "string" ? input.meal.toUpperCase() : toFiniteNumber(input.meal) ?? 0
  };

  return crypto.createHash("sha256").update(JSON.stringify(seedPayload)).digest("hex");
}

function makeRng(seed: string): Rng {
  const hash = crypto.createHash("sha256").update(seed).digest();
  let state = hash.readUInt32LE(0) || 1;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function randomInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[randomInt(rng, 0, values.length - 1)];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function roundPrice(value: number, step: 10 | 100): number {
  return Math.round(value / step) * step;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDateSafe(value: unknown, fallback: Date): Date {
  const normalized = normalizeDate(value);
  if (!normalized) {
    return fallback;
  }
  const d = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function resolveEffectiveNightsRange(input: MockInput): { min: number; max: number } {
  const rawMin = toFiniteNumber(input.nights_min);
  const rawMax = toFiniteNumber(input.nights_max);

  let min = clamp(rawMin ?? DEFAULT_SEARCH_TOURS_ARGS.nights_min, 1, 30);
  let max = clamp(rawMax ?? DEFAULT_SEARCH_TOURS_ARGS.nights_max, 1, 30);

  if (min > max) {
    const tmp = min;
    min = max;
    max = tmp;
  }

  return {
    min: Math.floor(min),
    max: Math.floor(max)
  };
}

function normalizeMealFilter(meal: unknown): string | undefined {
  if (meal === undefined || meal === null) {
    return undefined;
  }

  if (typeof meal === "string") {
    const normalized = meal.trim().toUpperCase();
    if (!normalized || normalized === "0") {
      return undefined;
    }
    if (MEAL_CODES.includes(normalized as (typeof MEAL_CODES)[number])) {
      return normalized;
    }
    return normalized;
  }

  const numeric = toFiniteNumber(meal);
  if (numeric === undefined || numeric <= 0) {
    return undefined;
  }

  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 5) {
    return MEAL_CODES[numeric - 1];
  }

  return undefined;
}

function normalizeSort(sort: unknown): "price_asc" | "price_desc" {
  if (sort === "price_desc") {
    return "price_desc";
  }
  return "price_asc";
}

function normalizePeriod(period: unknown): "next_month" | "1_2_months" | "summer" | "autumn" | undefined {
  const normalized = normalizeText(period);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "next_month" || normalized === "1_2_months" || normalized === "summer" || normalized === "autumn") {
    return normalized;
  }
  return undefined;
}

function normalizeLimit(limit: unknown): number {
  const numeric = toFiniteNumber(limit);
  if (!numeric || numeric <= 0) {
    return 10;
  }
  return Math.min(20, Math.floor(numeric));
}

function normalizeOffset(offset: unknown): number {
  const numeric = toFiniteNumber(offset);
  if (numeric === undefined || numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function maybeMissingRating(rng: Rng, rating: number): number | undefined {
  if (rng() < 0.06) {
    return undefined;
  }
  return rating;
}

function normalizeCountryToken(value: string): string {
  return value.trim().toLowerCase();
}

function hashToInt(input: string): number {
  return crypto.createHash("sha1").update(input).digest().readUInt32BE(0);
}

function getImagePool(slug: string): string[] {
  const cached = imagePoolCache.get(slug);
  if (cached) {
    return cached;
  }

  const dir = path.join(process.cwd(), "public", "assets", "hotels", slug);
  const pattern = new RegExp(`^${slug}_(\\d{2})\\.(jpg|jpeg|png)$`, "i");

  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((file) => pattern.test(file))
      .sort((a, b) => {
        const ma = a.match(pattern);
        const mb = b.match(pattern);
        const ia = ma ? Number(ma[1]) : Number.MAX_SAFE_INTEGER;
        const ib = mb ? Number(mb[1]) : Number.MAX_SAFE_INTEGER;
        if (ia !== ib) {
          return ia - ib;
        }
        return a.localeCompare(b);
      })
      .map((file) => `/assets/hotels/${slug}/${file}`);
  } catch {
    files = [];
  }

  imagePoolCache.set(slug, files);
  return files;
}

function assignImagesForPage(seed: string, slug: string, offset: number, page: TourResult[]): TourResult[] {
  const pool = getImagePool(slug);
  if (pool.length === 0) {
    return page.map((tour) => ({ ...tour, image_url: undefined }));
  }

  const pageSize = page.length;
  const poolSize = pool.length;
  const start = hashToInt(`${seed}|${slug}|${offset}`) % poolSize;
  const used = new Set<number>();

  return page.map((tour, indexInPage) => {
    const spin = hashToInt(`${seed}|${tour.hotel_id}|${offset}|${indexInPage}`) % poolSize;
    let idx = (start + indexInPage + spin) % poolSize;

    if (poolSize >= pageSize) {
      let tries = 0;
      while (used.has(idx) && tries < poolSize) {
        idx = (idx + 1) % poolSize;
        tries += 1;
      }
      used.add(idx);
    }

    return {
      ...tour,
      image_url: pool[idx]
    };
  });
}

function resolveDestinationByText(text?: string): Destination | undefined {
  if (!text) {
    return undefined;
  }

  const token = normalizeCountryToken(text);
  const alias = COUNTRY_ALIASES[token];
  const targetName = alias ?? text.trim();

  return DESTINATIONS.find((d) => d.name.toLowerCase() === targetName.toLowerCase());
}

function resolveDestination(input: MockInput): Destination {
  const countryId = toFiniteNumber(input.country_id);
  if (countryId !== undefined) {
    const byId = DESTINATION_BY_ID.get(Math.floor(countryId));
    if (byId) {
      return byId;
    }
  }

  const byCountryName = resolveDestinationByText(normalizeText(input.country_name));
  if (byCountryName) {
    return byCountryName;
  }

  const byDestination = resolveDestinationByText(normalizeText(input.destination));
  if (byDestination) {
    return byDestination;
  }

  return DESTINATION_BY_ID.get(47) ?? DESTINATIONS[0];
}

function resolvePeriodDates(period: ReturnType<typeof normalizePeriod>, dateFrom: Date, dateTo: Date): { fromDate: Date; toDate: Date } {
  if (!period) {
    return { fromDate: dateFrom, toDate: dateTo };
  }

  if (period === "summer") {
    return {
      fromDate: new Date("2026-06-01T00:00:00Z"),
      toDate: new Date("2026-08-31T00:00:00Z")
    };
  }

  if (period === "autumn") {
    return {
      fromDate: new Date("2026-09-01T00:00:00Z"),
      toDate: new Date("2026-11-30T00:00:00Z")
    };
  }

  const now = new Date();
  const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toDate = new Date(fromDate.getTime());
  const delta = period === "next_month" ? 30 : 60;
  toDate.setUTCDate(toDate.getUTCDate() + delta);

  return { fromDate, toDate };
}

function makeHotelName(rng: Rng, city: string): string {
  const brand = pick(rng, HOTEL_BRANDS);
  return rng() < 0.65 ? `${brand} Resort ${city}` : `${brand} ${city}`;
}

function buildTours(input: MockInput, seed: string): TourResult[] {
  const rng = makeRng(`${seed}:market`);
  const marketSize = randomInt(rng, 60, 100);
  const destination = resolveDestination(input);

  const now = new Date();
  const parsedFromDate = parseDateSafe(input.date_from, now);
  const parsedToDate = parseDateSafe(input.date_to, addDays(parsedFromDate, 30));
  const period = normalizePeriod(input.period);
  const resolvedPeriod = resolvePeriodDates(period, parsedFromDate, parsedToDate);
  const fromDate = resolvedPeriod.fromDate;
  const toDate = resolvedPeriod.toDate;
  const rangeDays = Math.max(0, Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000));

  const nightsRange = resolveEffectiveNightsRange(input);

  const adults = clamp(toFiniteNumber(input.adults) ?? 2, 1, 6);
  const children = clamp(toFiniteNumber(input.children) ?? 0, 0, 4);
  const occupancyFactor = 1 + adults * 0.18 + children * 0.09;
  const departureFactor = 0.9 + ((toFiniteNumber(input.departure_id) ?? 0) % 5) * 0.04;

  const tours: TourResult[] = [];

  for (let i = 0; i < marketSize; i += 1) {
    const starRoll = rng();
    const stars = starRoll < 0.3 ? 3 : starRoll < 0.72 ? 4 : 5;

    let nights = randomInt(rng, nightsRange.min, nightsRange.max);
    if (i === 4) {
      nights = clamp(8, nightsRange.min, nightsRange.max);
    }

    const startOffset = rangeDays > 0 ? randomInt(rng, 0, rangeDays) : randomInt(rng, 0, 21);
    const dateFrom = toIsoDate(addDays(fromDate, startOffset));

    const mealRoll = rng();
    const meal =
      i < MEAL_CODES.length ? MEAL_CODES[i] :
      mealRoll < 0.14 ? "RO" :
      mealRoll < 0.34 ? "BB" :
      mealRoll < 0.62 ? "HB" :
      mealRoll < 0.82 ? "FB" : "AI";

    const operator = pick(rng, OPERATORS);
    const room = pick(rng, ROOMS);
    const cityName = pick(rng, destination.resorts);

    const baseRating =
      stars === 5 ? 4.25 + rng() * 0.75 :
      stars === 4 ? 3.75 + rng() * 0.9 :
      3.0 + rng() * 1.15;
    const rating = Math.round(clamp(baseRating, 3.0, 5.0) * 10) / 10;

    const mealFactor = meal === "AI" ? 1.2 : meal === "FB" ? 1.12 : meal === "HB" ? 1.07 : meal === "BB" ? 1.03 : 0.98;
    const starFactor = stars === 5 ? 1.5 : stars === 4 ? 1.2 : 0.95;
    const operatorFactor = operator === "TUI" || operator === "Tez Tour" ? 1.06 : 0.97 + rng() * 0.1;
    const noise = 0.9 + rng() * 0.22;

    const grossPrice =
      42_000 *
      starFactor *
      mealFactor *
      (0.84 + nights * 0.075) *
      occupancyFactor *
      destination.priceFactor *
      departureFactor *
      operatorFactor *
      noise;

    const priceStep: 10 | 100 = rng() < 0.2 ? 10 : 100;
    const price = roundPrice(grossPrice, priceStep);

    const hotelId = 1000 + i;
    tours.push({
      price,
      currency: "RUB",
      date_from: dateFrom,
      nights,
      operator,
      hotel_id: hotelId,
      hotel_name: makeHotelName(rng, cityName),
      stars,
      rating: maybeMissingRating(rng, rating),
      meal,
      room,
      country_name: destination.name,
      city_name: cityName,
      flag_emoji: destination.flag,
      image_url: undefined,
      raw: {
        provider: "mock",
        seed
      }
    });
  }

  return tours;
}

export async function mockSearchTours(input: MockInput): Promise<SearchToursOutput> {
  const startedAt = Date.now();

  const seed = makeSeedFromInput(input);
  const rng = makeRng(`${seed}:latency`);
  const latencyMs = randomInt(rng, 250, 900);

  const generated = buildTours(input, seed);

  const nightsRange = resolveEffectiveNightsRange(input);
  const budgetMax = toFiniteNumber(input.budget_max) ?? 0;
  const budgetMin = toFiniteNumber(input.budget_min) ?? 0;
  const ratingMin = toFiniteNumber(input.rating);
  const mealFilter = normalizeMealFilter(input.meal);
  const sort = normalizeSort(input.sort);
  const limit = normalizeLimit(input.limit);
  const offset = normalizeOffset(input.offset);
  const destination = resolveDestination(input);

  let filtered = generated.filter((tour) => {
    if (tour.nights < nightsRange.min) {
      return false;
    }
    if (tour.nights > nightsRange.max) {
      return false;
    }
    if (budgetMin > 0 && tour.price < budgetMin) {
      return false;
    }
    if (budgetMax > 0 && tour.price > budgetMax) {
      return false;
    }

    if (ratingMin !== undefined && ratingMin > 0) {
      const value = toFiniteNumber(tour.rating);
      if (value === undefined || Number.isNaN(value) || value < ratingMin) {
        return false;
      }
    }

    if (mealFilter !== undefined && mealFilter !== "") {
      if ((tour.meal ?? "").toUpperCase() !== mealFilter) {
        return false;
      }
    }

    return true;
  });

  if (sort === "price_desc") {
    filtered.sort((a, b) => b.price - a.price);
  } else {
    filtered.sort((a, b) => a.price - b.price);
  }

  const page = filtered.slice(offset, offset + limit);
  const withImages = assignImagesForPage(seed, destination.slug, offset, page);

  const results = withImages.map((tour) => ({
    ...tour,
    raw: {
      provider: "mock",
      seed,
      debug: process.env.MOCK_DEBUG === "1" ? { sort, limit, offset } : undefined
    }
  }));

  await sleep(latencyMs);

  return {
    requestid: `mock-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12)}`,
    results,
    meta: {
      timed_out: false,
      polls: 1,
      ms: Date.now() - startedAt
    }
  };
}
