export type SupportedCountry = "Turkey" | "Egypt" | "Thailand" | "UAE" | "Maldives" | "Seychelles";
export type MealCode = "AI" | "BB" | "HB" | "FB" | "RO";
export type ParsedCommand = "SHOW_MORE" | "EDIT_FILTERS" | "NEW_SEARCH" | "COUNTRIES" | "START_SEARCH" | "FAVORITES" | "CLEAR_FAVORITES";
export type BudgetIntent =
  | { type: "max"; max: number }
  | { type: "range"; min: number; max: number }
  | { type: "approx"; value: number; min: number; max: number };

export type ParsedQuery = {
  command?: ParsedCommand;
  params: {
    country?: SupportedCountry;
    unknownCountry?: string;
    nights?: number;
    budget?: BudgetIntent;
    meal?: MealCode;
    month?: number;
    year?: number;
    dateFrom?: string;
    dateTo?: string;
  };
  smalltalk?: boolean;
};

const APPROX_PCT = 0.1;
const DEFAULT_SEARCH_YEAR = 2026;
const MONTH_LABELS_RU: Record<number, string[]> = {
  1: ["январ", "январе", "янв"],
  2: ["феврал", "феврале", "фев"],
  3: ["март", "марте", "мар"],
  4: ["апрел", "апреле", "апр"],
  5: ["май", "мая", "мае", "майские"],
  6: ["июн", "июня", "июне", "июнь"],
  7: ["июл", "июля", "июле", "июль"],
  8: ["август", "августе", "авг"],
  9: ["сентябр", "сентябре", "сент", "сен"],
  10: ["октябр", "октябре", "окт"],
  11: ["ноябр", "ноябре", "ноя"],
  12: ["декабр", "декабре", "дек"]
};

const COUNTRY_ALIASES: Array<{ country: SupportedCountry; patterns: RegExp[] }> = [
  { country: "Turkey", patterns: [/\bturkey\b/i, /турц/i] },
  { country: "Egypt", patterns: [/\begypt\b/i, /егип/i] },
  { country: "Thailand", patterns: [/\bthailand\b/i, /таил/i, /(^|\s)тай(?!п)/i] },
  { country: "UAE", patterns: [/\buae\b/i, /оаэ/i, /эмират/i, /\bemirates\b/i, /дубай/i] },
  { country: "Maldives", patterns: [/\bmaldives\b/i, /мальдив/i] },
  { country: "Seychelles", patterns: [/\bseychelles\b/i, /сейшел/i] }
];

const UNSUPPORTED_GEO_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "Африка", pattern: /африк|\bafrica\b/i },
  { label: "Италия", pattern: /итал|\bitaly\b/i },
  { label: "Франция", pattern: /франц|\bfrance\b/i },
  { label: "Россия", pattern: /росси|\brussia\b/i },
  { label: "Вьетнам", pattern: /вьет|\bvietnam\b/i },
  { label: "Австралия", pattern: /австрал|\baustralia\b/i },
  { label: "Испания", pattern: /испан|\bspain\b/i },
  { label: "Греция", pattern: /грец|\bgreece\b/i }
];

function normalizeText(input: string): string {
  return input
    .replace(/ё/g, "е")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\u00a0|\u2009|\u202f/g, " ")
    .trim();
}

