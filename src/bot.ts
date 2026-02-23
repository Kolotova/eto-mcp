import "dotenv/config";

import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

import { fetch } from "undici";

import { escapeHtml } from "./formatters/telegram.js";
import {
  clearFavorites as clearFavoritesStore,
  createEmptyFavorites,
  deleteCollection as deleteFavoriteCollectionStore,
  openCollection as openFavoriteCollectionStore,
  saveCollection as saveFavoriteCollectionStore,
  saveTour as saveFavoriteTourStore,
  type FavoriteTour,
  type FavoritesStore,
  type SavedSet
} from "./favorites.js";
import { getLLMProvider } from "./llm/index.js";
import { parseUserInput } from "./nlu/intentParser.js";
import { parseQuery } from "./nlu/parseQuery.js";
import { handleUserMessage, normalizeCountryName } from "./orchestrator.js";
import { searchToursInputSchema, type SearchToursInput } from "./schemas.js";
import { DEFAULT_SEARCH_TOURS_ARGS } from "./searchDefaults.js";

type MealCode = "AI" | "BB" | "HB" | "FB" | "RO" | "ANY";
type PeriodCode = "next_month" | "1_2_months" | "summer" | "autumn";

type Tour = {
  hotel_id: number;
  hotel_name?: string;
  country_name?: string;
  city_name?: string;
  flag_emoji?: string;
  date_from?: string;
  nights?: number;
  meal?: string;
  rating?: number | string;
  room?: string;
  operator?: string;
  price?: number;
  currency?: string;
  image_url?: string;
};

type SearchOutput = {
  requestid: string;
  results: Tour[];
  meta?: { ms?: number; total?: number };
  total?: number;
};

type ChatStep = "idle" | "budget_input" | "await_phone" | "ai_country_input" | "ai_nights_input" | "ai_budget_input";

type SearchContext = {
  countryId?: number;
  countryName?: string;
  dateFrom?: string;
  dateTo?: string;
  period?: PeriodCode;
  nightsMin?: number;
  nightsMax?: number;
  budgetMax?: number;
  budgetMin?: number;
  budgetTarget?: number;
  meal?: MealCode;
  ratingMin?: number;
  adults?: number;
  children?: number;
  lastArgs?: SearchToursInput;
  lastResults?: Tour[];
  lastRequestId?: string;
};

type ChatState = {
  step: ChatStep;
  countryId?: number;
  nightsMin: number;
  nightsMax: number;
  budgetChosen: boolean;
  budgetMax?: number;
  budgetMin?: number;
  ratingChosen: boolean;
  ratingMin?: number;
  period?: PeriodCode;
  meal?: MealCode;
  mealChosen: boolean;
  editingFilter?: "budget" | "rating" | "period" | "meal";
  offset: number;
  limit: number;
  lastRequestId?: string;
  lastResults: Tour[];
  pendingHotel?: Tour;
  phonePromptShownForHotelId?: number;
  aiMode?: boolean;
  aiDraft?: Partial<SearchToursInput>;
  aiAwaiting?: null | "country" | "nights" | "budget" | "nights_budget";
  lastSearchArgs?: SearchToursInput;
  activeSearchSeq?: number;
  searchContext?: SearchContext;
  pendingBudgetClarification?: {
    value: number;
    mode: "ai" | "followup";
  };
  pendingPromptAction?: "show_favorites";
  favorites: FavoritesStore;
  favoritesSeq: number;
};

const BOT_TOKEN = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
const BOT_TEST_MODE = process.env.BOT_TEST_MODE === "1";
const BOT_ENABLED = Boolean(BOT_TOKEN) || BOT_TEST_MODE;
const API_KEY = process.env.API_KEY ?? "devkey";
const MCP_BASE_URL = process.env.MCP_BASE_URL ?? "http://127.0.0.1:3000";
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const telegrafModule = await import("telegraf").catch(() => null);
if (!telegrafModule) {
  throw new Error("telegraf package is not installed. Run: npm install telegraf");
}

const { Telegraf, Markup } = telegrafModule as any;
const bot = new Telegraf(BOT_TOKEN ?? "TEST_BOT_TOKEN");
const botModuleState = globalThis as typeof globalThis & {
  __etoBotHandlersRegistered?: boolean;
};

const COUNTRY_TO_ID: Record<string, number> = {
  Turkey: 47,
  Egypt: 54,
  Thailand: 29,
  UAE: 63,
  Maldives: 90,
  Seychelles: 91
};
const COUNTRY_LABEL_BY_ID: Record<number, string> = {
  47: "Турция",
  54: "Египет",
  29: "Таиланд",
  63: "ОАЭ",
  90: "Мальдивы",
  91: "Сейшелы"
};

const stateByChat = new Map<number, ChatState>();
const pendingWantByKey = new Map<string, number>();
let testCallSearchToursOverride:
  | ((args: Record<string, unknown>) => Promise<SearchOutput>)
  | undefined;

function getChatId(ctx: any): number {
  return Number(ctx.chat?.id ?? 0);
}

function unsupportedCountryText(): string {
  return "Пока могу искать только по: Турция, Египет, Таиланд, ОАЭ, Мальдивы, Сейшелы. Какую выбираете?";
}

function nextFavoriteCollectionId(state: ChatState): string {
  state.favoritesSeq = (state.favoritesSeq ?? 0) + 1;
  return String(state.favoritesSeq);
}

function saveCurrentCollectionToFavorites(state: ChatState): SavedSet | undefined {
  if (!state.lastResults || state.lastResults.length === 0) return undefined;
  const country = state.countryId ? (COUNTRY_LABEL_BY_ID[state.countryId] ?? "—") : "—";
  const nights = Number.isFinite(state.nightsMin) ? state.nightsMin : DEFAULT_SEARCH_TOURS_ARGS.nights_min;
  const paramsSnapshot: SavedSet["paramsSnapshot"] = {
    country,
    nights,
    ...(typeof state.budgetMin === "number" ? { budgetMin: state.budgetMin } : {}),
    ...(typeof state.budgetMax === "number" ? { budgetMax: state.budgetMax } : {}),
    ...(state.meal && state.meal !== "ANY" ? { meal: state.meal } : {})
  };
  const saved = saveFavoriteCollectionStore(state.favorites, {
    id: nextFavoriteCollectionId(state),
    paramsSnapshot,
    tours: state.lastResults,
    maxTours: 10
  });
  state.favorites = saved.favorites;
  return saved.collection;
}

function saveTourToFavorites(state: ChatState, tour: Tour): boolean {
  const saved = saveFavoriteTourStore(state.favorites, tour);
  state.favorites = saved.favorites;
  return saved.added;
}

function removeTourFromFavorites(state: ChatState, hotelId: number): boolean {
  const before = state.favorites.tours.length;
  state.favorites = {
    ...state.favorites,
    tours: state.favorites.tours.filter((t) => Number(t.hotel_id) !== Number(hotelId))
  };
  return state.favorites.tours.length !== before;
}

function formatSavedCollectionLine(index: number, set: SavedSet): string {
  const parts: string[] = [`№${index + 1}: ${set.paramsSnapshot.country}`];
  if (Number.isFinite(set.paramsSnapshot.nights)) parts.push(`${set.paramsSnapshot.nights} ночей`);
  if (typeof set.paramsSnapshot.budgetMin === "number" && typeof set.paramsSnapshot.budgetMax === "number") {
    parts.push(`${Math.round(set.paramsSnapshot.budgetMin / 1000)}–${Math.round(set.paramsSnapshot.budgetMax / 1000)}k`);
  } else if (typeof set.paramsSnapshot.budgetMax === "number") {
    parts.push(`до ${Math.round(set.paramsSnapshot.budgetMax / 1000)}k`);
  }
  if (set.paramsSnapshot.meal) parts.push(mealLabel(set.paramsSnapshot.meal));
  const dateLabel = set.createdAt.toDateString() === new Date().toDateString() ? "сегодня" : set.createdAt.toLocaleDateString("ru-RU");
  parts.push(`создано ${dateLabel}`);
  return `• ${parts.join(" · ")}`;
}

function favoriteCollectionsKeyboard(state: ChatState) {
  const rows = state.favorites.collections.map((set, idx) => ([
    Markup.button.callback(`Открыть ${idx + 1}`, `fav:open:${set.id}`),
    Markup.button.callback(`Удалить ${idx + 1}`, `fav:del:${set.id}`)
  ]));
  return rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
}

function collectFavoriteTours(state: ChatState): FavoriteTour[] {
  const seen = new Set<number>();
  const result: FavoriteTour[] = [];
  for (const tour of state.favorites.tours) {
    const id = Number(tour.hotel_id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(tour);
  }
  for (const set of state.favorites.collections) {
    for (const tour of set.tours) {
      const id = Number(tour.hotel_id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      result.push(tour);
    }
  }
  return result;
}

function findTourForWantAction(state: ChatState, hotelId: number, sourceHint?: string): Tour | undefined {
  const fromLast = state.lastResults.find((t) => Number(t.hotel_id) === hotelId);
  if (fromLast) return fromLast;

  if (sourceHint === "fav" || sourceHint === "favorites") {
    return collectFavoriteTours(state).find((t) => Number(t.hotel_id) === hotelId) as Tour | undefined;
  }

  return collectFavoriteTours(state).find((t) => Number(t.hotel_id) === hotelId) as Tour | undefined;
}

async function sendFavoriteCards(ctx: any, state: ChatState, tours: Tour[]): Promise<void> {
  const requestId = "favorites-list";
  state.step = "idle";
  state.aiAwaiting = null;
  state.aiDraft = {};
  state.lastRequestId = requestId;
  state.lastResults = tours;

  for (const tour of tours) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("💚 Хочу этот тур", `want:${requestId}:${tour.hotel_id}:fav`)],
      [Markup.button.callback("❌ Удалить из избранного", `fav:remove:${tour.hotel_id}`)]
    ]);
    const caption = safeCaption(tour);
    const absPath = resolveLocalPhotoPath(tour.image_url);

    if (absPath && existsSync(absPath)) {
      try {
        await ctx.replyWithPhoto(
          { source: createReadStream(absPath) },
          { caption, parse_mode: "HTML", reply_markup: keyboard.reply_markup }
        );
        continue;
      } catch {
        // fallback to text below
      }
    }

    await ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard.reply_markup });
  }
}

async function showFavorites(ctx: any, state: ChatState): Promise<void> {
  const tours = collectFavoriteTours(state);
  if (tours.length === 0) {
    await ctx.reply("Пока пусто. Откройте поиск и добавляйте туры в ⭐.");
    return;
  }

  const prevLastRequestId = state.lastRequestId;
  const prevLastResults = state.lastResults;
  const prevLastSearchArgs = state.lastSearchArgs;
  const prevSearchContext = state.searchContext;

  await ctx.reply(`⭐ Ваше избранное (${tours.length} ${tourWord(tours.length)})`);
  await ctx.reply("⭐ Вот сохранённые туры. Хотите отфильтровать или продолжить поиск?");
  await sendFavoriteCards(ctx, state, tours.slice(0, 20) as Tour[]);
  await ctx.reply(
    "Действия:",
    Markup.inlineKeyboard([
      [Markup.button.callback("🧹 Очистить избранное", "fav:clear")],
      [Markup.button.callback("⚙️ Изменить фильтры", "filters"), Markup.button.callback("🔎 Новый поиск", "new")]
    ])
  );

  state.lastRequestId = prevLastRequestId;
  state.lastResults = prevLastResults;
  state.lastSearchArgs = prevLastSearchArgs;
  state.searchContext = prevSearchContext;
}

