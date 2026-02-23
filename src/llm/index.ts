import { DeepSeekProvider } from "./providers/deepseek.js";
import { GroqProvider } from "./providers/groq.js";
import { MockLLMProvider } from "./providers/mock.js";
import { OpenAIProvider } from "./providers/openai.js";
import type { LoggerLike, NamedLLMProvider } from "./types.js";

function isDebugEnabled(): boolean {
  return process.env.LLM_DEBUG === "1";
}

function debugLog(logger: LoggerLike | undefined, payload: Record<string, unknown>, message: string): void {
  if (!isDebugEnabled() || !logger) {
    return;
  }
  logger.debug(payload, message);
}

export function getLLMProvider(logger?: LoggerLike): NamedLLMProvider {
  const disabled = process.env.LLM_DISABLED === "1";
  const requested = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();

  if (disabled || requested === "mock") {
    debugLog(logger, { provider: "mock", disabled }, "llm provider selected");
    return new MockLLMProvider(logger);
  }

  if (requested === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      debugLog(logger, { requested: "openai", fallback: "mock" }, "llm provider fallback");
      return new MockLLMProvider(logger);
    }
    return new OpenAIProvider(process.env.OPENAI_API_KEY, logger);
  }

  if (requested === "deepseek") {
    if (!process.env.DEEPSEEK_API_KEY) {
      debugLog(logger, { requested: "deepseek", fallback: "mock" }, "llm provider fallback");
      return new MockLLMProvider(logger);
    }
    return new DeepSeekProvider(process.env.DEEPSEEK_API_KEY, logger);
  }

  if (requested === "groq") {
    if (disabled || !process.env.GROQ_API_KEY) {
      debugLog(logger, { requested: "groq", fallback: "mock", disabled }, "llm provider fallback");
      return new MockLLMProvider(logger);
    }
    return new GroqProvider(process.env.GROQ_API_KEY, logger);
  }

  debugLog(logger, { requested, fallback: "mock" }, "llm provider unknown, fallback");
  return new MockLLMProvider(logger);
}
