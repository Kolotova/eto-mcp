import { getLLMProvider } from "./llm/index.js";
import { ParsedIntentSchema } from "./llm/types.js";
import { parseQuery } from "./nlu/parseQuery.js";
import { searchToursInputSchema, type SearchToursInput } from "./schemas.js";
import { DEFAULT_SEARCH_TOURS_ARGS } from "./searchDefaults.js";
import type { LoggerLike, NamedLLMProvider, ParsedIntent, SearchArgs } from "./llm/types.js";

const COUNTRY_TO_ID: Record<string, number> = {
  Turkey: 47,
  Egypt: 54,
  Thailand: 29,
  UAE: 63,
  Maldives: 90,
  Seychelles: 91
};
export const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_TO_ID) as Array<keyof typeof COUNTRY_TO_ID>;

type MissingField = "country" | "nights" | "budget";
type MonthIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

function buildSearchArgs(args: SearchArgs): SearchToursInput {
  const merged = {
    ...DEFAULT_SEARCH_TOURS_ARGS,
    ...args
  };

  if (merged.country_id === undefined && merged.country_name && COUNTRY_TO_ID[merged.country_name]) {
    merged.country_id = COUNTRY_TO_ID[merged.country_name];
  }

  return searchToursInputSchema.parse(merged);
}

function debug(logger?: LoggerLike, obj?: unknown, msg?: string): void {
  if (process.env.LLM_DEBUG === "1" && logger) {
    logger.debug(obj ?? {}, msg);
  }
}

function warn(logger?: LoggerLike, obj?: unknown, msg?: string): void {
  if (process.env.LLM_DEBUG === "1" && logger) {
    logger.warn(obj ?? {}, msg);
  }
}

function formatUnknown(intent: ParsedIntent): string {
  const fallbackQuestions = [
    "Какую страну хотите рассмотреть?",
    "Какой бюджет планируете?"
  ];
  const questions = intent.type === "unknown" && intent.questions && intent.questions.length > 0
    ? intent.questions.slice(0, 3)
    : fallbackQuestions;

  const lines = [
    "Я могу подобрать тур, но нужно немного уточнений:",
    ...questions.map((question) => `• ${question}`),
    "",
    "Пример: Турция на 7 ночей до 120к, всё включено"
  ];

  return lines.join("\n");
}

function extractNightsFromText(input: string): number | undefined {
  return parseQuery(input).params.nights;
}

function extractBudgetFromText(input: string): number | undefined {
  const budget = parseQuery(input).params.budget;
  if (!budget) return undefined;
  return budget.max;
}

function extractBudgetRangeFromText(input: string): { min: number; max: number } | undefined {
  const budget = parseQuery(input).params.budget;
  if (!budget || (budget.type !== "range" && budget.type !== "approx")) return undefined;
  return { min: budget.min, max: budget.max };
}

export function detectBudgetTargetPhrase(input: string): number | undefined {
  const t = input.toLowerCase();
  const explicitTarget = /(около|примерно|в районе|порядка|~|≈)\s*\d/i.test(t);
  if (!explicitTarget && !/(за)\s*\d/i.test(t) && !/\?/.test(t)) {
    return undefined;
  }
  const budget = parseQuery(input).params.budget;
  if (!budget) return undefined;
  return budget.type === "approx" ? budget.value : budget.max;
}

function extractAdultsFromText(input: string): number | undefined {
  const text = input.toLowerCase();
  if (text.includes("на двоих") || text.includes("2 взрослых") || text.includes("два взрослых")) {
    return 2;
  }
  return undefined;
}

function getMonthRangeFor2026(input: string): { from: string; to: string } | undefined {
  const pq = parseQuery(input);
  if (pq.params.dateFrom && pq.params.dateTo) {
    return { from: pq.params.dateFrom, to: pq.params.dateTo };
  }
  const text = input.toLowerCase();
  if (/\b0?9\b/.test(text)) {
    return { from: "2026-09-01", to: "2026-09-30" };
  }
  const monthByToken: Array<{ token: string; month: MonthIndex }> = [
    { token: "январ", month: 0 },
    { token: "феврал", month: 1 },
    { token: "март", month: 2 },
    { token: "апрел", month: 3 },
    { token: "май", month: 4 },
    { token: "июн", month: 5 },
    { token: "июл", month: 6 },
    { token: "август", month: 7 },
    { token: "сентябр", month: 8 },
    { token: "октябр", month: 9 },
    { token: "ноябр", month: 10 },
    { token: "декабр", month: 11 }
  ];

  const matched = monthByToken.find(({ token }) => text.includes(token));
  if (!matched) {
    return undefined;
  }

  const month = matched.month;
  const from = new Date(Date.UTC(2026, month, 1));
  const to = new Date(Date.UTC(2026, month + 1, 0));
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);

  return { from: fromIso, to: toIso };
}

function extractPeriodFromText(input: string): SearchToursInput["period"] | undefined {
  const text = input.toLowerCase();
  if (text.includes("летом")) return "summer";
  if (text.includes("осенью")) return "autumn";
  if (text.includes("через 1-2") || text.includes("через 1–2") || text.includes("через 1 2")) return "1_2_months";
  if (text.includes("через месяц") || text.includes("в следующем месяце") || text.includes("в ближайший месяц")) return "next_month";
  return undefined;
}

