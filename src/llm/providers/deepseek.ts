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
      const slice = raw.slice(first, last + 1);
      return JSON.parse(slice);
    }
    throw new Error("invalid_json");
  }
}

export class DeepSeekProvider implements NamedLLMProvider {
  public readonly providerName = "deepseek" as const;

  public constructor(
    private readonly apiKey: string | undefined,
    private readonly logger?: LoggerLike
  ) {}

  public async parseIntent(input: string): Promise<ParsedIntent> {
    if (process.env.LLM_DISABLED === "1") {
      if (isDebugEnabled() && this.logger) {
        this.logger.warn({ provider: this.providerName }, "deepseek disabled by env");
      }
      throw new Error("llm_disabled");
    }

    if (!this.apiKey) {
      if (isDebugEnabled() && this.logger) {
        this.logger.warn({ provider: this.providerName }, "deepseek api key missing");
      }
      throw new Error("missing_api_key");
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0,
          top_p: 1,
          max_tokens: 400,
          messages: [
            {
              role: "system",
              content:
                "Ты парсер интента для travel-ассистента. Верни СТРОГО JSON без markdown, без пояснений. Разрешённые type: search_tours | meta | smalltalk | unknown. Форматы: 1) {\"type\":\"search_tours\",\"args\":{...},\"confidence\":0-1} 2) {\"type\":\"meta\",\"topic\":\"capabilities|help|about|pricing|other\",\"confidence\":0-1} 3) {\"type\":\"smalltalk\",\"confidence\":0-1} 4) {\"type\":\"unknown\",\"reason\":\"...\",\"questions\":[\"...\"],\"confidence\":0-1}. args могут содержать ТОЛЬКО поля: country_id, country_name, budget_max, rating, nights_min, nights_max, period, meal, limit, offset, sort, departure_id, date_from, date_to, adults, children, destination, city_name, resort_name. Только snake_case. Никаких новых полей. Разрешённые страны только: Turkey, Egypt, Thailand, UAE, Maldives, Seychelles. Если пользователь просит другую страну — не подставляй, верни unknown с reason='unsupported_country'. Если вопрос о возможностях/помощи — верни meta. Если приветствие/болтовня без поиска — smalltalk. Если не уверен — unknown."
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
        throw new Error(`http_${res.status}`);
      }

      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };

      const rawContent = payload.choices?.[0]?.message?.content;
      if (typeof rawContent !== "string" || rawContent.trim() === "") {
        throw new Error("empty_content");
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
          { provider: this.providerName, latency_ms: Date.now() - startedAt },
          "deepseek intent parsed"
        );
      }

      return parsedIntent.data;
    } catch (err) {
      const message = (err as Error)?.message ?? "provider_error";
      if (isDebugEnabled() && this.logger) {
        this.logger.warn(
          { provider: this.providerName, latency_ms: Date.now() - startedAt, err_message: message },
          "deepseek parse failed"
        );
      }

      throw new Error("provider_error");
    } finally {
      clearTimeout(timeout);
    }
  }
}
