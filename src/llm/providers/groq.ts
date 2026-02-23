import { fetch } from "undici";

import { ParsedIntentSchema } from "../types.js";
import type { LoggerLike, NamedLLMProvider, ParsedIntent } from "../types.js";

function isDebugEnabled(): boolean {
  return process.env.LLM_DEBUG === "1";
}

function extractJsonPayload(rawContent: string): unknown {
  const trimmed = rawContent.trim();
  let raw = trimmed;
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
    throw new Error("invalid_json");
  }
}

export class GroqProvider implements NamedLLMProvider {
  public readonly providerName = "groq" as const;

  public constructor(
    private readonly apiKey: string | undefined,
    private readonly logger?: LoggerLike
  ) {}

  public async parseIntent(input: string): Promise<ParsedIntent> {
    if (process.env.LLM_DISABLED === "1") {
      if (isDebugEnabled() && this.logger) {
        this.logger.warn({ provider: this.providerName }, "groq disabled by env");
      }
      return { type: "unknown", reason: "provider_error" };
    }

    if (!this.apiKey) {
      if (isDebugEnabled() && this.logger) {
        this.logger.warn({ provider: this.providerName }, "groq api key missing");
      }
      return { type: "unknown", reason: "provider_error" };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const model = process.env.GROQ_MODEL ?? "llama-3.1-8b-instant";

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          top_p: 1,
          max_tokens: 400,
          messages: [
            {
              role: "system",
              content:
                "Ты парсер интента для travel-ассистента. Верни ТОЛЬКО чистый JSON без markdown и без пояснений. Разрешённые type: search_tours | meta | smalltalk | unknown. Форматы: {\"type\":\"search_tours\",\"args\":{...},\"confidence\":0..1}, {\"type\":\"meta\",\"topic\":\"capabilities|help|about|pricing|other\",\"confidence\":0..1}, {\"type\":\"smalltalk\",\"confidence\":0..1}, {\"type\":\"unknown\",\"reason\":\"...\",\"questions\":[\"...\"],\"confidence\":0..1}. args могут содержать только поля search_tours schema в snake_case: country_id, country_name, budget_max, rating, nights_min, nights_max, period, meal, limit, offset, sort, departure_id, date_from, date_to, adults, children, destination, city_name, resort_name. Никаких новых полей. Разрешённые страны только: Turkey, Egypt, Thailand, UAE, Maldives, Seychelles. RU->country_name: Турция/Турцию/турц*=>Turkey; Египет/егип*=>Egypt; ОАЭ/Эмираты/Дубай=>UAE; Таиланд/тай*=>Thailand; Мальдивы/мальдив*=>Maldives; Сейшелы/сейшел*=>Seychelles. Если пользователь просит страну вне списка (например Vietnam/Вьетнам) — НЕ подставляй другую страну, верни unknown reason='unsupported_country'. Маппинги: '7 ночей' => nights_min=7,nights_max=7; 'до 120к' => budget_max=120000; '4+' => rating=4; 'всё включено' => meal='AI'. 'что ты умеешь' => meta(topic='capabilities'). 'привет' / болтовня без поиска => smalltalk. Если не уверен — unknown."
            },
            {
              role: "user",
              content: input
            }
          ]
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        if (isDebugEnabled() && this.logger) {
          this.logger.warn(
            { provider: this.providerName, latency_ms: Date.now() - startedAt, status: res.status },
            "groq http error"
          );
        }
        return { type: "unknown", reason: "provider_error" };
      }

      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const rawContent = payload.choices?.[0]?.message?.content;
      if (typeof rawContent !== "string" || rawContent.trim() === "") {
        return { type: "unknown", reason: "invalid_intent" };
      }

      let parsedJson: unknown;
      try {
        parsedJson = extractJsonPayload(rawContent);
      } catch {
        return { type: "unknown", reason: "invalid_intent" };
      }

      const parsedIntent = ParsedIntentSchema.safeParse(parsedJson);
      if (!parsedIntent.success) {
        return { type: "unknown", reason: "invalid_intent" };
      }

      if (isDebugEnabled() && this.logger) {
        this.logger.debug(
          { provider: this.providerName, latency_ms: Date.now() - startedAt, model },
          "groq intent parsed"
        );
      }

      return parsedIntent.data;
    } catch (err) {
      if (isDebugEnabled() && this.logger) {
        this.logger.warn(
          {
            provider: this.providerName,
            latency_ms: Date.now() - startedAt,
            err_message: (err as Error)?.message ?? String(err)
          },
          "groq parse failed"
        );
      }
      return { type: "unknown", reason: "provider_error" };
    } finally {
      clearTimeout(timeout);
    }
  }
}