export function normalizeCountryName(countryName: unknown): keyof typeof COUNTRY_TO_ID | undefined {
  if (typeof countryName !== "string") {
    return undefined;
  }
  const lower = countryName.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower === "turkey" || lower.includes("турц")) return "Turkey";
  if (lower === "egypt" || lower.includes("егип")) return "Egypt";
  if (lower === "uae" || lower.includes("оаэ") || lower.includes("эмират") || lower.includes("дубай") || lower.includes("emirates")) return "UAE";
  if (lower === "thailand" || lower.includes("тай") || lower.includes("таил")) return "Thailand";
  if (lower === "maldives" || lower.includes("мальдив")) return "Maldives";
  if (lower === "seychelles" || lower.includes("сейшел")) return "Seychelles";
  return undefined;
}

function getMappedCountryId(countryName: unknown): number | undefined {
  const normalized = normalizeCountryName(countryName);
  return normalized ? COUNTRY_TO_ID[normalized] : undefined;
}

function detectCountryNameFromText(input: string): keyof typeof COUNTRY_TO_ID | undefined {
  return normalizeCountryName(input);
}

function buildDraftArgs(input: string, args: SearchArgs): Partial<SearchToursInput> {
  const draft: Partial<SearchToursInput> = {
    ...args
  };

  const countryId = getMappedCountryId(args.country_name);
  if (draft.country_id === undefined && countryId !== undefined) {
    draft.country_id = countryId;
  }
  if (countryId !== undefined) {
    draft.country_name = SUPPORTED_COUNTRIES.find((name) => COUNTRY_TO_ID[name] === countryId);
  }
  if (draft.country_id === undefined && draft.country_name === undefined) {
    const detectedCountry = detectCountryNameFromText(input);
    if (detectedCountry) {
      draft.country_name = detectedCountry;
      draft.country_id = COUNTRY_TO_ID[detectedCountry];
    }
  }

  if (draft.nights_min === undefined || draft.nights_max === undefined) {
    const nights = extractNightsFromText(input);
    if (nights !== undefined) {
      draft.nights_min = nights;
      draft.nights_max = nights;
    }
  }

  const budgetRange = extractBudgetRangeFromText(input);
  if ((draft.budget_max === undefined || draft.budget_max <= 0) && budgetRange) {
    draft.budget_min = budgetRange.min;
    draft.budget_max = budgetRange.max;
  }

  if (draft.budget_max === undefined || draft.budget_max <= 0) {
    const budget = extractBudgetFromText(input);
    if (budget !== undefined) {
      draft.budget_max = budget;
    }
  }

  if (draft.adults === undefined) {
    const adults = extractAdultsFromText(input);
    if (adults !== undefined) {
      draft.adults = adults;
    }
  }

  if (draft.date_from === undefined || draft.date_to === undefined) {
    const monthRange = getMonthRangeFor2026(input);
    if (monthRange) {
      draft.date_from = monthRange.from;
      draft.date_to = monthRange.to;
    }
  }

  if (draft.period === undefined) {
    const period = extractPeriodFromText(input);
    if (period) {
      draft.period = period;
    }
  }

  return draft;
}

function getMissingFields(draft: Partial<SearchToursInput>): MissingField[] {
  const missing: MissingField[] = [];
  const hasCountry = typeof draft.country_id === "number" || (typeof draft.country_name === "string" && draft.country_name.trim() !== "");
  const hasNights = Number.isFinite(Number(draft.nights_min)) && Number.isFinite(Number(draft.nights_max));
  const hasBudget = Number.isFinite(Number(draft.budget_max)) && Number(draft.budget_max) > 0;

  if (!hasCountry) {
    missing.push("country");
  }
  if (!hasNights) {
    missing.push("nights");
  }
  if (!hasBudget) {
    missing.push("budget");
  }

  return missing;
}

function looksLikeTravelText(input: string): boolean {
  const t = input.toLowerCase();
  return t.includes("тур") || t.includes("отпуск") || t.includes("поехать") || t.includes("хочу");
}

type OrchestratorMeta = {
  intent_type: ParsedIntent["type"];
  provider: string;
  validation: "ok" | "fail";
  reason?: string;
  search_args?: SearchToursInput;
  missing_fields?: MissingField[];
  draft_args?: Partial<SearchToursInput>;
};

type OrchestratorResult = {
  text: string;
  meta: OrchestratorMeta;
};

export type HandleUserMessageDeps = {
  logger?: LoggerLike;
  provider?: NamedLLMProvider;
};

function unsupportedCountryText(): string {
  return "Пока могу искать только по: Турция, Египет, Таиланд, ОАЭ, Мальдивы, Сейшелы. Какую выбираете?";
}