function getState(chatId: number): ChatState {
  const existing = stateByChat.get(chatId);
  if (existing) {
    return existing;
  }

  const initial: ChatState = {
    step: "idle",
    nightsMin: DEFAULT_SEARCH_TOURS_ARGS.nights_min,
    nightsMax: DEFAULT_SEARCH_TOURS_ARGS.nights_max,
    budgetChosen: false,
    ratingChosen: false,
    mealChosen: false,
    offset: 0,
    limit: DEFAULT_SEARCH_TOURS_ARGS.limit,
    meal: "ANY",
    lastResults: [],
    favorites: createEmptyFavorites(),
    favoritesSeq: 0
  };
  stateByChat.set(chatId, initial);
  return initial;
}

function resetSearchState(state: ChatState): void {
  state.nightsMin = DEFAULT_SEARCH_TOURS_ARGS.nights_min;
  state.nightsMax = DEFAULT_SEARCH_TOURS_ARGS.nights_max;
  state.budgetChosen = false;
  state.budgetMax = undefined;
  state.budgetMin = undefined;
  state.ratingChosen = false;
  state.ratingMin = undefined;
  state.period = undefined;
  state.meal = "ANY";
  state.mealChosen = false;
  state.editingFilter = undefined;
  state.offset = DEFAULT_SEARCH_TOURS_ARGS.offset;
  state.limit = DEFAULT_SEARCH_TOURS_ARGS.limit;
  state.lastRequestId = undefined;
  state.lastResults = [];
  state.pendingHotel = undefined;
  state.phonePromptShownForHotelId = undefined;
  state.aiMode = false;
  state.aiDraft = undefined;
  state.aiAwaiting = null;
  state.lastSearchArgs = undefined;
  state.activeSearchSeq = undefined;
  state.searchContext = undefined;
  state.pendingBudgetClarification = undefined;
  state.pendingPromptAction = undefined;
  // favorites persist across new search/reset by design
}

function mealLabel(value: unknown): string {
  const code = String(value ?? "").toUpperCase();
  if (code === "AI") return "Всё включено";
  if (code === "BB") return "Завтраки";
  if (code === "HB") return "Завтрак + ужин";
  if (code === "FB") return "3-разовое питание";
  if (code === "RO") return "Без питания";
  return "Не важно";
}

function currencySymbol(code: unknown): string {
  const c = String(code ?? "RUB").toUpperCase();
  if (c === "RUB") return "₽";
  if (c === "EUR") return "€";
  if (c === "USD") return "$";
  return c;
}

function formatDate(iso: unknown): string {
  const value = String(iso ?? "").trim();
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value || "—";
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function formatPrice(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("ru-RU");
}

function truncateText(value: string, max = 70): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(1, max - 1)).trim()}…`;
}

function compactCaption(t: Tour): string {
  const hotel = escapeHtml(truncateText(String(t.hotel_name ?? "Отель"), 70));
  const flag = String(t.flag_emoji ?? "");
  const country = escapeHtml(String(t.country_name ?? "—"));
  const city = escapeHtml(String(t.city_name ?? "—"));
  const date = formatDate(t.date_from);
  const nights = Number.isFinite(Number(t.nights)) ? `${Math.max(0, Math.floor(Number(t.nights)))} ночей` : "—";
  const meal = escapeHtml(mealLabel(t.meal));
  const room = escapeHtml(String(t.room ?? "Стандарт"));
  const price = formatPrice(t.price);
  const currency = currencySymbol(t.currency);
  const operator = escapeHtml(String(t.operator ?? "Туроператор"));
  const ratingNum = Number(t.rating);
  const ratingLine =
    Number.isFinite(ratingNum) && ratingNum > 0 ? `⭐️ ${ratingNum.toFixed(1)}` : undefined;

  return [
    `<b>${hotel}</b>`,
    `📍 ${flag} ${country}, ${city}`,
    ...(ratingLine ? [ratingLine] : []),
    `📅 ${date} • ${nights}`,
    `🍽 ${meal} • 🛏 ${room}`,
    `💸 <b>${price} ${currency}</b>`,
    `🧳 ${operator}`
  ].join("\n");
}

function safeCaption(tour: Tour): string {
  const caption = compactCaption(tour);
  if (caption.length <= 900) {
    return caption;
  }

  const shortened = {
    ...tour,
    hotel_name: truncateText(String(tour.hotel_name ?? "Отель"), 52),
    room: truncateText(String(tour.room ?? "Стандарт"), 40),
    operator: truncateText(String(tour.operator ?? "Туроператор"), 32)
  };
  const compact = compactCaption(shortened);
  return compact.length <= 900 ? compact : compact.slice(0, 899).trimEnd();
}

function recapText(t: Tour): string {
  const hotel = escapeHtml(String(t.hotel_name ?? "Отель"));
  const flag = String(t.flag_emoji ?? "");
  const country = escapeHtml(String(t.country_name ?? "—"));
  const city = escapeHtml(String(t.city_name ?? "—"));
  const date = formatDate(t.date_from);
  const nights = Number.isFinite(Number(t.nights)) ? `${Math.max(0, Math.floor(Number(t.nights)))} ночей` : "—";
  const meal = escapeHtml(mealLabel(t.meal));
  const price = formatPrice(t.price);
  const currency = currencySymbol(t.currency);

  return [
    "<b>Вы выбрали:</b>",
    `${hotel}`,
    `${flag} ${country}, ${city}`,
    `${date} • ${nights}`,
    `${meal}`,
    `<b>${price} ${currency}</b>`
  ].join("\n");
}

function resolveLocalPhotoPath(imageUrl?: string): string | undefined {
  if (!imageUrl) {
    return undefined;
  }

  if (!imageUrl.startsWith("/assets/") && !imageUrl.startsWith("assets/")) {
    return undefined;
  }

  const publicRoot = path.resolve(process.cwd(), "public");
  const relative = imageUrl.replace(/^\/+/, "");
  const absPath = path.resolve(publicRoot, relative);
  if (absPath !== publicRoot && !absPath.startsWith(`${publicRoot}${path.sep}`)) {
    return undefined;
  }

  return absPath;
}

function parseBudgetInput(text: string): number | undefined | "NONE" {
  const normalized = text.toLowerCase().trim();
  if (normalized.includes("без") && normalized.includes("лим")) {
    return "NONE";
  }
  if (/^-/.test(normalized)) {
    return undefined;
  }

  const cleaned = normalized.replace(/\s+/g, "");
  if (/^\d+$/.test(cleaned)) {
    const value = Number(cleaned);
    if (Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }

  return undefined;
}

function parseBudgetAnswer(text: string): { kind: "none" } | { kind: "max"; value: number } | { kind: "target"; value: number } | undefined {
  const normalized = text.toLowerCase().replace(/\u00a0/g, " ").trim();
  if (normalized.includes("без") && normalized.includes("лим")) {
    return { kind: "none" };
  }
  if (/^-/.test(normalized)) {
    return undefined;
  }
  const budget = parseQuery(text).params.budget;
  if (!budget) {
    return undefined;
  }
  if (budget.type === "range") {
    return { kind: "max", value: budget.max };
  }
  if (budget.type === "approx") {
    return { kind: "target", value: budget.value };
  }
  return { kind: "max", value: budget.max };
}

function isCancelText(text: string): boolean {
  return /(отмена|\/cancel|cancel|стоп|stop|сброс|reset|начать заново|хватит)/i.test(text);
}

function normalizePhone(text: string): { ok: true; phone: string } | { ok: false; reason: string } {
  const invalidMessage =
    "Похоже, номер введён неверно. Введите в формате +7XXXXXXXXXX (10 цифр после +7). Пример: +79991234567";
  const raw = String(text ?? "").trim();
  if (!raw) {
    return { ok: false, reason: invalidMessage };
  }

  const cleaned = raw.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  if (!cleaned || cleaned === "+") {
    return { ok: false, reason: invalidMessage };
  }

  if (/^\+7\d{10}$/.test(cleaned)) {
    return { ok: true, phone: cleaned };
  }

  if (/^8\d{10}$/.test(cleaned) || /^7\d{10}$/.test(cleaned)) {
    return { ok: true, phone: `+7${cleaned.slice(1)}` };
  }

  return { ok: false, reason: invalidMessage };
}

function applyParsedIntent(state: ChatState, parsed: ReturnType<typeof parseUserInput>): void {
  if (parsed.country_name && COUNTRY_TO_ID[parsed.country_name]) {
    state.countryId = COUNTRY_TO_ID[parsed.country_name];
  }

  if (parsed.budget_max !== undefined) {
    state.budgetChosen = true;
    state.budgetMax = parsed.budget_max;
  }

  if (parsed.period && ["next_month", "1_2_months", "summer", "autumn"].includes(parsed.period)) {
    state.period = parsed.period as PeriodCode;
  }

  if (parsed.meal && ["AI", "BB", "ANY"].includes(parsed.meal.toUpperCase())) {
    state.mealChosen = true;
    state.meal = parsed.meal.toUpperCase() as MealCode;
  }
}

function hasLocalIntent(parsed: ReturnType<typeof parseUserInput>): boolean {
  return parsed.country_name !== undefined ||
    parsed.budget_max !== undefined ||
    parsed.period !== undefined ||
    parsed.meal !== undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return n;
}

function applyOrchestratedSearchArgsToState(state: ChatState, args: SearchToursInput): void {
  resetSearchState(state);

  state.nightsMin = args.nights_min ?? DEFAULT_SEARCH_TOURS_ARGS.nights_min;
  state.nightsMax = args.nights_max ?? DEFAULT_SEARCH_TOURS_ARGS.nights_max;

  if (args.country_id !== undefined) {
    state.countryId = args.country_id;
  }

  if (args.budget_max !== undefined && args.budget_max > 0) {
    state.budgetChosen = true;
    state.budgetMax = args.budget_max;
  }
  if (args.budget_min !== undefined && args.budget_min > 0) {
    state.budgetMin = args.budget_min;
  }

  const rating = asPositiveNumber(args.rating);
  if (rating !== undefined) {
    state.ratingChosen = true;
    state.ratingMin = rating;
  }

  if (args.period) {
    state.period = args.period;
  }

  if (typeof args.meal === "string") {
    const meal = args.meal.toUpperCase();
    if (meal === "AI" || meal === "BB" || meal === "ANY") {
      state.mealChosen = true;
      state.meal = meal;
    }
  }

  state.limit = args.limit ?? DEFAULT_SEARCH_TOURS_ARGS.limit;
  state.offset = args.offset ?? DEFAULT_SEARCH_TOURS_ARGS.offset;
  syncSearchContextFromState(state, args);
}

function applySearchContext(
  prev: SearchContext | undefined,
  patch: Partial<SearchContext>,
  mode: "replace" | "merge" = "merge"
): SearchContext {
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined && value !== null)
  ) as Partial<SearchContext>;
  return mode === "replace" ? { ...definedPatch } : { ...(prev ?? {}), ...definedPatch };
}

function syncSearchContextFromState(state: ChatState, args?: SearchToursInput): void {
  const baseArgs = args ?? state.lastSearchArgs;
  const countryId = baseArgs?.country_id ?? state.countryId;
  const countryName = countryId ? COUNTRY_LABEL_BY_ID[countryId] : undefined;
  state.searchContext = applySearchContext(state.searchContext, {
    countryId,
    countryName,
    dateFrom: baseArgs?.date_from,
    dateTo: baseArgs?.date_to,
    period: (baseArgs?.period as PeriodCode | undefined) ?? state.period,
    nightsMin: baseArgs?.nights_min ?? state.nightsMin,
    nightsMax: baseArgs?.nights_max ?? state.nightsMax,
    budgetMax: typeof baseArgs?.budget_max === "number" ? baseArgs.budget_max : state.budgetMax,
    budgetMin: typeof baseArgs?.budget_min === "number" ? baseArgs.budget_min : state.budgetMin,
    meal: typeof baseArgs?.meal === "string" ? (String(baseArgs.meal).toUpperCase() as MealCode) : state.meal,
    ratingMin: typeof baseArgs?.rating === "number" ? baseArgs.rating : state.ratingMin,
    adults: baseArgs?.adults ?? DEFAULT_SEARCH_TOURS_ARGS.adults,
    children: baseArgs?.children ?? DEFAULT_SEARCH_TOURS_ARGS.children,
    lastArgs: baseArgs,
    lastResults: state.lastResults,
    lastRequestId: state.lastRequestId
  });
}

function looksLikeFullQuery(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\d/.test(t) ||
    t.includes("ноч") ||
    t.includes("тыс") ||
    /\b\d+\s*к\b/i.test(t) ||
    t.includes("все включ") ||
    t.includes("all inclusive") ||
    t.includes("ai") ||
    t.includes("турц") ||
    t.includes("егип") ||
    t.includes("тайл") ||
    t.includes("оаэ") ||
    t.includes("мальдив") ||
    t.includes("сейшел") ||
    t.includes("на двоих") ||
    t.includes("апрел") ||
    t.includes("май") ||
    t.includes("июн") ||
    t.includes("июл") ||
    t.includes("август") ||
    t.includes("сентябр")
  );
}

function isLLMActive(): boolean {
  if (BOT_TEST_MODE && process.env.FORCE_LLM_ACTIVE === "1") {
    return true;
  }
  if (process.env.LLM_DISABLED === "1") {
    return false;
  }

  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();
  if (provider === "mock") {
    return false;
  }

  if (provider === "groq") {
    return Boolean(process.env.GROQ_API_KEY?.trim());
  }
  if (provider === "deepseek") {
    return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  }
  if (provider === "openai") {
    return Boolean(process.env.OPENAI_API_KEY?.trim());
  }

  return false;
}

function looksLikeTravelIntent(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("тур") ||
    t.includes("отпуск") ||
    t.includes("поехать") ||
    t.includes("путеше") ||
    t.includes("хочу") ||
    t.includes("турц") ||
    t.includes("turkey") ||
    t.includes("егип") ||
    t.includes("egypt") ||
    t.includes("оаэ") ||
    t.includes("uae") ||
    t.includes("emirates") ||
    t.includes("тайл") ||
    t.includes("thailand") ||
    t.includes("мальдив") ||
    t.includes("maldives") ||
    t.includes("сейшел") ||
    t.includes("seychelles")
  );
}

function localMetaOrSmalltalk(text: string): "meta" | "smalltalk" | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  if (
    t.includes("что ты умеешь") ||
    t.includes("что умеете") ||
    t.includes("помощь") ||
    t === "help" ||
    t.includes("help") ||
    t.includes("кто ты")
  ) {
    return "meta";
  }
  if (t === "привет" || t === "hi" || t === "hello" || t === "здравствуй" || t === "здравствуйте" || /^[👋🙂😊]+$/.test(t)) {
    return "smalltalk";
  }
  if (t === "ок" || t === "окей" || t === "спасибо" || t === "понятно" || /^\)+$/.test(t)) {
    return "smalltalk";
  }
  return null;
}

function isAffirmativeText(text: string): boolean {
  const t = text.toLowerCase().trim();
  return /^(да|ага|угу|хочу|давай|ок|окей)$/i.test(t);
}

function hasUnsupportedCountryMention(text: string): boolean {
  const t = text.toLowerCase();
  if (normalizeCountryName(t)) return false;
  return (
    t.includes("африк") ||
    t.includes("africa") ||
    t.includes("вьет") ||
    t.includes("vietnam") ||
    t.includes("росси") ||
    t.includes("russia") ||
    t.includes("африк") ||
    t.includes("africa") ||
    t.includes("австрал") ||
    t.includes("australia") ||
    t.includes("испан") ||
    t.includes("spain") ||
    t.includes("итал") ||
    t.includes("italy")
  );
}

function compactCountryKeyboard(mode: "guided" | "ai" = "guided") {
  const prefix = mode === "ai" ? "ai:country:" : "country:";
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Турция 🇹🇷", `${prefix}47`),
      Markup.button.callback("Египет 🇪🇬", `${prefix}54`),
      Markup.button.callback("Таиланд 🇹🇭", `${prefix}29`)
    ],
    [
      Markup.button.callback("ОАЭ 🇦🇪", `${prefix}63`),
      Markup.button.callback("Мальдивы 🇲🇻", `${prefix}90`),
      Markup.button.callback("Сейшелы 🇸🇨", `${prefix}91`)
    ]
  ]);
}

function restartAfterCancelKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Турция 🇹🇷", "ai:country:47"),
      Markup.button.callback("Египет 🇪🇬", "ai:country:54"),
      Markup.button.callback("Таиланд 🇹🇭", "ai:country:29")
    ],
    [
      Markup.button.callback("ОАЭ 🇦🇪", "ai:country:63"),
      Markup.button.callback("Мальдивы 🇲🇻", "ai:country:90"),
      Markup.button.callback("Сейшелы 🇸🇨", "ai:country:91")
    ]
  ]);
}

function assistantUtilityKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Найти тур", "start_search"), Markup.button.callback("🌍 Страны", "show_countries")],
    [Markup.button.callback("⭐ Избранное", "fav:list")]
  ]);
}

function resetFlow(state: ChatState): void {
  const keepLastSearchArgs = state.lastSearchArgs;
  resetSearchState(state);
  state.lastSearchArgs = keepLastSearchArgs;
  state.step = "idle";
  state.pendingPromptAction = undefined;
}

function isLocalIntentIncomplete(parsed: ReturnType<typeof parseUserInput>, text: string): boolean {
  const t = text.toLowerCase();
  const mentionsBudget = /\d/.test(t) || t.includes("тыс") || /\b\d+\s*к\b/i.test(t);
  const mentionsMeal = t.includes("все включ") || t.includes("all inclusive") || t.includes("ai");
  const mentionsNights = t.includes("ноч");
  const mentionsMonth =
    t.includes("январ") ||
    t.includes("феврал") ||
    t.includes("март") ||
    t.includes("апрел") ||
    t.includes("май") ||
    t.includes("июн") ||
    t.includes("июл") ||
    t.includes("август") ||
    t.includes("сентябр") ||
    t.includes("октябр") ||
    t.includes("ноябр") ||
    t.includes("декабр");
  const mentionsPeople = t.includes("на двоих");

  const hasCountry = parsed.country_name !== undefined;
  const hasBudget = parsed.budget_max !== undefined;
  const hasMeal = parsed.meal !== undefined;

  if (hasCountry && !hasBudget && mentionsBudget) return true;
  if (hasCountry && !hasMeal && mentionsMeal) return true;
  if (hasCountry && (mentionsNights || mentionsMonth || mentionsPeople) && (!hasBudget || !hasMeal)) return true;
  if (!hasCountry && (mentionsBudget || mentionsMeal || mentionsNights)) return true;

  return false;
}

async function callSearchTours(args: Record<string, unknown>): Promise<SearchOutput> {
  if (testCallSearchToursOverride) {
    return testCallSearchToursOverride(args);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: "search_tours",
      arguments: args
    }
  };

  const res = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}`);
  }

  const data = (await res.json()) as any;
  if (data?.result?.isError) {
    throw new Error(String(data?.result?.content?.[0]?.text ?? "MCP tool error"));
  }

  const output = data?.result?.structuredContent;
  if (!output || !Array.isArray(output.results)) {
    throw new Error("Invalid MCP response shape");
  }

  return output as SearchOutput;
}

