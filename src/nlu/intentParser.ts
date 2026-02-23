export type ParsedIntent = {
  country_name?: string;
  budget_max?: number;
  period?: string;
  meal?: string;
};

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function parseBudget(text: string): number | undefined {
  const digits = text.replace(/\s+/g, "").match(/\d{5,7}/);
  if (digits) {
    const value = Number(digits[0]);
    if (Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }

  if (text.includes("до 100") || text.includes("100000") || text.includes("100 тыс")) return 100000;
  if (text.includes("до 150") || text.includes("150000") || text.includes("150 тыс")) return 150000;
  if (text.includes("до 250") || text.includes("250000") || text.includes("250 тыс")) return 250000;

  return undefined;
}

function parseCountry(text: string): string | undefined {
  if (text.includes("turkey") || text.includes("турц")) return "Turkey";
  if (text.includes("egypt") || text.includes("егип")) return "Egypt";
  if (text.includes("thailand") || text.includes("тайл")) return "Thailand";
  if (text.includes("uae") || text.includes("united arab emirates") || text.includes("emirates") || text.includes("оаэ")) return "UAE";
  if (text.includes("maldives") || text.includes("мальдив")) return "Maldives";
  if (text.includes("seychelles") || text.includes("сейшел")) return "Seychelles";
  return undefined;
}

function parsePeriod(text: string): string | undefined {
  if (text.includes("ближайш") || text.includes("следующ") || text.includes("next month")) return "next_month";
  if (text.includes("1-2") || text.includes("1 2") || text.includes("через") || text.includes("month")) return "1_2_months";
  if (text.includes("лет") || text.includes("summer")) return "summer";
  if (text.includes("осен") || text.includes("autumn")) return "autumn";
  return undefined;
}

function parseMeal(text: string): string | undefined {
  if (text.includes("всё включ") || text.includes("all inclusive") || text.includes(" ai")) return "AI";
  if (text.includes("завтрак") || text.includes("breakfast") || text.includes(" bb")) return "BB";
  if (text.includes("не важно") || text.includes("любое") || text.includes("any")) return "ANY";
  return undefined;
}

export function parseUserInput(text: string): ParsedIntent {
  const n = normalize(text);

  return {
    country_name: parseCountry(n),
    budget_max: parseBudget(n),
    period: parsePeriod(n),
    meal: parseMeal(n)
  };
}