function normalizeLower(input: string): string {
  return normalizeText(input).toLowerCase();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function monthToDateRange(month: number, year?: number): { month: number; year: number; dateFrom: string; dateTo: string } | null {
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  const y = Number.isFinite(Number(year)) ? Number(year) : DEFAULT_SEARCH_YEAR;
  const lastDay = daysInMonth(y, month);
  return {
    month,
    year: y,
    dateFrom: `${y}-${pad2(month)}-01`,
    dateTo: `${y}-${pad2(month)}-${pad2(lastDay)}`
  };
}

export function parseMonthRu(text: string): { month: number; year?: number } | null {
  const t = normalizeLower(text);
  let detectedMonth: number | undefined;

  for (const [monthStr, tokens] of Object.entries(MONTH_LABELS_RU)) {
    const month = Number(monthStr);
    if (tokens.some((token) => t.includes(token))) {
      detectedMonth = month;
      break;
    }
  }

  const numericMonth = t.match(/(?:^|\s)(?:в|на)?\s*(0?[1-9]|1[0-2])(?:\s*(?:мес(?:яц)?|месяце)?)?(?:\s|$)/i);
  if (!detectedMonth && numericMonth) {
    detectedMonth = Number(numericMonth[1]);
  }

  if (!detectedMonth) return null;

  let detectedYear: number | undefined;
  const fullYearMatch = t.match(/\b(20\d{2})\b/);
  if (fullYearMatch) {
    detectedYear = Number(fullYearMatch[1]);
  } else {
    const shortNearMonth = t.match(/(?:янв|фев|мар|апр|май|июн|июл|авг|сен|сент|окт|ноя|дек)[^\d]{0,4}(\d{2})\b|\b(\d{2})[^\d]{0,4}(?:янв|фев|мар|апр|май|июн|июл|авг|сен|сент|окт|ноя|дек)/i);
    const yy = shortNearMonth?.[1] ?? shortNearMonth?.[2];
    if (yy) {
      const n = Number(yy);
      if (n >= 20 && n <= 99) {
        detectedYear = 2000 + n;
      }
    }
  }

  return { month: detectedMonth, year: detectedYear };
}

export function extractCountry(text: string): { country?: SupportedCountry; unknownCountry?: string } {
  const normalized = normalizeText(text);
  for (const item of COUNTRY_ALIASES) {
    if (item.patterns.some((p) => p.test(normalized))) {
      return { country: item.country };
    }
  }
  for (const item of UNSUPPORTED_GEO_PATTERNS) {
    if (item.pattern.test(normalized)) {
      return { unknownCountry: item.label };
    }
  }
  return {};
}

export function extractNights(text: string): number | undefined {
  const t = normalizeLower(text);
  if (t.includes("на выходные")) return 3;
  if (t.includes("на неделю")) return 7;
  if (t.includes("две недели")) return 14;

  const direct = t.match(/(?:на\s*)?(\d{1,2})\s*(?:ноч(?:ей|и|ь)?|дн(?:ей|я)?|дн(?=\s|$)|д(?=\s|$)|сут(?:ок|ки)?)/i);
  if (direct) {
    const value = Number(direct[1]);
    if (Number.isFinite(value) && value >= 1 && value <= 30) return Math.floor(value);
  }

  const shorthand = t.match(/(?:^|\s)(\d{1,2})\s*(?:н|д|дн)(?=\s|$)/i);
  if (shorthand) {
    const value = Number(shorthand[1]);
    if (Number.isFinite(value) && value >= 1 && value <= 30) return Math.floor(value);
  }

  return undefined;
}

function parseMoneyToken(token: string, forceThousands?: boolean): number | undefined {
  const raw = normalizeLower(token)
    .replace(/руб(?:лей|ля)?|р\.?/g, "")
    .replace(/₽/g, "")
    .trim();
  if (!raw) return undefined;

  const hasThousands = forceThousands || /(тыс|тысяч|т\.?р\.?|\bт\b|кк?|k)/i.test(raw);
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return undefined;
  const num = Number(digits);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const value = hasThousands ? num * 1000 : num;
  return Math.round(value);
}

function round100(n: number): number {
  return Math.round(n / 100) * 100;
}

export function extractBudget(text: string): BudgetIntent | undefined {
  const original = normalizeText(text);
  const t = normalizeLower(text);

  const rangeFromTo = t.match(/(?:от|с)\s*([\d\s.,]+(?:к|k|тыс|тысяч|т\.?р\.?|т)?)\s*(?:до|по)\s*([\d\s.,]+(?:к|k|тыс|тысяч|т\.?р\.?|т)?)/i);
  if (rangeFromTo) {
    const leftHasK = /(к|k|тыс|тысяч|т\.?р\.?|\bт\b)/i.test(rangeFromTo[1]);
    const rightHasK = /(к|k|тыс|тысяч|т\.?р\.?|\bт\b)/i.test(rangeFromTo[2]);
    const sharedThousands = leftHasK || rightHasK;
    const a = parseMoneyToken(rangeFromTo[1], sharedThousands && !leftHasK);
    const b = parseMoneyToken(rangeFromTo[2], sharedThousands && !rightHasK);
    if (a && b) {
      return { type: "range", min: Math.min(a, b), max: Math.max(a, b) };
    }
  }

  const dashRange = original.match(/([\d\s]+(?:к|k|тыс|тысяч|т\.?р\.?|т)?)\s*-\s*([\d\s]+(?:к|k|тыс|тысяч|т\.?р\.?|т)?)/i);
  if (dashRange) {
    const leftHasK = /(к|k|тыс|тысяч|т\.?р\.?|\bт\b)/i.test(dashRange[1]);
    const rightHasK = /(к|k|тыс|тысяч|т\.?р\.?|\bт\b)/i.test(dashRange[2]);
    const sharedThousands = leftHasK || rightHasK;
    const a = parseMoneyToken(dashRange[1], sharedThousands && !leftHasK);
    const b = parseMoneyToken(dashRange[2], sharedThousands && !rightHasK);
    if (a && b) {
      return { type: "range", min: Math.min(a, b), max: Math.max(a, b) };
    }
  }

  const maxMatch = t.match(/(?:до|<=|не\s*больше|макс(?:имум)?)\s*([\d\s]+(?:к|k|тыс|тысяч|т\.?р\.?|т)?)/i);
  if (maxMatch) {
    const value = parseMoneyToken(maxMatch[1]);
    if (value) return { type: "max", max: value };
  }

  const approxMatch = t.match(/(?:около|примерно|прибл(?:изительно)?|порядка|~|≈)\s*([\d\s]+(?:к|k|тыс|тысяч|т\.?р\.?|т)?)/i);
  if (approxMatch) {
    const value = parseMoneyToken(approxMatch[1]);
    if (value) {
      const min = round100(value * (1 - APPROX_PCT));
      const max = round100(value * (1 + APPROX_PCT));
      return { type: "approx", value, min: Math.min(min, max), max: Math.max(min, max) };
    }
  }

  const approxTrailing = t.match(/([\d\s]+(?:к|k|тыс|тысяч|т\.?р\.?|т)?)\s*(?:примерно|прибл(?:изительно)?|около)\b/i);
  if (approxTrailing) {
    const value = parseMoneyToken(approxTrailing[1]);
    if (value) {
      const min = round100(value * (1 - APPROX_PCT));
      const max = round100(value * (1 + APPROX_PCT));
      return { type: "approx", value, min: Math.min(min, max), max: Math.max(min, max) };
    }
  }

  const bareMoney = t.match(/(?:^|\s)(\d{2,3}(?:\s?\d{3})?|\d{5,7})\s*(к|k|тыс|тысяч|т\.?р\.?|т)?(?:\s|$|\?)/i);
  if (bareMoney) {
    const value = parseMoneyToken(`${bareMoney[1]}${bareMoney[2] ?? ""}`);
    if (value) {
      // Default heuristic: bare number => approx (more human-friendly)
      const min = round100(value * (1 - APPROX_PCT));
      const max = round100(value * (1 + APPROX_PCT));
      return { type: "approx", value, min: Math.min(min, max), max: Math.max(min, max) };
    }
  }

  return undefined;
}

export function extractMeal(text: string): MealCode | undefined {
  const t = normalizeLower(text);
  if (t.includes("все включ") || t.includes("всё включ") || t.includes("all inclusive") || /\bai\b/i.test(t)) return "AI";
  if (t.includes("без питания") || /\bro\b/i.test(t)) return "RO";
  if (t.includes("завтрак") || /\bbb\b/i.test(t)) return "BB";
  if (t.includes("полупансион") || /\bhb\b/i.test(t)) return "HB";
  if (t.includes("полный пансион") || /\bfb\b/i.test(t)) return "FB";
  return undefined;
}

export function detectCommand(text: string): ParsedCommand | undefined {
  const t = normalizeLower(text);
  if (/^(?:↩︎\s*)?показать\s*ещ[еёe]$/.test(t) || /^(?:ещ[еёe])$/.test(t)) return "SHOW_MORE";
  if (/^изменить\s+фильтры$/.test(t) || /^фильтры$/.test(t)) return "EDIT_FILTERS";
  if (/^очистить\s+избранное$/.test(t)) return "CLEAR_FAVORITES";
  if (/^избранное$/.test(t) || /^покажи\s+избранное$/.test(t) || /^мои\s+туры$/.test(t)) return "FAVORITES";
  if (/^новый\s+поиск$/.test(t) || /^сброс$/.test(t)) return "NEW_SEARCH";
  if (/^страны$/.test(t)) return "COUNTRIES";
  if (/^найти\s+тур$/.test(t) || /^поиск$/.test(t)) return "START_SEARCH";
  return undefined;
}

export function detectSmalltalk(text: string): boolean {
  const t = normalizeLower(text);
  return (
    t === "спасибо" || t === "спс" || t === "благодарю" || t === "пожалуйста" ||
    t === "ок" || t === "окей" || t === "ага" || t === "понятно" || t === "привет" ||
    /^\)+$/.test(t) || /^\(+$/.test(t) || /^аха+$/.test(t)
  );
}

export function parseQuery(text: string): ParsedQuery {
  const command = detectCommand(text);
  const country = extractCountry(text);
  const nights = extractNights(text);
  const budget = extractBudget(text);
  const meal = extractMeal(text);
  const month = parseMonthRu(text);
  const monthRange = month ? monthToDateRange(month.month, month.year) : null;
  const smalltalk = detectSmalltalk(text);

  return {
    command,
    params: {
      country: country.country,
      unknownCountry: country.unknownCountry,
      nights,
      budget,
      meal,
      month: month?.month,
      year: month?.year,
      dateFrom: monthRange?.dateFrom,
      dateTo: monthRange?.dateTo
    },
    smalltalk: smalltalk || undefined
  };
}