function buildSearchArgs(_chatId: number, state: ChatState): Record<string, unknown> {
  if (!state.countryId) {
    state.countryId = 47;
  }

  const args: Record<string, unknown> = {
    ...DEFAULT_SEARCH_TOURS_ARGS,
    country_id: state.countryId,
    nights_min: state.nightsMin,
    nights_max: state.nightsMax,
    limit: state.limit,
    offset: state.offset,
    sort: DEFAULT_SEARCH_TOURS_ARGS.sort
  };

  if (state.budgetMax !== undefined) {
    args.budget_max = state.budgetMax;
  }
  if (state.budgetMin !== undefined) {
    args.budget_min = state.budgetMin;
  }
  if (state.ratingMin !== undefined && state.ratingMin > 0) {
    args.rating = state.ratingMin;
  }

  if (state.period) {
    args.period = state.period;
  }

  if (state.meal && state.meal !== "ANY") {
    args.meal = state.meal;
  }

  return args;
}

async function askCountry(ctx: any): Promise<void> {
  await ctx.reply("Выберите страну для отдыха:", compactCountryKeyboard("guided"));
}

async function askBudget(ctx: any): Promise<void> {
  await ctx.reply(
    "Какой бюджет на тур на двоих?",
    Markup.inlineKeyboard([
      [Markup.button.callback("100k", "budget:100000"), Markup.button.callback("150k", "budget:150000"), Markup.button.callback("250k", "budget:250000")]
    ])
  );
}

async function askPeriod(ctx: any): Promise<void> {
  await ctx.reply(
    "Когда хотите полететь?",
    Markup.inlineKeyboard([
      [Markup.button.callback("Ближайший месяц", "period:next_month")],
      [Markup.button.callback("Через 1–2 месяца", "period:1_2_months")],
      [Markup.button.callback("Летом", "period:summer")],
      [Markup.button.callback("Осенью", "period:autumn")]
    ])
  );
}

async function askQuality(ctx: any): Promise<void> {
  await ctx.reply(
    "Какое качество отеля смотрим?",
    Markup.inlineKeyboard([
      [Markup.button.callback("⭐️⭐️⭐️ и выше", "rating:3.5")],
      [Markup.button.callback("⭐️⭐️⭐️⭐️ и выше", "rating:4.2")],
      [Markup.button.callback("⭐️⭐️⭐️⭐️⭐️", "rating:4.6")],
      [Markup.button.callback("Не важно", "rating:any")]
    ])
  );
}

async function askMeal(ctx: any): Promise<void> {
  await ctx.reply(
    "Какое питание предпочитаете?",
    Markup.inlineKeyboard([
      [Markup.button.callback("Всё включено", "meal:AI")],
      [Markup.button.callback("Завтраки", "meal:BB")],
      [Markup.button.callback("Не важно", "meal:ANY")]
    ])
  );
}

function periodLabel(value?: PeriodCode): string | undefined {
  if (value === "next_month") return "Ближайший месяц";
  if (value === "1_2_months") return "Через 1–2 месяца";
  if (value === "summer") return "Летом";
  if (value === "autumn") return "Осенью";
  return undefined;
}

