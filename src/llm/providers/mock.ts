import crypto from "node:crypto";

import type { LoggerLike, NamedLLMProvider, ParsedIntent, SearchArgs } from "../types.js";

const COUNTRY_MATCHERS: Array<{ token: string; value: string }> = [
  { token: "турц", value: "Turkey" },
  { token: "turkey", value: "Turkey" },
  { token: "егип", value: "Egypt" },
  { token: "egypt", value: "Egypt" },
  { token: "оаэ", value: "UAE" },
  { token: "uae", value: "UAE" },
  { token: "emirates", value: "UAE" },
  { token: "united arab emirates", value: "UAE" },
  { token: "тайл", value: "Thailand" },
  { token: "thailand", value: "Thailand" },
  { token: "мальдив", value: "Maldives" },
  { token: "maldives", value: "Maldives" },
  { token: "сейшел", value: "Seychelles" },
  { token: "seychelles", value: "Seychelles" }
];

const UNKNOWN_QUESTION_SETS: string[][] = [
  [
    "Какую страну рассматриваете?",
    "Какой бюджет на поездку?",
    "На сколько ночей планируете отдых?"
  ],
  [
    "Куда хотите поехать: Турция, Египет, ОАЭ, Таиланд, Мальдивы или Сейшелы?",
    "Какой максимум по бюджету?"
  ],
  [
    "Подскажите страну и желаемый бюджет.",
    "Нужны ли 7–10 ночей или другой диапазон?"
  ]
];

function isDebugEnabled(): boolean {
  return process.env.LLM_DEBUG === "1";
}

function hashInt(input: string): number {
  return crypto.createHash("sha1").update(input).digest().readUInt32BE(0);
}

function toLower(input: string): string {
  return input.toLowerCase().trim();
}

function parseCountry(text: string): string | undefined {
  for (const matcher of COUNTRY_MATCHERS) {
    if (text.includes(matcher.token)) {
      return matcher.value;
    }
  }
  return undefined;
}

function parseNights(text: string): number | undefined {
  const match = text.match(/(\d{1,2})\s*(ноч(?:ей|и|ь)?|nights?)/i);
  if (!match) {
    return undefined;
  }

  const nights = Number(match[1]);
  if (!Number.isFinite(nights) || nights <= 0) {
    return undefined;
  }

  return Math.min(30, Math.floor(nights));
}

function parseBudget(text: string): number | undefined {
  const direct = text.match(/до\s*(\d{2,3})\s*[кkк]/i);
  if (direct) {
    return Number(direct[1]) * 1000;
  }

  const raw = text.match(/до\s*(\d{5,7})\b/i);
  if (raw) {
    return Number(raw[1]);
  }

  return undefined;
}

function parseRating(text: string): number | undefined {
  const match = text.match(/([3-5](?:[.,]\d)?)\s*\+/i);
  if (!match) {
    return undefined;
  }

  const rating = Number(match[1].replace(",", "."));
  if (!Number.isFinite(rating)) {
    return undefined;
  }

  return Math.max(0, Math.min(5, rating));
}

function parseMeal(text: string): string | undefined {
  if (/(все\s*включено|всё\s*включено|all\s*inclusive|\bai\b)/i.test(text)) {
    return "AI";
  }
  return undefined;
}

function parsePeriod(text: string): SearchArgs["period"] | undefined {
  if (/\b(ближайш\w*\s*месяц|next\s*month)\b/i.test(text)) {
    return "next_month";
  }
  if (/\b(1\s*[–-]\s*2\s*месяц|1\s*2\s*months?)\b/i.test(text)) {
    return "1_2_months";
  }
  if (/\b(летом|summer)\b/i.test(text)) {
    return "summer";
  }
  if (/\b(осенью|autumn|fall)\b/i.test(text)) {
    return "autumn";
  }
  return undefined;
}

function buildUnknown(input: string, seed: string): ParsedIntent {
  const idx = hashInt(`${seed}:${input}`) % UNKNOWN_QUESTION_SETS.length;
  return {
    type: "unknown",
    reason: "not_enough_data",
    questions: UNKNOWN_QUESTION_SETS[idx]
  };
}

export class MockLLMProvider implements NamedLLMProvider {
  public readonly providerName = "mock" as const;

  public constructor(private readonly logger?: LoggerLike) {}

  public async parseIntent(input: string): Promise<ParsedIntent> {
    const text = toLower(input);
    const seed = String(process.env.LLM_SEED ?? "0");

    const args: SearchArgs = {};

    const country = parseCountry(text);
    if (country) {
      args.country_name = country;
    }

    const nights = parseNights(text);
    if (nights !== undefined) {
      args.nights_min = nights;
      args.nights_max = nights;
    }

    const budget = parseBudget(text);
    if (budget !== undefined) {
      args.budget_max = budget;
    }

    const rating = parseRating(text);
    if (rating !== undefined) {
      args.rating = rating;
    }

    const meal = parseMeal(text);
    if (meal) {
      args.meal = meal;
    }

    const period = parsePeriod(text);
    if (period) {
      args.period = period;
    }

    const hasArgs = Object.keys(args).length > 0;
    const intent: ParsedIntent = hasArgs
      ? { type: "search_tours", args, confidence: 0.74 }
      : buildUnknown(text, seed);

    if (isDebugEnabled() && this.logger) {
      this.logger.debug({ provider: this.providerName, input, intent }, "llm mock intent parsed");
    }

    return intent;
  }
}
