import { detectBudgetTargetPhrase, handleUserMessage, normalizeCountryName } from "../src/orchestrator.js";
import { parseMonthRu, parseQuery } from "../src/nlu/parseQuery.js";
import { assert } from "./helpers/assert.js";
import { casesByGroups } from "./helpers/fixtures.js";
import { runConversation, summarizeConversation } from "./helpers/harness.js";
import { test } from "./helpers/runner.js";
import { matchFileSnapshot } from "./helpers/snapshot.js";

test("parser fixtures groups 3-8", async ({ updateSnapshots }) => {
  const groups = [3, 4, 5, 6, 7, 8];
  const cases = casesByGroups(groups);
  const parserSnapshots: Record<string, unknown> = {};

  for (const c of cases) {
    const firstText = c.conversation.find((e) => e.type === "text") as { type: "text"; text: string } | undefined;
    if (firstText) {
      const orch = await handleUserMessage(firstText.text, {});
      parserSnapshots[c.id] = {
        meta: orch.meta,
        text: orch.text
      };
    }
  }

  assert(normalizeCountryName("Турцию") === "Turkey", "normalizeCountryName ru");
  assert(normalizeCountryName("vietnam") === undefined, "unsupported country normalization");
  assert(detectBudgetTargetPhrase("за 250к?") === 250000, "ambiguous target budget parser");
  assert(detectBudgetTargetPhrase("около 120 000 ₽") === 120000, "target budget with currency sign");
  const rangeOrch = await handleUserMessage("Турция 7 ночей 90–120к", {});
  assert(rangeOrch.meta.search_args?.budget_min === 90000, "range budget_min parsed");
  assert(rangeOrch.meta.search_args?.budget_max === 120000, "range budget_max parsed");

  // Explicit required named cases via harness to confirm no extra slot questions.
  const requiredRuns = [
    "Турция на 7 ночей до 120 000 ₽, всё включено",
    "Мальдивы на 10 ночей до 150к",
    "Турция 7 ночей до 120000"
  ];
  for (const text of requiredRuns) {
    const result = await runConversation([{ type: "text", text }]);
    const joined = result.messages.join("\n");
    assert(!joined.includes("Какой бюджет"), `${text}: should not ask budget again`);
    assert(!joined.includes("На сколько ночей"), `${text}: should not ask nights again`);
  }

  const daysRun = await runConversation([{ type: "text", text: "Мальдивы на 10 дней до 150к" }]);
  const daysJoined = daysRun.messages.join("\n");
  assert(daysJoined.includes("Нашла"), "10 дней should parse as nights and run search");

  const rangeRun = await runConversation([{ type: "text", text: "Турция 7 ночей 90–120к" }]);
  for (const tour of rangeRun.finalState.lastResults ?? []) {
    const price = Number(tour?.price);
    assert(price >= 90000 && price <= 120000, `range filter leak price=${price}`);
  }

  matchFileSnapshot("parser-groups-3-8", parserSnapshots, updateSnapshots);
});

test("parser smoke snapshots via harness", async ({ updateSnapshots }) => {
  const sampleCases = casesByGroups([4, 5, 6, 8]).slice(0, 8);
  const outputs: Record<string, unknown> = {};
  for (const c of sampleCases) {
    outputs[c.id] = summarizeConversation(await runConversation(c.conversation));
  }
  matchFileSnapshot("parser-harness-sample", outputs, updateSnapshots);
});

test("parseQuery parses budgets/countries/commands/meal robustly", () => {
  const max = parseQuery("до 120 000 ₽");
  assert(max.params.budget?.type === "max", "max budget type");
  assert(max.params.budget?.max === 120000, "max budget value");

  const approx = parseQuery("примерно 150к");
  assert(approx.params.budget?.type === "approx", "approx budget type");
  assert(approx.params.budget?.min === 135000, "approx min");
  assert(approx.params.budget?.max === 165000, "approx max");

  const range1 = parseQuery("90-120к");
  assert(range1.params.budget?.type === "range", "range type hyphen");
  assert(range1.params.budget?.min === 90000 && range1.params.budget?.max === 120000, "range values hyphen");

  const range2 = parseQuery("от 80к до 100к");
  assert(range2.params.budget?.type === "range", "range type from-to");
  assert(range2.params.budget?.min === 80000 && range2.params.budget?.max === 100000, "range values from-to");

  const countrySupported = parseQuery("ОАЭ 7 ночей 90-120к");
  assert(countrySupported.params.country === "UAE", "supported country parsed");

  const countryUnsupported = parseQuery("Покажи Африку");
  assert(countryUnsupported.params.unknownCountry !== undefined, "unsupported country detected");

  const meal = parseQuery("без питания");
  assert(meal.params.meal === "RO", "meal RO parsed");

  assert(parseQuery("показать еще").command === "SHOW_MORE", "show more text command");
  assert(parseQuery("изменить фильтры").command === "EDIT_FILTERS", "edit filters text command");
  assert(parseQuery("новый поиск").command === "NEW_SEARCH", "new search text command");
  assert(parseQuery("избранное").command === "FAVORITES", "favorites text command");
  assert(parseQuery("очистить избранное").command === "CLEAR_FAVORITES", "clear favorites text command");

  assert(parseQuery("Турция на 7 дней до 150 тыс").params.nights === 7, "days should map to nights");
  assert(parseQuery("на 7д").params.nights === 7, "7д shorthand should parse");
  assert(parseQuery("7 суток").params.nights === 7, "sutki should parse");

  const maxTys = parseQuery("до 120тыс");
  assert(maxTys.params.budget?.type === "max" && maxTys.params.budget.max === 120000, "до 120тыс");
  const maxK = parseQuery("до 120k");
  assert(maxK.params.budget?.type === "max" && maxK.params.budget.max === 120000, "до 120k");
  const trailingApprox = parseQuery("150к примерно");
  assert(trailingApprox.params.budget?.type === "approx", "trailing approx marker");
  const withRub = parseQuery("до 120 000 р");
  assert(withRub.params.budget?.type === "max" && withRub.params.budget.max === 120000, "руб suffix parsing");

  assert(parseMonthRu("в мае")?.month === 5, "май month");
  assert(parseMonthRu("июль 2026")?.month === 7, "июль month");
  assert(parseMonthRu("в июле 26")?.year === 2026, "short year month parsing");
  const monthQuery = parseQuery("Найди Турцию на 7 дней до 100к в мае");
  assert(monthQuery.params.month === 5, "month extracted in parseQuery");
  assert(monthQuery.params.dateFrom === "2026-05-01", "month dateFrom");
  assert(monthQuery.params.dateTo === "2026-05-31", "month dateTo");
});
