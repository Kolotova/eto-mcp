import type { LoggerLike, NamedLLMProvider, ParsedIntent } from "../types.js";

function isDebugEnabled(): boolean {
  return process.env.LLM_DEBUG === "1";
}

export class OpenAIProvider implements NamedLLMProvider {
  public readonly providerName = "openai" as const;

  public constructor(
    private readonly apiKey: string | undefined,
    private readonly logger?: LoggerLike
  ) {}

  public async parseIntent(_input: string): Promise<ParsedIntent> {
    if (!this.apiKey) {
      if (isDebugEnabled() && this.logger) {
        this.logger.warn({ provider: this.providerName }, "openai api key missing, returning unknown intent");
      }
      return {
        type: "unknown",
        reason: "openai_api_key_missing"
      };
    }

    return {
      type: "unknown",
      reason: "openai_not_implemented"
    };
  }
}