function ratingLabel(value?: number): string | undefined {
  if (value === 3.5) return "⭐️⭐️⭐️+";
  if (value === 4.2) return "⭐️⭐️⭐️⭐️+";
  if (value === 4.6) return "⭐️⭐️⭐️⭐️⭐️";
  return undefined;
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const normalized = Math.abs(n) % 100;
  const n1 = normalized % 10;

  if (normalized > 10 && normalized < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function tourWord(n: number): string {
  return pluralRu(n, "тур", "тура", "туров");
}

function buildFoundText(total: number, shown: number): string | null {
  if (total <= 0 || shown <= 0) return null;

  const word = tourWord(total);
  if (total <= shown) {
    return `Нашла ${total} ${word}. Показываю все.`;
  }

  return `Нашла ${total} ${word}. Показываю ${shown} самых выгодных.`;
}

function toSafeCount(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return Math.floor(n);
}

function buildPhoneHintText(): string {
  return "Напишите номер сообщением (пример: +79991234567) или нажмите «Отмена».";
}

function shortInvalidPhoneText(): string {
  return "Введите номер в формате +79991234567";
}

function isSamePendingHotel(state: ChatState, hotelId: number): boolean {
  return state.step === "await_phone" && Number(state.pendingHotel?.hotel_id) === hotelId;
}

function ensurePhoneKeyboard() {
  return Markup.keyboard([[Markup.button.text("Отмена")]]).resize();
}

function extractNightsFromText(text: string): number | undefined {
  return parseQuery(text).params.nights;
}

function extractBudgetFromText(text: string): number | undefined {
  const budget = parseQuery(text).params.budget;
  if (!budget) return undefined;
  if (budget.type === "max") return budget.max;
  return budget.max;
}

function extractBudgetRangeFromText(text: string): { min: number; max: number } | undefined {
  const budget = parseQuery(text).params.budget;
  if (!budget || (budget.type !== "range" && budget.type !== "approx")) return undefined;
  return { min: budget.min, max: budget.max };
}

function detectCountryLine(text: string): string | undefined {
  const t = text.toLowerCase();
  if (t.includes("турц") || t.includes("turkey")) return "🇹🇷 Турция";
  if (t.includes("егип") || t.includes("egypt")) return "🇪🇬 Египет";
  if (t.includes("оаэ") || t.includes("uae") || t.includes("emirates")) return "🇦🇪 ОАЭ";
  if (t.includes("тайл") || t.includes("thailand")) return "🇹🇭 Таиланд";
  if (t.includes("мальдив") || t.includes("maldives")) return "🇲🇻 Мальдивы";
  if (t.includes("сейшел") || t.includes("seychelles")) return "🇸🇨 Сейшелы";
  return undefined;
}

function detectMealLine(text: string): string | undefined {
  const t = text.toLowerCase();
  if (t.includes("все включ") || t.includes("всё включ") || t.includes("all inclusive") || t.includes(" ai")) {
    return "🍽 Всё включено";
  }
  return undefined;
}

function buildTextQueryConfirmation(text: string): string {
  const lines: string[] = ["Поняла:"];
  const pq = parseQuery(text);

  const country = detectCountryLine(text);
  if (country) {
    lines.push(country);
  }

  const nights = extractNightsFromText(text);
  if (nights !== undefined) {
    lines.push(`🗓 ${nights} ночей`);
  }

  const budget = extractBudgetFromText(text);
  if (budget !== undefined) {
    lines.push(`💰 до ${budget.toLocaleString("ru-RU")} ₽`);
  }

  const meal = detectMealLine(text);
  if (meal) {
    lines.push(meal);
  }

  if (typeof pq.params.dateFrom === "string") {
    const m = pq.params.dateFrom.match(/^(\d{4})-(\d{2})-/);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const names = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
      if (month >= 1 && month <= 12) {
        lines.push(`📅 ${names[month - 1]} ${year}`);
      }
    }
  }

  lines.push("");
  lines.push("Подбираю лучшие варианты…");
  return lines.join("\n");
}

function parsePositiveInt(text: string): number | undefined {
  const normalized = text.replace(/[^\d]/g, "");
  if (!normalized) {
    return undefined;
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveAiAwaiting(missingFields: string[]): ChatState["aiAwaiting"] {
  const hasCountry = missingFields.includes("country");
  const hasNights = missingFields.includes("nights");
  const hasBudget = missingFields.includes("budget");
  if (hasCountry) return "country";
  if (hasNights && hasBudget) return "nights";
  if (hasNights) return "nights";
  if (hasBudget) return "budget";
  return null;
}

function hasAiSearchData(draft: Partial<SearchToursInput>): boolean {
  const hasNights = Number.isFinite(Number(draft.nights_min)) && Number.isFinite(Number(draft.nights_max));
  const hasBudget = Number.isFinite(Number(draft.budget_max)) && Number(draft.budget_max) > 0;
  return hasNights && hasBudget;
}

function aiPromptText(draft: Partial<SearchToursInput>): string {
  const countryId = Number(draft.country_id);
  const countryLabel = Number.isFinite(countryId) ? COUNTRY_LABEL_BY_ID[countryId] : undefined;
  const monthHint = draft.period === "summer" ? "летом" : draft.period === "autumn" ? "осенью" : undefined;
  const base = countryLabel ? `Поняла: ${countryLabel}` : "Поняла запрос";
  const withPeople = `${base}${monthHint ? ` ${monthHint}` : ""}${Number(draft.adults) === 2 ? " на двоих" : ""}.`;
  return withPeople;
}

function aiQuickKeyboard(kind: "nights" | "budget") {
  if (kind === "nights") {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback("7", "ai:nights:7"),
        Markup.button.callback("10", "ai:nights:10"),
        Markup.button.callback("14", "ai:nights:14")
      ]
    ]);
  }

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("100k", "ai:budget:100000"),
      Markup.button.callback("150k", "ai:budget:150000"),
      Markup.button.callback("250k", "ai:budget:250000")
    ]
  ]);
}

async function askAiMissingField(ctx: any, state: ChatState): Promise<void> {
  if (state.aiAwaiting === "country") {
    await ctx.reply("Какую страну рассматриваете?", compactCountryKeyboard("ai"));
    return;
  }

  if (state.aiAwaiting === "nights") {
    await ctx.reply("Супер. На сколько ночей планируете? Напишите число (например 7) или выберите вариант ниже.", aiQuickKeyboard("nights"));
    return;
  }

  if (state.aiAwaiting === "budget") {
    await ctx.reply("Какой бюджет максимум на двоих/на поездку? Напишите число (например 120000) или выберите вариант ниже.", aiQuickKeyboard("budget"));
  }
}

function nextAiAwaiting(draft: Partial<SearchToursInput>): ChatState["aiAwaiting"] {
  const hasCountry = typeof draft.country_id === "number" || (typeof draft.country_name === "string" && draft.country_name.trim() !== "");
  if (!hasCountry) return "country";
  const hasNights = Number.isFinite(Number(draft.nights_min)) && Number.isFinite(Number(draft.nights_max));
  const hasBudget = Number.isFinite(Number(draft.budget_max)) && Number(draft.budget_max) > 0;
  if (!hasNights) return "nights";
  if (!hasBudget) return "budget";
  return null;
}

function parseFollowupPatch(text: string): Partial<SearchToursInput> | null {
  const t = text.toLowerCase();
  const patch: Partial<SearchToursInput> = {};
  const pq = parseQuery(text);

  const normalizedCountry = normalizeCountryName(text);
  if (normalizedCountry) {
    patch.country_name = normalizedCountry;
    patch.country_id = COUNTRY_TO_ID[normalizedCountry];
  }

  if (t.includes("летом")) {
    patch.period = "summer";
  } else if (t.includes("осенью")) {
    patch.period = "autumn";
  } else if (t.includes("через 1-2") || t.includes("через 1–2") || t.includes("через 1 2")) {
    patch.period = "1_2_months";
  } else if (t.includes("через месяц") || t.includes("в следующем месяце") || t.includes("в ближайший месяц")) {
    patch.period = "next_month";
  } else {
    if (pq.params.dateFrom && pq.params.dateTo) {
      patch.date_from = pq.params.dateFrom;
      patch.date_to = pq.params.dateTo;
    }
  }

  const nights = extractNightsFromText(text);
  if (nights !== undefined) {
    patch.nights_min = nights;
    patch.nights_max = nights;
  }

  const budget = pq.params.budget;
  if (budget?.type === "range") {
    patch.budget_min = budget.min;
    patch.budget_max = budget.max;
  } else if (budget?.type === "approx") {
    patch.budget_min = budget.min;
    patch.budget_max = budget.max;
  } else if (budget?.type === "max") {
    patch.budget_min = undefined;
    patch.budget_max = budget.max;
  } else if (t.includes("дешевле")) {
    patch.sort = "price_asc";
  } else if (t.includes("дороже")) {
    patch.sort = "price_desc";
  }

  if (pq.params.meal) {
    patch.meal = pq.params.meal;
  }

  if (pq.params.dateFrom && pq.params.dateTo) {
    patch.date_from = pq.params.dateFrom;
    patch.date_to = pq.params.dateTo;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function detectBudgetTargetQuestion(text: string): number | undefined {
  const t = text.toLowerCase();
  const explicitApprox = t.includes("около") || t.includes("примерно") || t.includes("в районе") || t.includes("порядка") || t.includes("~") || t.includes("≈");
  const explicitMax = t.includes("до") || t.includes("максимум") || t.includes("не больше");
  if (explicitApprox) {
    return undefined;
  }
  if (explicitMax) {
    return undefined;
  }
  const targetBudgetPhrase = /(^|\s)за\s*\d/i.test(t);
  if (!targetBudgetPhrase && !/\?/.test(t)) {
    return undefined;
  }
  const budget = parseQuery(text).params.budget;
  if (!budget) return undefined;
  return budget.type === "approx" ? budget.value : budget.max;
}

function buildRuleDraftFromText(text: string): Partial<SearchToursInput> {
  const patch = parseFollowupPatch(text) ?? {};
  const pq = parseQuery(text);
  const normalizedCountry = normalizeCountryName(text);
  if (normalizedCountry) {
    patch.country_name = normalizedCountry;
    patch.country_id = COUNTRY_TO_ID[normalizedCountry];
  }
  const nights = extractNightsFromText(text);
  if (nights !== undefined) {
    patch.nights_min = nights;
    patch.nights_max = nights;
  }
  if (pq.params.budget?.type === "range" || pq.params.budget?.type === "approx") {
    patch.budget_min = pq.params.budget.min;
    patch.budget_max = pq.params.budget.max;
  } else if (pq.params.budget?.type === "max") {
    patch.budget_min = undefined;
    patch.budget_max = pq.params.budget.max;
  }
  if (pq.params.meal) {
    patch.meal = pq.params.meal;
  }
  if (pq.params.dateFrom && pq.params.dateTo) {
    patch.date_from = pq.params.dateFrom;
    patch.date_to = pq.params.dateTo;
  }
  return patch;
}

function beginSearchSeq(state: ChatState): number {
  const next = (state.activeSearchSeq ?? 0) + 1;
  state.activeSearchSeq = next;
  return next;
}

function isSearchSeqStale(state: ChatState, seq: number): boolean {
  return (state.activeSearchSeq ?? 0) !== seq;
}

async function runAiDraftSearch(ctx: any, state: ChatState, chatId: number): Promise<void> {
  const draft = state.aiDraft ?? {};
  const parsed = searchToursInputSchema.parse({
    ...DEFAULT_SEARCH_TOURS_ARGS,
    ...draft
  });
  applyOrchestratedSearchArgsToState(state, parsed);
  state.lastSearchArgs = parsed;
  await ctx.reply("Запускаю поиск по уточнённым параметрам.", {
    ...Markup.removeKeyboard()
  });
  await runSearchWithRetry(ctx, state, chatId, { showSearching: true });
}

async function sendFiltersSummary(ctx: any, state: ChatState): Promise<void> {
  const parts: string[] = [];
  const country = state.countryId ? COUNTRY_LABEL_BY_ID[state.countryId] : undefined;
  if (country) parts.push(country);
  if (state.budgetChosen && state.budgetMax !== undefined) {
    if (state.budgetMin !== undefined && state.budgetMin > 0) {
      parts.push(`${Math.round(state.budgetMin).toLocaleString("ru-RU")}–${Math.round(state.budgetMax).toLocaleString("ru-RU")} ₽`);
    } else {
      parts.push(`до ${Math.round(state.budgetMax).toLocaleString("ru-RU")} ₽`);
    }
  }
  const rating = state.ratingChosen ? ratingLabel(state.ratingMin) : undefined;
  if (rating) parts.push(rating);
  const period = periodLabel(state.period);
  if (period) parts.push(period);
  if (state.mealChosen && state.meal && state.meal !== "ANY") {
    parts.push(mealLabel(state.meal));
  }
  if (state.searchContext?.dateFrom) {
    const m = state.searchContext.dateFrom.match(/^(\d{4})-(\d{2})-01$/);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const names = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
      if (month >= 1 && month <= 12) {
        parts.push(`${names[month - 1]} ${year}`);
      }
    }
  }
  if (parts.length > 0) {
    await ctx.reply(`Фильтры: ${parts.join(" • ")}`);
  }
}

async function sendCards(ctx: any, state: ChatState, output: SearchOutput): Promise<void> {
  state.step = "idle";
  state.aiAwaiting = null;
  state.aiDraft = {};
  state.lastRequestId = output.requestid;
  state.lastResults = output.results;
  syncSearchContextFromState(state);
  if (state.searchContext) {
    state.searchContext = applySearchContext(state.searchContext, {
      lastResults: output.results,
      lastRequestId: output.requestid
    });
  }

  if (output.results.length === 0) {
    if (state.offset > 0) {
      await ctx.reply(
        "Больше туров нет, попробуйте изменить параметры.",
        Markup.inlineKeyboard([[Markup.button.callback("🔎 Новый поиск", "new")]])
      );
    } else {
      await ctx.reply(
        "😕 Ничего не найдено. Попробуем изменить фильтры?",
        Markup.inlineKeyboard([
          [Markup.button.callback("⚙️ Изменить фильтры", "filters")],
          [Markup.button.callback("🔎 Новый поиск", "new")]
        ])
      );
    }
    return;
  }

  const shown = output.results.length;
  const total = toSafeCount(output.meta?.total) ?? toSafeCount(output.total) ?? state.offset + shown;
  const foundText = buildFoundText(total, shown);
  if (foundText !== null) {
    await ctx.reply(foundText);
  }

  for (const tour of output.results) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("💚 Хочу этот тур", `want:${output.requestid}:${tour.hotel_id}`)],
      [Markup.button.callback("⭐ Сохранить тур", `fav:tour:${tour.hotel_id}`)]
    ]);
    const caption = safeCaption(tour);
    const absPath = resolveLocalPhotoPath(tour.image_url);

    if (absPath && existsSync(absPath)) {
      try {
        await ctx.replyWithPhoto(
          { source: createReadStream(absPath) },
          {
            caption,
            parse_mode: "HTML",
            reply_markup: keyboard.reply_markup
          }
        );
        continue;
      } catch (err) {
        if (process.env.LLM_DEBUG === "1") {
          logger.warn(
            {
              err_message: (err as Error)?.message ?? String(err),
              absPath,
              hotel_id: tour.hotel_id,
              country_id: state.countryId
            },
            "[BOT] replyWithPhoto local stream failed, fallback to text"
          );
        }
      }
    } else if (tour.image_url && process.env.LLM_DEBUG === "1") {
      logger.warn(
        {
          err_message: "photo_file_not_found",
          image_url: tour.image_url,
          absPath,
          hotel_id: tour.hotel_id,
          country_id: state.countryId
        },
        "[BOT] local photo file not found, fallback to text"
      );
    }

    await ctx.reply(caption, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup
    });
  }

  await ctx.reply("Выберите тур и нажмите 💚 — мы уточним наличие и цену. Обычно отвечаем в течение 5–10 минут.");
  await sendResultActions(ctx, output.requestid);
}

