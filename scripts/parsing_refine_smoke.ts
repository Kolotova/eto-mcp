import { detectBudgetTargetPhrase, handleUserMessage, normalizeCountryName } from "../src/orchestrator.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

async function main(): Promise<void> {
  assert(normalizeCountryName("Турцию") === "Turkey", "normalizeCountryName: Турцию -> Turkey");
  assert(normalizeCountryName("ОАЭ") === "UAE", "normalizeCountryName: ОАЭ -> UAE");
  assert(normalizeCountryName("Вьетнам") === undefined, "normalizeCountryName: unsupported country");

  const result = await handleUserMessage("Покажи туры на Мальдивы в сентябре в районе 100000", {});
  assert(result.meta.intent_type === "search_tours", "orchestrator should route to search_tours");
  const draft = result.meta.draft_args ?? {};
  assert(draft.country_name === "Maldives" || draft.country_id === 90, "draft should contain Maldives");
  assert(draft.date_from === "2026-09-01" && draft.date_to === "2026-09-30", "draft should contain September range");
  assert(typeof draft.budget_max === "number" && draft.budget_max > 0, "draft should contain budget");

  const sept1 = await handleUserMessage("Турция в сентябре", {});
  const d1 = sept1.meta.draft_args ?? {};
  assert(d1.date_from === "2026-09-01" && d1.date_to === "2026-09-30", "september parsing");

  const sept2 = await handleUserMessage("Турция 09", {});
  const d2 = sept2.meta.draft_args ?? {};
  assert(d2.date_from === "2026-09-01" && d2.date_to === "2026-09-30", "09 month parsing");

  const autumn = await handleUserMessage("Турция осенью", {});
  const d3 = autumn.meta.draft_args ?? {};
  assert(
    d3.period === "autumn" ||
      (typeof d3.date_from === "string" && typeof d3.date_to === "string" && d3.date_from.startsWith("2026-09-")),
    "autumn period parsing"
  );

  const nov = await handleUserMessage("Турция в ноябре", {});
  const d4 = nov.meta.draft_args ?? {};
  assert(d4.date_from === "2026-11-01" && d4.date_to === "2026-11-30", "november parsing");

  assert(detectBudgetTargetPhrase("а за 250к?") === 250000, "ambiguous target budget parsing");

  process.stdout.write("parsing_refine_smoke PASS\n");
}

void main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
});
