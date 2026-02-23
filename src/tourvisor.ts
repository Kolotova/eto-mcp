import { fetch } from "undici";

import type { SearchToursInput } from "./schemas.js";
import type { TourResult } from "./types.js";

const CREATE_SEARCH_URL = "https://tourvisor.ru/xml/modsearch.php";
const FETCH_RESULT_URL = "https://search3.tourvisor.ru/modresult.php";

function buildCreateSearchQuery(params: SearchToursInput): URLSearchParams {
  return new URLSearchParams({
    country: String(params.country_id),
    departure: String(params.departure_id),
    datefrom: params.date_from,
    dateto: params.date_to,
    nightsfrom: String(params.nights_min),
    nightsto: String(params.nights_max),
    adults: String(params.adults),
    child: String(params.children),
    pricefrom: "0",
    priceto: String(params.budget_max ?? 0),
    meal: String(params.meal ?? 0),
    rating: String(params.rating ?? 0)
  });
}

function pickFirst<T = unknown>(input: unknown, keys: string[]): T | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  for (const key of keys) {
    if (key in input) {
      return (input as Record<string, T>)[key];
    }
  }

  return undefined;
}

function parseRequestId(payload: unknown): string | undefined {
  const direct = pickFirst<string>(payload, ["requestid", "requestId", "request_id"]);
  if (direct) {
    return String(direct);
  }

  const nestedData = pickFirst<unknown>(payload, ["data", "result", "response"]);
  const nested = pickFirst<string>(nestedData, ["requestid", "requestId", "request_id"]);
  if (nested) {
    return String(nested);
  }

  return undefined;
}

function parsePossiblyJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRequestIdFromXml(text: string): string | undefined {
  const match = text.match(/<requestid>([^<]+)<\/requestid>/i);
  return match?.[1];
}

export async function createSearch(params: SearchToursInput): Promise<string> {
  const url = `${CREATE_SEARCH_URL}?${buildCreateSearchQuery(params).toString()}`;
  const response = await fetch(url, { method: "GET" });

  if (!response.ok) {
    throw new Error(`createSearch failed with status ${response.status}`);
  }

  const text = await response.text();
  const json = parsePossiblyJson(text);
  const requestid = parseRequestId(json) ?? parseRequestIdFromXml(text);

  if (!requestid) {
    throw new Error("createSearch did not return requestid");
  }

  return requestid;
}

export async function fetchResult(requestid: string): Promise<unknown> {
  const query = new URLSearchParams({ requestid });
  const response = await fetch(`${FETCH_RESULT_URL}?${query.toString()}`, { method: "GET" });

  if (!response.ok) {
    throw new Error(`fetchResult failed with status ${response.status}`);
  }

  const text = await response.text();
  const json = parsePossiblyJson(text);

  if (json !== null) {
    return json;
  }

  return { raw: text };
}

function extractTours(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidates = [
    pickFirst<unknown[]>(payload, ["results", "tours", "hotels", "items"]),
    pickFirst<unknown>(payload, ["data", "result", "response"])
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (candidate && typeof candidate === "object") {
      const nested = pickFirst<unknown[]>(candidate, ["results", "tours", "hotels", "items"]);
      if (Array.isArray(nested)) {
        return nested;
      }
    }
  }

  return [];
}

function isDone(payload: unknown): boolean {
  const value = pickFirst<unknown>(payload, ["finished", "done", "isFinished", "status"]);
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return normalized === "done" || normalized === "finished" || normalized === "ok";
  }

  return false;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }

  return fallback;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return fallback;
}

export function normalize(raw: unknown): TourResult[] {
  const tours = extractTours(raw);

  return tours
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      price: asNumber(pickFirst(item, ["price", "cost", "amount"])),
      currency: asString(pickFirst(item, ["currency", "curr", "valuta"]), "RUB"),
      date_from: asString(pickFirst(item, ["date_from", "date", "checkin"])),
      nights: asNumber(pickFirst(item, ["nights", "night", "duration"])),
      operator: asString(pickFirst(item, ["operator", "tour_operator", "operator_name"])),
      hotel_id: asNumber(pickFirst(item, ["hotel_id", "hotelid", "hid"])),
      hotel_name: asString(pickFirst(item, ["hotel_name", "hotel", "name"])) || undefined,
      stars: asNumber(pickFirst(item, ["stars", "star"]), NaN) || undefined,
      rating: (pickFirst(item, ["rating", "rate"]) as number | string | undefined) ?? undefined,
      meal: asString(pickFirst(item, ["meal", "meal_name"])) || undefined,
      room: asString(pickFirst(item, ["room", "room_name"])) || undefined,
      raw: item
    }))
    .filter((item) => item.price > 0 && item.hotel_id > 0);
}

export async function pollResults(
  requestid: string,
  options?: { intervalMs?: number; timeoutMs?: number }
): Promise<{ timedOut: boolean; polls: number; raw: unknown }> {
  const intervalMs = options?.intervalMs ?? 1500;
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const startedAt = Date.now();

  let polls = 0;
  let lastPayload: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    polls += 1;
    lastPayload = await fetchResult(requestid);

    if (isDone(lastPayload)) {
      return { timedOut: false, polls, raw: lastPayload };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { timedOut: true, polls, raw: lastPayload };
}