function hasUnsupportedDestinationMention(input: string): boolean {
  const t = input.toLowerCase();
  if (normalizeCountryName(t)) return false;
  return (
    t.includes("африк") ||
    t.includes("africa") ||
    t.includes("вьет") ||
    t.includes("vietnam") ||
    t.includes("росси") ||
    t.includes("russia") ||
    t.includes("итал") ||
    t.includes("italy") ||
    t.includes("австрал") ||
    t.includes("australia") ||
    t.includes("испан") ||
    t.includes("spain")
  );
}

export async function handleUserMessage(
  input: string,
  deps: HandleUserMessageDeps
): Promise<OrchestratorResult> {
  const provider = deps.provider ?? getLLMProvider(deps.logger);

  let intentRaw: ParsedIntent;
  try {
    intentRaw = await provider.parseIntent(input);
  } catch (err) {
    warn(deps.logger, { err }, "[ORCH] provider.parseIntent failed");
    intentRaw = { type: "unknown", reason: "provider_error" };
  }

  const parsedIntent = ParsedIntentSchema.safeParse(intentRaw);
  const intent: ParsedIntent = parsedIntent.success
    ? parsedIntent.data
    : { type: "unknown", reason: "invalid_intent" };

  debug(
    deps.logger,
    {
      provider: provider.providerName,
      intent_type: intent.type,
      reason: intent.type === "unknown" ? intent.reason : undefined
    },
    "[ORCH] provider output"
  );

  if (hasUnsupportedDestinationMention(input)) {
    return {
      text: unsupportedCountryText(),
      meta: {
        intent_type: "unknown",
        provider: provider.providerName,
        validation: parsedIntent.success ? "ok" : "fail",
        reason: "unsupported_country"
      }
    };
  }

  if (intent.type === "search_tours") {
    try {
      if (intent.args.country_name !== undefined && normalizeCountryName(intent.args.country_name) === undefined) {
        return {
          text: unsupportedCountryText(),
          meta: {
            intent_type: "unknown",
            provider: provider.providerName,
            validation: parsedIntent.success ? "ok" : "fail",
            reason: "unsupported_country"
          }
        };
      }

      const draftArgs = buildDraftArgs(input, intent.args);
      const missingFields = getMissingFields(draftArgs);
      const args = buildSearchArgs(draftArgs);
      debug(deps.logger, { args }, "[ORCH] search_tours args prepared");
      return {
        text: "",
        meta: {
          intent_type: "search_tours",
          provider: provider.providerName,
          validation: parsedIntent.success ? "ok" : "fail",
          reason: undefined,
          search_args: missingFields.length === 0 ? args : undefined,
          missing_fields: missingFields,
          draft_args: draftArgs
        }
      };
    } catch (err) {
      warn(deps.logger, { err }, "[ORCH] search_tours failed");
      return {
        text: "Не получилось запустить поиск. Уточните страну, бюджет и ночи, и попробуем ещё раз.",
        meta: {
          intent_type: "unknown",
          provider: provider.providerName,
          validation: parsedIntent.success ? "ok" : "fail"
        }
      };
    }
  }

  if (intent.type === "meta") {
    return {
      text: "Я помогу подобрать тур по одной из стран: Турция, Египет, Таиланд, ОАЭ, Мальдивы, Сейшелы. Напишите, например: «Турция на 7 ночей до 120 000 ₽, всё включено».",
      meta: {
        intent_type: "meta",
        provider: provider.providerName,
        validation: parsedIntent.success ? "ok" : "fail"
      }
    };
  }

  if (intent.type === "smalltalk") {
    return {
      text: "Привет! Я помогу подобрать тур. Напишите, например: «Турция на 7 ночей до 120 000 ₽, всё включено» или нажмите «🔎 Найти тур».",
      meta: {
        intent_type: "smalltalk",
        provider: provider.providerName,
        validation: parsedIntent.success ? "ok" : "fail"
      }
    };
  }

  if (intent.type === "unknown") {
    const detectedCountry = detectCountryNameFromText(input);
    if (detectedCountry) {
      try {
        const draftArgs = buildDraftArgs(input, { country_name: detectedCountry });
        const missingFields = getMissingFields(draftArgs);
        return {
          text: "",
          meta: {
            intent_type: "search_tours",
            provider: provider.providerName,
            validation: parsedIntent.success ? "ok" : "fail",
            reason: intent.reason,
            search_args: undefined,
            missing_fields: missingFields,
            draft_args: draftArgs
          }
        };
      } catch (err) {
        warn(deps.logger, { err }, "[ORCH] unknown-country fallback failed");
      }
    }

    if (looksLikeTravelText(input)) {
      const draftArgs: Partial<SearchToursInput> = {};
      return {
        text: "",
        meta: {
          intent_type: "search_tours",
          provider: provider.providerName,
          validation: parsedIntent.success ? "ok" : "fail",
          reason: intent.reason,
          search_args: undefined,
          missing_fields: getMissingFields(draftArgs),
          draft_args: draftArgs
        }
      };
    }
  }

  return {
    text: intent.type === "unknown" && intent.reason === "unsupported_country" ? unsupportedCountryText() : formatUnknown(intent),
    meta: {
      intent_type: "unknown",
      provider: provider.providerName,
      validation: parsedIntent.success ? "ok" : "fail",
      reason: intent.type === "unknown" ? intent.reason : undefined
    }
  };
}