async function runSearch(ctx: any, state: ChatState, chatId: number): Promise<void> {
  const seq = beginSearchSeq(state);
  const args = buildSearchArgs(chatId, state);
  state.lastSearchArgs = searchToursInputSchema.parse(args);
  syncSearchContextFromState(state, state.lastSearchArgs);
  const output = await callSearchTours(args);
  if (isSearchSeqStale(state, seq)) {
    if (process.env.LLM_DEBUG === "1") {
      logger.debug({ chatId, seq }, "[BOT] stale search result skipped");
    }
    return;
  }
  await sendCards(ctx, state, output);
}

async function continueFlow(ctx: any, state: ChatState, chatId: number): Promise<void> {
  if (!state.countryId) {
    await askCountry(ctx);
    return;
  }
  if (!state.budgetChosen && state.step !== "budget_input") {
    await askBudget(ctx);
    return;
  }
  if (!state.ratingChosen) {
    await askQuality(ctx);
    return;
  }
  if (!state.period) {
    await askPeriod(ctx);
    return;
  }
  if (!state.mealChosen) {
    await askMeal(ctx);
    return;
  }

  await runSearchWithRetry(ctx, state, chatId, { showSearching: true });
}

async function sendResultActions(ctx: any, requestId: string): Promise<void> {
  await ctx.reply(
    "Действия:",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🔁 Показать ещё", `more:${requestId}`),
        Markup.button.callback("⚙️ Изменить фильтры", "filters")
      ],
      [Markup.button.callback("⭐ Избранное", "fav:list")],
      [Markup.button.callback("🔎 Новый поиск", "new")]
    ])
  );
}

async function askFiltersMenu(ctx: any): Promise<void> {
  await ctx.reply(
    "Что изменить?",
    Markup.inlineKeyboard([
      [Markup.button.callback("💰 Бюджет", "filtermenu:budget"), Markup.button.callback("⭐ Качество", "filtermenu:rating")],
      [Markup.button.callback("📅 Период", "filtermenu:period"), Markup.button.callback("🍽 Питание", "filtermenu:meal")],
      [Markup.button.callback("⬅ Назад к результатам", "filtermenu:back")]
    ])
  );
}

async function showSearchError(ctx: any): Promise<void> {
  await ctx.reply(
    "Упс, не удалось получить туры. Похоже, сервис поиска сейчас недоступен.\nМожно попробовать ещё раз или изменить параметры.",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔁 Повторить", "retry")],
      [Markup.button.callback("⚙️ Изменить фильтры", "filters")],
      [Markup.button.callback("🔎 Новый поиск", "new")]
    ])
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function replyCancelReset(ctx: any, state: ChatState): Promise<void> {
  resetFlow(state);
  state.aiMode = true;
  state.aiAwaiting = "country";
  await ctx.reply(
    "Ок, сбросила поиск. Выберите страну или напишите запрос в свободной форме.",
    {
      ...Markup.removeKeyboard()
    }
  );
  await ctx.reply("Доступные страны:", restartAfterCancelKeyboard());
}

async function replyStart(ctx: any): Promise<void> {
  await ctx.reply(
    "Привет. Я AI-ассистент по подбору туров ✨\nМогу провести вас по шагам или понять запрос в свободной форме.\n\nНапример:\nТурция на 7 ночей до 120 000 ₽, всё включено",
    assistantUtilityKeyboard()
  );
}

async function replyHelp(ctx: any): Promise<void> {
  await ctx.reply(
    "Я подбираю туры по 6 странам: Турция, Египет, Таиланд, ОАЭ, Мальдивы, Сейшелы.\nНапишите запрос свободно, например: «Турция на 7 ночей до 120к, всё включено».\nИли нажмите «🔎 Найти тур».",
    assistantUtilityKeyboard()
  );
}

async function runSearchWithRetry(
  ctx: any,
  state: ChatState,
  chatId: number,
  options?: { showSearching?: boolean }
): Promise<boolean> {
  if (options?.showSearching) {
    await ctx.reply("🔎 Ищу лучшие варианты для вас...");
  }
  await sendFiltersSummary(ctx, state);
  try {
    await runSearch(ctx, state, chatId);
    return true;
  } catch {
    await sleep(600);
  }

  try {
    await runSearch(ctx, state, chatId);
    return true;
  } catch {
    await showSearchError(ctx);
    return false;
  }
}

async function saveLead(ctx: any, state: ChatState, phone: string): Promise<void> {
  const user = ctx.from ?? {};
  const chatId = getChatId(ctx);
  const hotel = state.pendingHotel;

  if (!hotel || !state.lastRequestId || !state.countryId) {
    return;
  }

  await mkdir(path.join(process.cwd(), "data"), { recursive: true });

  const lead = {
    ts: new Date().toISOString(),
    chat_id: chatId,
    username: user.username ?? null,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    phone_number: phone,
    country_id: state.countryId,
    requestid: state.lastRequestId,
    hotel_id: hotel.hotel_id,
    search_params: {
      country_id: state.countryId,
      budget_max: state.budgetMax,
      period: state.period,
      rating: state.ratingMin,
      meal: state.meal,
      limit: state.limit,
      offset: state.offset,
      departure_id: DEFAULT_SEARCH_TOURS_ARGS.departure_id,
      date_from: DEFAULT_SEARCH_TOURS_ARGS.date_from,
      date_to: DEFAULT_SEARCH_TOURS_ARGS.date_to,
      nights_min: state.nightsMin,
      nights_max: state.nightsMax,
      adults: DEFAULT_SEARCH_TOURS_ARGS.adults,
      children: DEFAULT_SEARCH_TOURS_ARGS.children
    }
  };

  await appendFile(path.join(process.cwd(), "data", "leads.jsonl"), `${JSON.stringify(lead)}\n`, "utf8");
}

if (!botModuleState.__etoBotHandlersRegistered) {
  botModuleState.__etoBotHandlersRegistered = true;

bot.start(async (ctx: any) => {
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  resetFlow(state);
  await replyStart(ctx);
});

bot.command("start", async (ctx: any) => {
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  resetFlow(state);
  if (process.env.LLM_DEBUG === "1") {
    logger.info({ chatId }, "[BOT] start handled");
  }
  await replyStart(ctx);
});

bot.command("cancel", async (ctx: any) => {
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  await replyCancelReset(ctx, state);
});

bot.command("help", async (ctx: any) => {
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  resetFlow(state);
  await replyHelp(ctx);
});

bot.hears("🔎 Найти ещё", async (ctx: any) => {
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  resetSearchState(state);
  state.step = "idle";
  await ctx.reply("Отлично, подберём ещё варианты ✨", {
    ...Markup.removeKeyboard()
  });
  await askCountry(ctx);
});

bot.action("start_search", async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  resetSearchState(state);
  state.step = "idle";
  await askCountry(ctx);
});

bot.action("show_countries", async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.reply("Доступные страны:", compactCountryKeyboard("guided"));
});

bot.action(/^country:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.sendChatAction?.("typing");
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  resetSearchState(state);
  state.countryId = Number(ctx.match[1]);
  await askBudget(ctx);
});

bot.action(/^budget:(.+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const value = String(ctx.match[1]);

  if (value === "custom") {
    state.step = "budget_input";
    await ctx.reply("Введите бюджет числом (например 150000) или напишите «без лимита».");
    return;
  }

  state.step = "idle";
  state.budgetChosen = true;
  state.budgetMax = Number(value);
  if (state.editingFilter === "budget") {
    state.offset = 0;
    state.editingFilter = undefined;
    await runSearchWithRetry(ctx, state, chatId, { showSearching: true });
    return;
  }
  await askQuality(ctx);
});

bot.action(/^rating:(.+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const value = String(ctx.match[1]);

  state.ratingChosen = true;
  state.ratingMin = value === "any" ? undefined : Number(value);
  if (state.editingFilter === "rating") {
    state.offset = 0;
    state.editingFilter = undefined;
    await runSearchWithRetry(ctx, state, chatId, { showSearching: true });
    return;
  }
  await askPeriod(ctx);
});

bot.action(/^period:(.+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const value = String(ctx.match[1]) as PeriodCode;

  state.period = value;
  if (state.editingFilter === "period") {
    state.offset = 0;
    state.editingFilter = undefined;
    await runSearchWithRetry(ctx, state, chatId, { showSearching: true });
    return;
  }
  await askMeal(ctx);
});

bot.action(/^meal:(.+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const value = String(ctx.match[1]).toUpperCase();

  state.meal = value === "ANY" ? "ANY" : (value as MealCode);
  state.mealChosen = true;
  state.offset = 0;

  if (state.editingFilter === "meal") {
    state.editingFilter = undefined;
  }
  await runSearchWithRetry(ctx, state, chatId, { showSearching: true });
});

