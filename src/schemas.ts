import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const searchToursInputSchema = z.object({
  country_id: z.number().optional(),
  departure_id: z.number(),
  date_from: z.string().regex(dateRegex, "date_from must be YYYY-MM-DD"),
  date_to: z.string().regex(dateRegex, "date_to must be YYYY-MM-DD"),
  nights_min: z.number(),
  nights_max: z.number(),
  adults: z.number(),
  children: z.number().int().min(0).max(4),
  country_name: z.string().optional(),
  destination: z.string().optional(),
  city_name: z.string().optional(),
  resort_name: z.string().optional(),
  period: z.enum(["next_month", "1_2_months", "summer", "autumn"]).optional(),
  budget_min: z.number().optional(),
  budget_max: z.number().optional().default(0),
  meal: z.union([z.number(), z.string()]).optional().default(0),
  rating: z.union([z.number(), z.string()]).optional().default(0),
  limit: z.number().int().min(1).max(20).optional().default(10),
  offset: z.number().int().min(0).optional().default(0),
  sort: z.enum(["price_asc", "price_desc"]).optional().default("price_asc")
});

export type SearchToursInput = z.infer<typeof searchToursInputSchema>;
