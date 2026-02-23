import { z } from "zod";

import { searchToursInputSchema } from "../schemas.js";

const base = searchToursInputSchema.shape;

export const SearchArgsSchema = z.object({
  country_name: base.country_name.optional(),
  budget_max: base.budget_max.optional(),
  rating: base.rating.optional(),
  nights_min: base.nights_min.optional(),
  nights_max: base.nights_max.optional(),
  period: base.period.optional(),
  meal: base.meal.optional(),
  limit: base.limit.optional(),
  offset: base.offset.optional(),
  sort: base.sort.optional(),
  departure_id: base.departure_id.optional(),
  date_from: base.date_from.optional(),
  date_to: base.date_to.optional(),
  adults: base.adults.optional(),
  children: base.children.optional()
}).strict();
export type SearchArgs = z.infer<typeof SearchArgsSchema>;

const SearchToursIntentSchema = z.object({
  type: z.literal("search_tours"),
  args: SearchArgsSchema,
  confidence: z.number().min(0).max(1).optional()
});

const MetaIntentSchema = z.object({
  type: z.literal("meta"),
  topic: z.enum(["capabilities", "help", "about", "pricing", "other"]),
  confidence: z.number().min(0).max(1).optional()
});

const SmalltalkIntentSchema = z.object({
  type: z.literal("smalltalk"),
  confidence: z.number().min(0).max(1).optional()
});

const UnknownIntentSchema = z.object({
  type: z.literal("unknown"),
  reason: z.string().optional(),
  questions: z.array(z.string()).min(1).max(3).optional(),
  confidence: z.number().min(0).max(1).optional()
});

export const ParsedIntentSchema = z.discriminatedUnion("type", [
  SearchToursIntentSchema,
  MetaIntentSchema,
  SmalltalkIntentSchema,
  UnknownIntentSchema
]);

export type SearchToursIntent = z.infer<typeof SearchToursIntentSchema>;
export type MetaIntent = z.infer<typeof MetaIntentSchema>;
export type SmalltalkIntent = z.infer<typeof SmalltalkIntentSchema>;
export type UnknownIntent = z.infer<typeof UnknownIntentSchema>;
export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

export interface LLMProvider {
  parseIntent(input: string): Promise<ParsedIntent>;
}

export type ProviderName = "mock" | "openai" | "deepseek" | "groq";

export interface NamedLLMProvider extends LLMProvider {
  readonly providerName: ProviderName;
}

export interface LoggerLike {
  debug(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}