bot.action(/^ai:nights:(\d+|custom)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  if (!state.aiMode) {
    return;
  }

  const value = String(ctx.match[1]);
  if (value === "custom") {
    state.step = "ai_nights_input";
    await ctx.reply("Введите количество ночей числом (например 7).", {
      ...Markup.keyboard([[Markup.button.text("Отмена")]]).resize()
    });
    return;
  }

  const nights = Number(value);
  if (!Number.isFinite(nights) || nights <= 0) {
    return;
  }

  state.aiDraft = {
    ...(state.aiDraft ?? {}),
    nights_min: Math.floor(nights),
    nights_max: Math.floor(nights)
  };
  state.aiAwaiting = nextAiAwaiting(state.aiDraft);

  if (hasAiSearchData(state.aiDraft)) {
    await runAiDraftSearch(ctx, state, chatId);
    state.aiMode = false;
    state.aiDraft = undefined;
    state.aiAwaiting = null;
    return;
  }

  await ctx.reply("Ночи зафиксировала.");
  await askAiMissingField(ctx, state);
});

bot.action(/^ai:budget:(\d+|custom)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  if (!state.aiMode) {
    return;
  }

  const value = String(ctx.match[1]);
  if (value === "custom") {
    state.step = "ai_budget_input";
    await ctx.reply("Введите бюджет числом (например 150000).", {
      ...Markup.keyboard([[Markup.button.text("Отмена")]]).resize()
    });
    return;
  }

  const budget = Number(value);
  if (!Number.isFinite(budget) || budget <= 0) {
    return;
  }

  state.aiDraft = {
    ...(state.aiDraft ?? {}),
    budget_max: Math.floor(budget)
  };
  state.aiAwaiting = nextAiAwaiting(state.aiDraft);

  if (hasAiSearchData(state.aiDraft)) {
    await runAiDraftSearch(ctx, state, chatId);
    state.aiMode = false;
    state.aiDraft = undefined;
    state.aiAwaiting = null;
    return;
  }

  await ctx.reply("Бюджет зафиксировала.");
  await askAiMissingField(ctx, state);
});

bot.action(/^ai:country:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.sendChatAction?.("typing");
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  if (!state.aiMode) {
    return;
  }

  const countryId = Number(ctx.match[1]);
  if (!Number.isFinite(countryId)) {
    return;
  }

  state.aiDraft = {
    ...(state.aiDraft ?? {}),
    country_id: countryId
  };
  state.aiAwaiting = nextAiAwaiting(state.aiDraft);

  if (hasAiSearchData(state.aiDraft)) {
    await runAiDraftSearch(ctx, state, chatId);
    state.aiMode = false;
    state.aiDraft = undefined;
    state.aiAwaiting = null;
    return;
  }

  await askAiMissingField(ctx, state);
});

bot.action("ai:cancel", async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  await replyCancelReset(ctx, state);
});

