import { z } from "zod";

const envSchema = z.object({
  API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0")
});

export const config = envSchema.parse(process.env);