bot.on("text", async (ctx: any) => {
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const text = String(ctx.message?.text ?? "").trim();

  if (text.startsWith("/")) {
    if (/^\/(start|cancel|help)\b/i.test(text)) {
      return;
    }
    await ctx.reply("Команду поняла, но она не поддерживается. Нажмите «🔎 Найти тур» или напишите запрос свободным текстом.");
    return;
  }

  if (isCancelText(text)) {
    await replyCancelReset(ctx, state);
    return;
  }

  if (state.pendingPromptAction === "show_favorites" && isAffirmativeText(text)) {
    state.pendingPromptAction = undefined;
    await showFavorites(ctx, state);
    return;
  }

  if (state.pendingBudgetClarification) {
    const pending = state.pendingBudgetClarification;
    const lower = text.toLowerCase();
    const explicitMax = lower.includes("до");
    const explicitTarget = lower.includes("около") || lower.includes("примерно") || lower.includes("в районе") || /(^|\s)за\s*\d/i.test(lower);
    const parsedBudget = extractBudgetFromText(text) ?? pending.value;
    if (!parsedBudget) {
      await ctx.reply(`Не поняла сумму. Напишите «до ${pending.value}» или «около ${pending.value}».`);
      return;
    }

    state.pendingBudgetClarification = undefined;

    if (pending.mode === "followup" && state.lastSearchArgs) {
      const nextArgs = searchToursInputSchema.parse({
        ...state.lastSearchArgs,
        budget_max: explicitTarget ? Math.round(parsedBudget * 1.2) : parsedBudget,
        offset: 0
      });
      applyOrchestratedSearchArgsToState(state, nextArgs);
      state.searchContext = applySearchContext(state.searchContext, {
        budgetTarget: explicitTarget ? parsedBudget : undefined,
        budgetMax: explicitTarget ? Math.round(parsedBudget * 1.2) : parsedBudget
      });
      state.lastSearchArgs = nextArgs;
      await ctx.reply("Обновляю поиск по вашему уточнению ✨");
      const seq = beginSearchSeq(state);
      const output = await callSearchTours(nextArgs as unknown as Record<string, unknown>);
      if (isSearchSeqStale(state, seq)) return;
      await sendCards(ctx, state, output);
      return;
    }

    state.aiMode = true;
    const resolvedBudgetMax = explicitTarget ? Math.round(parsedBudget * 1.2) : parsedBudget;
    const resolvedBudgetTarget = explicitTarget ? parsedBudget : undefined;
    state.aiDraft = {
      ...(state.aiDraft ?? {}),
      budget_max: resolvedBudgetMax
    };
    state.searchContext = applySearchContext(state.searchContext, {
      budgetTarget: resolvedBudgetTarget,
      budgetMax: resolvedBudgetMax
    });
    state.aiAwaiting = nextAiAwaiting(state.aiDraft);
    if (hasAiSearchData(state.aiDraft)) {
      await runAiDraftSearch(ctx, state, chatId);
      state.searchContext = applySearchContext(state.searchContext, {
        budgetTarget: resolvedBudgetTarget,
        budgetMax: resolvedBudgetMax
      });
      state.aiMode = false;
      state.aiDraft = undefined;
      state.aiAwaiting = null;
      return;
    }
    await askAiMissingField(ctx, state);
    return;
  }

  const parsedQuery = parseQuery(text);
  const hasExplicitParams = Boolean(
    parsedQuery.params.country ||
    parsedQuery.params.unknownCountry ||
    parsedQuery.params.nights !== undefined ||
    parsedQuery.params.budget ||
    parsedQuery.params.meal ||
    parsedQuery.params.month !== undefined ||
    (typeof parsedQuery.params.dateFrom === "string" && typeof parsedQuery.params.dateTo === "string")
  );

  if (state.pendingPromptAction && !(state.pendingPromptAction === "show_favorites" && isAffirmativeText(text))) {
    if (hasExplicitParams || parsedQuery.command || !parsedQuery.smalltalk) {
      state.pendingPromptAction = undefined;
    }
  }

  if (isAffirmativeText(text) && !hasExplicitParams && !parsedQuery.command) {
    if (state.aiMode && state.aiAwaiting) {
      await ctx.reply("Ок 👌 Напишите значение одним сообщением.");
      await askAiMissingField(ctx, state);
      return;
    }
    if (state.step === "budget_input") {
      await ctx.reply("Ок 👌 Напишите бюджет, например: «до 120к» или «150000».");
      return;
    }
  }

  if (parsedQuery.command && !hasExplicitParams) {
    if (parsedQuery.command === "SHOW_MORE") {
      if (state.lastRequestId) {
        state.offset += state.limit;
        await runSearchWithRetry(ctx, state, chatId);
      } else {
        await ctx.reply("Сначала запустите поиск и я покажу варианты.");
      }
      return;
    }
    if (parsedQuery.command === "EDIT_FILTERS") {
      await askFiltersMenu(ctx);
      return;
    }
    if (parsedQuery.command === "FAVORITES") {
      state.pendingPromptAction = undefined;
      await showFavorites(ctx, state);
      return;
    }
    if (parsedQuery.command === "CLEAR_FAVORITES") {
      state.pendingPromptAction = undefined;
      state.favorites = clearFavoritesStore();
      await ctx.reply("Избранное очищено.");
      return;
    }
    if (parsedQuery.command === "NEW_SEARCH") {
      resetSearchState(state);
      state.step = "idle";
      await ctx.reply("Ок, начнём заново. Выберите страну:", compactCountryKeyboard("guided"));
      return;
    }
    if (parsedQuery.command === "COUNTRIES") {
      await ctx.reply("Выберите страну:", compactCountryKeyboard(state.aiMode ? "ai" : "guided"));
      return;
    }
    if (parsedQuery.command === "START_SEARCH") {
      if (state.lastRequestId) {
        await ctx.reply("Напишите страну, ночи и бюджет, например: «Турция 7 ночей до 120к».", compactCountryKeyboard("ai"));
      } else {
        await askCountry(ctx);
      }
      return;
    }
  }

  if (parsedQuery.params.unknownCountry) {
    resetFlow(state);
    await ctx.reply(unsupportedCountryText(), compactCountryKeyboard("ai"));
    return;
  }

  if (parsedQuery.smalltalk && !hasExplicitParams && !parsedQuery.command) {
    const lower = text.toLowerCase();
    let replyText = "Ок 😊";
    if (/(спасибо|спс|благодарю)/i.test(lower)) {
      replyText = "Пожалуйста! 😊 Если хотите — скажите страну/ночи/бюджет или нажмите «Страны».";
    } else if (
      lower.startsWith("привет") ||
      lower.startsWith("здравствуйте") ||
      lower.startsWith("здравствуй") ||
      lower.startsWith("hello") ||
      lower.startsWith("hi")
    ) {
      replyText = "Привет! Могу подобрать тур в свободной форме. Например: «Турция на 7 ночей до 120 000 ₽, всё включено».";
    } else if (state.step !== "idle" || state.aiMode) {
      replyText = "Ок 😊 Продолжаем. Напишите следующий параметр.";
    } else if (/что ты умеешь|помощь|help|кто ты/i.test(lower)) {
      replyText = "Подбираю туры по странам каталога. Напишите, например: «Турция на 7 ночей до 120к, всё включено».";
    }
    await ctx.reply(replyText, assistantUtilityKeyboard());
    if (state.aiMode && state.aiAwaiting && !/(спасибо|спс|благодарю)/i.test(lower)) {
      await askAiMissingField(ctx, state);
    } else if (state.step === "budget_input" && !/(спасибо|спс|благодарю)/i.test(lower)) {
      await ctx.reply("Какой бюджет планируете? Можно написать, например: «до 120к».");
    }
    return;
  }

  if (isLLMActive() && state.step === "budget_input") {
    const maybeBudget = parseBudgetAnswer(text);
    if (maybeBudget === undefined && text.trim() !== "") {
      resetFlow(state);
    }
  }

  const localOfftopic = localMetaOrSmalltalk(text);
  if (localOfftopic) {
    let llmIntentType: "meta" | "smalltalk" = localOfftopic;
    if (isLLMActive()) {
      try {
        const providerIntent = await withTimeout(getLLMProvider(logger).parseIntent(text), 3_500, "llm_classify");
        if (providerIntent.type === "meta" || providerIntent.type === "smalltalk") {
          llmIntentType = providerIntent.type;
        }
      } catch {
        // keep local heuristic decision
      }
    }

    if (llmIntentType === "meta") {
      resetFlow(state);
    }
    await ctx.reply(
      llmIntentType === "meta"
        ? "Я помогу подобрать тур по одной из стран: Турция, Египет, Таиланд, ОАЭ, Мальдивы, Сейшелы. Напишите, например: «Турция на 7 ночей до 120 000 ₽, всё включено»."
        : (state.aiMode || state.step !== "idle" ? "Ок 😊 Продолжаем. Напишите следующий параметр или выберите кнопку." : "Привет! Могу подобрать тур в свободной форме. Например: «Турция на 7 ночей до 120 000 ₽, всё включено»."),
      assistantUtilityKeyboard()
    );
    return;
  }

  if (hasUnsupportedCountryMention(text)) {
    resetFlow(state);
    await ctx.reply(
      unsupportedCountryText(),
      compactCountryKeyboard("ai")
    );
    return;
  }

  if (state.step === "budget_input") {
    const budget = parseBudgetAnswer(text);
    if (budget === undefined) {
      await ctx.reply("Введите сумму цифрами (например 150000) или «без лимита».");
      return;
    }

    state.budgetChosen = true;
    if (budget.kind === "none") {
      state.budgetMax = undefined;
      state.budgetMin = undefined;
      state.searchContext = applySearchContext(state.searchContext, { budgetMax: undefined, budgetMin: undefined, budgetTarget: undefined });
    } else if (budget.kind === "target") {
      state.budgetMin = undefined;
      state.budgetMax = Math.round(budget.value * 1.2);
      state.searchContext = applySearchContext(state.searchContext, {
        budgetTarget: budget.value,
        budgetMax: state.budgetMax,
        budgetMin: undefined
      });
    } else {
      state.budgetMin = undefined;
      state.budgetMax = budget.value;
      state.searchContext = applySearchContext(state.searchContext, {
        budgetTarget: undefined,
        budgetMax: state.budgetMax,
        budgetMin: undefined
      });
    }
    state.step = "idle";
    if (state.editingFilter === "budget") {
      state.offset = 0;
      state.editingFilter = undefined;
      await runSearchWithRetry(ctx, state, chatId, { showSearching: true });
      return;
    }
    await askQuality(ctx);
    return;
  }

  if (state.step === "ai_nights_input") {
    const fullPatch = buildRuleDraftFromText(text);
    const nightsFromText = Number(fullPatch.nights_min);
    const nights = Number.isFinite(nightsFromText) ? nightsFromText : parsePositiveInt(text);
    if (!nights || nights < 1 || nights > 30) {
      await ctx.reply("Введите количество ночей числом от 1 до 30.");
      return;
    }

    state.aiDraft = {
      ...(state.aiDraft ?? {}),
      nights_min: nights,
      nights_max: nights,
      ...(typeof fullPatch.country_id === "number" ? { country_id: fullPatch.country_id } : {}),
      ...(typeof fullPatch.country_name === "string" ? { country_name: fullPatch.country_name } : {}),
      ...(typeof fullPatch.budget_max === "number" ? { budget_max: fullPatch.budget_max } : {}),
      ...(typeof fullPatch.meal === "string" ? { meal: fullPatch.meal } : {}),
      ...(typeof fullPatch.date_from === "string" ? { date_from: fullPatch.date_from } : {}),
      ...(typeof fullPatch.date_to === "string" ? { date_to: fullPatch.date_to } : {})
    };
    state.step = "idle";
    state.aiAwaiting = nextAiAwaiting(state.aiDraft);

    if (hasAiSearchData(state.aiDraft)) {
      await runAiDraftSearch(ctx, state, chatId);
      state.aiMode = false;
      state.aiDraft = undefined;
      state.aiAwaiting = null;
      return;
    }

    await ctx.reply("Принято.");
    await askAiMissingField(ctx, state);
    return;
  }

  if (state.step === "ai_budget_input") {
    const fullPatch = buildRuleDraftFromText(text);
    const budgetFromText = Number(fullPatch.budget_max);
    const budget = Number.isFinite(budgetFromText) ? budgetFromText : parsePositiveInt(text);
    if (!budget || budget < 10000) {
      await ctx.reply("Введите бюджет числом, например 150000.");
      return;
    }

    state.aiDraft = {
      ...(state.aiDraft ?? {}),
      budget_max: budget,
      ...(typeof fullPatch.country_id === "number" ? { country_id: fullPatch.country_id } : {}),
      ...(typeof fullPatch.country_name === "string" ? { country_name: fullPatch.country_name } : {}),
      ...(typeof fullPatch.nights_min === "number" ? { nights_min: fullPatch.nights_min } : {}),
      ...(typeof fullPatch.nights_max === "number" ? { nights_max: fullPatch.nights_max } : {}),
      ...(typeof fullPatch.meal === "string" ? { meal: fullPatch.meal } : {}),
      ...(typeof fullPatch.date_from === "string" ? { date_from: fullPatch.date_from } : {}),
      ...(typeof fullPatch.date_to === "string" ? { date_to: fullPatch.date_to } : {})
    };
    state.step = "idle";
    state.aiAwaiting = nextAiAwaiting(state.aiDraft);

    if (hasAiSearchData(state.aiDraft)) {
      await runAiDraftSearch(ctx, state, chatId);
      state.aiMode = false;
      state.aiDraft = undefined;
      state.aiAwaiting = null;
      return;
    }

    await ctx.reply("Принято.");
    await askAiMissingField(ctx, state);
    return;
  }

  if (state.aiMode && state.step === "idle" && state.aiAwaiting === "country") {
    const normalizedCountry = normalizeCountryName(text);
    if (!normalizedCountry) {
      if (hasUnsupportedCountryMention(text)) {
        await ctx.reply(
          unsupportedCountryText(),
          compactCountryKeyboard("ai")
        );
        return;
      }
      await askAiMissingField(ctx, state);
      return;
    }

    state.aiDraft = {
      ...(state.aiDraft ?? {}),
      country_name: normalizedCountry
    };
    state.aiAwaiting = nextAiAwaiting(state.aiDraft);
    await askAiMissingField(ctx, state);
    return;
  }

  if (state.aiMode && state.step === "idle" && (state.aiAwaiting === "nights" || state.aiAwaiting === "budget")) {
    if (state.aiAwaiting === "nights" && /праздник/i.test(text)) {
      await ctx.reply("Под праздники лучше уточнить месяц или даты. Например: «в ноябре» или «на 7 ночей».");
      return;
    }
    if (state.aiAwaiting === "nights" && /выходн/i.test(text)) {
      state.aiDraft = {
        ...(state.aiDraft ?? {}),
        nights_min: 3,
        nights_max: 3
      };
      state.aiAwaiting = nextAiAwaiting(state.aiDraft ?? {});
      await ctx.reply("Ок, поставлю 3 ночи — подойдёт?");
      if (hasAiSearchData(state.aiDraft ?? {})) {
        await runAiDraftSearch(ctx, state, chatId);
        state.aiMode = false;
        state.aiDraft = undefined;
        state.aiAwaiting = null;
      }
      return;
    }
    const value = parsePositiveInt(text);
    if (!value) {
      await askAiMissingField(ctx, state);
      return;
    }

    if (state.aiAwaiting === "nights") {
      if (value < 1 || value > 30) {
        await ctx.reply("Введите количество ночей числом от 1 до 30.");
        return;
      }
      state.aiDraft = {
        ...(state.aiDraft ?? {}),
        nights_min: value,
        nights_max: value
      };
    } else {
      if (value < 10000) {
        await ctx.reply("Введите бюджет числом, например 120000.");
        return;
      }
      state.aiDraft = {
        ...(state.aiDraft ?? {}),
        budget_max: value
      };
    }

    state.aiAwaiting = nextAiAwaiting(state.aiDraft ?? {});
    if (hasAiSearchData(state.aiDraft ?? {})) {
      await runAiDraftSearch(ctx, state, chatId);
      state.aiMode = false;
      state.aiDraft = undefined;
      state.aiAwaiting = null;
      return;
    }

    await askAiMissingField(ctx, state);
    return;
  }

  if (isLLMActive() && state.step === "idle" && state.lastSearchArgs) {
    if (hasUnsupportedCountryMention(text)) {
      resetFlow(state);
      await ctx.reply(
        unsupportedCountryText(),
        compactCountryKeyboard("ai")
      );
      return;
    }
    const budgetTarget = detectBudgetTargetQuestion(text);
    if (budgetTarget !== undefined) {
      state.pendingBudgetClarification = { value: budgetTarget, mode: "followup" };
      await ctx.reply(
        `${Math.round(budgetTarget).toLocaleString("ru-RU")} ₽ — это максимум или ориентир около этой суммы? Напишите «до ${budgetTarget}» или «около ${budgetTarget}».`
      );
      return;
    }
    const followupPatch = parseFollowupPatch(text);
    if (followupPatch) {
      const nextArgs = searchToursInputSchema.parse({
        ...state.lastSearchArgs,
        ...followupPatch,
        offset: 0
      });
      const prevCountryId = state.lastSearchArgs.country_id;
      if (followupPatch.country_id !== undefined && followupPatch.country_id !== prevCountryId) {
        await ctx.reply(
          `Меняю направление на ${COUNTRY_LABEL_BY_ID[followupPatch.country_id] ?? "новую страну"} и обновляю поиск ✨`
        );
      }
      applyOrchestratedSearchArgsToState(state, nextArgs);
      state.lastSearchArgs = nextArgs;
      if (!(followupPatch.country_id !== undefined && followupPatch.country_id !== prevCountryId)) {
        await ctx.reply("Обновляю поиск по вашему уточнению ✨");
      }
      const seq = beginSearchSeq(state);
      const output = await callSearchTours(nextArgs as unknown as Record<string, unknown>);
      if (isSearchSeqStale(state, seq)) {
        return;
      }
      await sendCards(ctx, state, output);
      return;
    }
  }

  if (state.step === "await_phone") {
    const normalized = normalizePhone(text);
    if (!normalized.ok) {
      await ctx.reply(shortInvalidPhoneText(), {
        ...ensurePhoneKeyboard()
      });
      return;
    }

    try {
      await saveLead(ctx, state, normalized.phone);
      state.step = "idle";
      state.pendingHotel = undefined;
      state.phonePromptShownForHotelId = undefined;

      await ctx.reply("Спасибо! Мы уже проверяем наличие 👌\nОбычно отвечаем в течение часа.", {
        ...Markup.removeKeyboard()
      });
      await ctx.reply("Пока проверяем, могу подобрать ещё варианты для сравнения.");
      await ctx.reply("Нажмите кнопку ниже, когда будете готовы:", {
        ...Markup.keyboard([[Markup.button.text("🔎 Найти ещё")]]).resize()
      });
    } catch (error) {
      await ctx.reply(`Не удалось сохранить контакт: ${String((error as Error)?.message ?? error)}`);
    }
    return;
  }

  const parsed = parseUserInput(text);
  const llmFirstTravelIntent = state.step === "idle" && isLLMActive() && looksLikeTravelIntent(text);
  const shouldOrchestrate =
    isLLMActive() && state.step === "idle" && (
      llmFirstTravelIntent ||
      looksLikeFullQuery(text) ||
      true
    );

  if (shouldOrchestrate) {
    const ruleDraft = buildRuleDraftFromText(text);
    const hasRuleCountry = typeof ruleDraft.country_id === "number";
    const hasRuleNights = Number.isFinite(Number(ruleDraft.nights_min)) && Number.isFinite(Number(ruleDraft.nights_max));
    const hasRuleBudget = Number.isFinite(Number(ruleDraft.budget_max)) && Number(ruleDraft.budget_max) > 0;
    const ambiguousBudget = detectBudgetTargetQuestion(text);
    if (ambiguousBudget !== undefined && looksLikeTravelIntent(text)) {
      state.aiMode = true;
      state.aiDraft = {
        ...(state.aiDraft ?? {}),
        ...ruleDraft
      };
      state.aiAwaiting = nextAiAwaiting(state.aiDraft ?? {});
      state.pendingBudgetClarification = { value: ambiguousBudget, mode: "ai" };
      await ctx.reply(
        `${Math.round(ambiguousBudget).toLocaleString("ru-RU")} ₽ — это максимум или ориентир около этой суммы? Напишите «до ${ambiguousBudget}» или «около ${ambiguousBudget}».`
      );
      return;
    }
    if (hasRuleCountry && hasRuleNights && hasRuleBudget) {
      const directArgs = searchToursInputSchema.parse({
        ...DEFAULT_SEARCH_TOURS_ARGS,
        ...ruleDraft,
        offset: 0
      });
      await ctx.reply("🔎 Анализирую запрос…");
      await sleep(300);
      applyOrchestratedSearchArgsToState(state, directArgs);
      state.lastSearchArgs = directArgs;
      const seq = beginSearchSeq(state);
      const output = await callSearchTours(directArgs as unknown as Record<string, unknown>);
      if (isSearchSeqStale(state, seq)) return;
      await sendCards(ctx, state, output);
      return;
    }
    const orchestrated = await withTimeout(
      handleUserMessage(text, { logger }),
      5_000,
      "orchestrator"
    ).catch(() => ({
      text: "Не успела разобрать запрос. Напишите короче или выберите страну кнопкой ниже.",
      meta: {
        intent_type: "unknown" as const,
        provider: "timeout",
        validation: "fail" as const,
        reason: "timeout",
        search_args: undefined,
        missing_fields: undefined,
        draft_args: undefined
      }
    }));

    if (orchestrated.meta.intent_type === "search_tours") {
      resetFlow(state);
      const missingFields = orchestrated.meta.missing_fields ?? [];
      const draftArgs = orchestrated.meta.draft_args;

      if (missingFields.length > 0 && draftArgs) {
        state.aiMode = true;
        state.aiDraft = draftArgs;
        state.aiAwaiting = resolveAiAwaiting(missingFields);
        state.step = "idle";
        await ctx.reply(`${aiPromptText(draftArgs)} Напишите «отмена», если хотите прервать.`);
        await askAiMissingField(ctx, state);
        return;
      }

      if (!orchestrated.meta.search_args) {
        await ctx.reply("Нужно уточнить параметры поиска. Укажите страну, ночи и бюджет.");
        return;
      }

      await ctx.reply("🔎 Анализирую запрос…");
      await sleep(600);
      await ctx.reply(buildTextQueryConfirmation(text));
      await sleep(600);
      applyOrchestratedSearchArgsToState(state, orchestrated.meta.search_args);
      state.lastSearchArgs = orchestrated.meta.search_args;
      const seq = beginSearchSeq(state);
      const output = await callSearchTours(orchestrated.meta.search_args as unknown as Record<string, unknown>);
      if (isSearchSeqStale(state, seq)) {
        return;
      }
      await sendCards(ctx, state, output);
      return;
    }

    if (orchestrated.meta.intent_type === "meta" || orchestrated.meta.intent_type === "smalltalk") {
      resetFlow(state);
      await ctx.reply(
        orchestrated.text,
        assistantUtilityKeyboard()
      );
      return;
    }

    if (orchestrated.meta.reason === "unsupported_country") {
      resetFlow(state);
      state.aiMode = true;
      state.aiDraft = {};
      state.aiAwaiting = "country";
      state.step = "idle";
      await ctx.reply(orchestrated.text, compactCountryKeyboard("ai"));
      return;
    }

    if (isLLMActive() && looksLikeTravelIntent(text)) {
      state.aiMode = true;
      state.aiDraft = {};
      state.aiAwaiting = "country";
      state.step = "idle";
      await askAiMissingField(ctx, state);
      return;
    }

    await ctx.reply(orchestrated.text);
    return;
  }

  applyParsedIntent(state, parsed);

  try {
    await continueFlow(ctx, state, chatId);
  } catch {
    await showSearchError(ctx);
  }
});

bot.action(/^more:(.+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.sendChatAction?.("typing");
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const reqid = String(ctx.match[1]);

  if (!state.lastRequestId || state.lastRequestId !== reqid) {
    await ctx.reply("Сессия устарела. Нажмите «Новый поиск».");
    return;
  }

  state.offset += state.limit;

  await runSearchWithRetry(ctx, state, chatId);
});

bot.action("filters", async (ctx: any) => {
  await ctx.answerCbQuery();
  await askFiltersMenu(ctx);
});

bot.action(/^filtermenu:(budget|rating|period|meal|back)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const target = String(ctx.match[1]) as "budget" | "rating" | "period" | "meal" | "back";

  if (target === "back") {
    if (!state.lastRequestId || state.lastResults.length === 0) {
      await ctx.reply("Нет сохраненной выдачи. Запустите поиск заново.");
      return;
    }
    await sendCards(ctx, state, { requestid: state.lastRequestId, results: state.lastResults });
    return;
  }

  state.editingFilter = target;
  state.step = "idle";

  if (target === "budget") {
    await askBudget(ctx);
    return;
  }
  if (target === "rating") {
    await askQuality(ctx);
    return;
  }
  if (target === "period") {
    await askPeriod(ctx);
    return;
  }
  await askMeal(ctx);
});

bot.action("retry", async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  await runSearchWithRetry(ctx, state, chatId, { showSearching: true });
});

bot.action("new", async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  resetSearchState(state);
  state.step = "idle";
  await askCountry(ctx);
});

bot.action("fav:save_collection", async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const saved = saveCurrentCollectionToFavorites(state);
  if (!saved) {
    await ctx.reply("Сначала выполните поиск, чтобы сохранить подборку.");
    return;
  }
  state.pendingPromptAction = "show_favorites";
  await ctx.reply("Подборка сохранена ⭐\nХотите посмотреть избранное?");
});

bot.action("fav:list", async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  state.pendingPromptAction = undefined;
  await showFavorites(ctx, state);
});

bot.action("fav:clear", async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  state.favorites = clearFavoritesStore();
  state.pendingPromptAction = undefined;
  await ctx.reply("Избранное очищено.");
});

bot.action(/^fav:tour:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const hotelId = Number(ctx.match[1]);
  const tour = state.lastResults.find((t) => Number(t.hotel_id) === hotelId);
  if (!tour) {
    await ctx.reply("Не нашла этот тур в текущей выдаче.");
    return;
  }
  const added = saveTourToFavorites(state, tour);
  await ctx.reply(added ? "Тур добавлен в избранное ⭐" : "Этот тур уже в избранном ⭐");
});

bot.action(/^fav:remove:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const hotelId = Number(ctx.match[1]);
  const removed = removeTourFromFavorites(state, hotelId);
  await ctx.reply(removed ? "Тур удалён из избранного." : "Тур уже удалён из избранного.");
});

bot.action(/^fav:open:(.+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const id = String(ctx.match[1]);
  const set = openFavoriteCollectionStore(state.favorites, id);
  if (!set) {
    await ctx.reply("Не нашла эту подборку.");
    return;
  }
  await ctx.reply(`Открываю подборку №${state.favorites.collections.findIndex((c) => c.id === id) + 1} ⭐`);
  await sendCards(ctx, state, {
    requestid: `fav-col-${id}`,
    results: set.tours as Tour[]
  });
});

bot.action(/^fav:del:(.+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const id = String(ctx.match[1]);
  const next = deleteFavoriteCollectionStore(state.favorites, id);
  state.favorites = next.favorites;
  await ctx.reply(next.removed ? "Подборка удалена." : "Подборка уже удалена.");
});

bot.action(/^want:([^:]+):(\d+)(?::([a-z]+))?$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.sendChatAction?.("typing");
  const chatId = getChatId(ctx);
  const state = getState(chatId);
  const requestid = String(ctx.match[1]);
  const hotelId = Number(ctx.match[2]);
  const sourceHint = ctx.match[3] ? String(ctx.match[3]) : undefined;
  const userId = Number(ctx.from?.id ?? chatId);
  const wantKey = `${userId}:${requestid}:${hotelId}:${sourceHint ?? "default"}`;
  const now = Date.now();
  const pendingAt = pendingWantByKey.get(wantKey);
  if (pendingAt && now - pendingAt < 45_000) {
    await ctx.reply("Уже проверяю этот тур ✅");
    return;
  }
  pendingWantByKey.set(wantKey, now);
  setTimeout(() => {
    const current = pendingWantByKey.get(wantKey);
    if (current === now) {
      pendingWantByKey.delete(wantKey);
    }
  }, 60_000);

  const selected = findTourForWantAction(state, hotelId, sourceHint);
  if (!selected) {
    pendingWantByKey.delete(wantKey);
    await ctx.reply("Не удалось найти тур. Откройте избранное или выполните поиск заново.");
    return;
  }

  if (isSamePendingHotel(state, hotelId) && state.phonePromptShownForHotelId === hotelId) {
    pendingWantByKey.delete(wantKey);
    await ctx.reply(buildPhoneHintText(), { ...ensurePhoneKeyboard() });
    return;
  }

  state.pendingHotel = selected;
  state.step = "await_phone";
  state.phonePromptShownForHotelId = undefined;

  await ctx.reply("Минутку, проверяю наличие и цену…");
  await ctx.reply(recapText(selected), { parse_mode: "HTML" });
  await ctx.reply("Отличный выбор ✨ Чтобы быстро проверить наличие и финальную цену — оставьте номер.");
  await ctx.reply(buildPhoneHintText(), {
    ...ensurePhoneKeyboard()
  });
  state.phonePromptShownForHotelId = hotelId;
});

}

bot.catch(async (err: unknown, ctx: any) => {
  logger.error(
    {
      err_message: (err as Error)?.message ?? String(err),
      callback_data: ctx?.callbackQuery?.data,
      update_type: ctx?.updateType
    },
    "[BOT] unhandled bot error"
  );
  if (ctx?.callbackQuery) {
    try {
      await ctx.answerCbQuery("Не получилось, попробуйте ещё раз");
    } catch {
      // ignore
    }
  }
});

export async function startBot(): Promise<boolean> {
  if (!BOT_ENABLED) {
    logger.info("Telegram bot: disabled");
    return false;
  }
  if (BOT_TEST_MODE) {
    return false;
  }

  try {
    const webhookInfo = await bot.telegram.getWebhookInfo();
    logger.info(
      {
        hasWebhookUrl: Boolean(webhookInfo?.url),
        pending_update_count: webhookInfo?.pending_update_count ?? 0
      },
      "[BOT] webhook info before launch"
    );
    if (process.env.TELEGRAM_DELETE_WEBHOOK === "1") {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      logger.info("[BOT] webhook deleted by TELEGRAM_DELETE_WEBHOOK=1");
    }
  } catch (err) {
    logger.warn({ err_message: (err as Error)?.message ?? String(err) }, "[BOT] failed to get/delete webhook info");
  }

  await bot.launch();

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
  return true;
}

const isEntryPoint = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "");
if (isEntryPoint) {
  if (!BOT_ENABLED && !BOT_TEST_MODE) {
    throw new Error("BOT_TOKEN or TELEGRAM_BOT_TOKEN is required");
  }
  void startBot();
} else if (process.env.LLM_DEBUG === "1") {
  logger.warn({ provider: "telegram_bot" }, "[BOT] handlers already registered, skipping duplicate init");
}

export { bot };

export const __test = {
  resetAll(): void {
    stateByChat.clear();
    pendingWantByKey.clear();
    testCallSearchToursOverride = undefined;
  },
  setSearchOverride(fn?: (args: Record<string, unknown>) => Promise<SearchOutput>): void {
    testCallSearchToursOverride = fn;
  },
  getChatState(chatId: number): Partial<ChatState> | undefined {
    const state = stateByChat.get(chatId);
    if (!state) return undefined;
    return {
      step: state.step,
      countryId: state.countryId,
      nightsMin: state.nightsMin,
      nightsMax: state.nightsMax,
      budgetMax: state.budgetMax,
      period: state.period,
      meal: state.meal,
      offset: state.offset,
      limit: state.limit,
      lastRequestId: state.lastRequestId,
      lastSearchArgs: state.lastSearchArgs,
      aiMode: state.aiMode,
      aiAwaiting: state.aiAwaiting,
      activeSearchSeq: state.activeSearchSeq,
      searchContext: state.searchContext
    };
  }
};
