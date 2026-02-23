import { assertFixtureCase } from "./helpers/assertions.js";
import { assert } from "./helpers/assert.js";
import { casesByGroups, loadFixtures } from "./helpers/fixtures.js";
import { runConversation, summarizeConversation } from "./helpers/harness.js";
import { test } from "./helpers/runner.js";
import { matchFileSnapshot } from "./helpers/snapshot.js";

test("fixture inventory is 75 and group distribution matches", () => {
  const fixtures = loadFixtures();
  assert(fixtures.meta.total === 75, "fixtures total should be 75");
  const counts = new Map<number, number>();
  for (const c of fixtures.cases) counts.set(c.group, (counts.get(c.group) ?? 0) + 1);
  for (const [group, count] of Object.entries(fixtures.meta.groups)) {
    assert(counts.get(Number(group)) === count, `group ${group} count mismatch`);
  }
});

test("flow fixtures groups 1,9,10,11,13", async ({ updateSnapshots }) => {
  const groups = [1, 9, 10, 11, 13];
  const cases = casesByGroups(groups);
  const groupedSnapshots: Record<string, unknown> = {};

  for (const c of cases) {
    const result = await runConversation(c.conversation, { forceLLMActive: !c.tags.includes("guided") });
    assertFixtureCase(c, result);
    groupedSnapshots[c.id] = summarizeConversation(result);
  }

  matchFileSnapshot("flow-groups-1-9-10-11-13", groupedSnapshots, updateSnapshots);
});

test("required follow-up no reset after results: а в ноябре?", async () => {
  const result = await runConversation([
    { type: "text", text: "Турция 7 ночей до 120к всё включено" },
    { type: "text", text: "а в ноябре?" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("Обновляю поиск"), "should refine search");
  assert(!joined.includes("Выберите страну для отдыха"), "must not reset to country picker");
});

test("approx budget preserves country and proceeds to nights: Египет около 120к", async () => {
  const result = await runConversation([
    { type: "text", text: "Египет около 120к" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("На сколько ночей"), "should continue to next missing slot");
  assert(!joined.includes("это максимум или ориентир"), "explicit approx should not ask max/target clarification");
  assert(!joined.includes("Какую страну рассматриваете"), "must not lose country and ask for country again");
  assert(result.finalState.aiAwaiting === "nights", "should await nights after resolving budget");
});

test("budget question accepts phrases: до 100к and около 120000", async () => {
  const maxResult = await runConversation([
    { type: "text", text: "/start" },
    { type: "callback", data: "start_search" },
    { type: "callback", data: "country:47" },
    { type: "text", text: "до 100к" }
  ], { forceLLMActive: false });
  const maxJoined = maxResult.messages.join("\n");
  assert(maxJoined.includes("Какое качество отеля"), "guided flow should accept max phrase and continue");
  assert(!maxJoined.includes("Введите сумму цифрами"), "must not reject max phrase");

  const targetResult = await runConversation([
    { type: "text", text: "/start" },
    { type: "callback", data: "start_search" },
    { type: "callback", data: "country:47" },
    { type: "text", text: "около 120000" }
  ], { forceLLMActive: false });
  const targetJoined = targetResult.messages.join("\n");
  assert(targetJoined.includes("Какое качество отеля"), "guided flow should accept target phrase and continue");
  assert(!targetJoined.includes("Введите сумму цифрами"), "must not reject target phrase");
});

test("changing country in new message overrides previous session country", async () => {
  const result = await runConversation([
    { type: "text", text: "Турция 7 ночей до 120к" },
    { type: "text", text: "ОАЭ 7 ночей 90-120к" }
  ]);
  const lastArgs = result.finalState.lastSearchArgs;
  assert(lastArgs?.country_id === 63, "explicit new country should override previous country");
  const joined = result.messages.join("\n");
  assert(joined.includes("UAE") || joined.includes("ОАЭ"), "output should reflect current country");
  assert(!joined.includes("Фильтры: Турция"), "filters should not leak stale country");
});

test("full prompt with days+month triggers immediate search without re-asks", async () => {
  const result = await runConversation([
    { type: "text", text: "Найди Турцию на 7 дней до 100к в мае" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("Нашла"), "should run search immediately");
  assert(!joined.includes("На сколько ночей"), "must not ask nights again");
  assert(!joined.includes("Какой бюджет"), "must not ask budget again");
  assert(result.finalState.lastSearchArgs?.country_id === 47, "should keep parsed country");
  assert(result.finalState.lastSearchArgs?.date_from === "2026-05-01", "should apply month date_from");
  assert(result.finalState.lastSearchArgs?.date_to === "2026-05-31", "should apply month date_to");
});

test("latest message country overrides session in month query", async () => {
  const result = await runConversation([
    { type: "text", text: "Египет 7 ночей до 250к" },
    { type: "text", text: "Таиланд на 3 дня в июле" }
  ]);
  const lastArgs = result.finalState.lastSearchArgs;
  assert(lastArgs?.country_id === 29, "country must override to Thailand");
  assert(lastArgs?.nights_min === 3 && lastArgs?.nights_max === 3, "days should map to nights");
  assert(lastArgs?.date_from === "2026-07-01" && lastArgs?.date_to === "2026-07-31", "month july should map to date range");
});

test("month-only followup updates date and reruns search keeping context", async () => {
  const result = await runConversation([
    { type: "text", text: "Турция 7 ночей до 120к" },
    { type: "text", text: "в мае" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("Обновляю поиск"), "month-only should refine existing search");
  assert(result.finalState.lastSearchArgs?.country_id === 47, "keeps existing country");
  assert(result.finalState.lastSearchArgs?.date_from === "2026-05-01", "month sets date_from");
  assert(result.finalState.lastSearchArgs?.date_to === "2026-05-31", "month sets date_to");
});

test("typed commands route without breaking context", async () => {
  const result = await runConversation([
    { type: "text", text: "Египет 7 ночей до 120к" },
    { type: "text", text: "показать еще" },
    { type: "text", text: "новый поиск" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("Фильтры: Египет"), "initial search should run");
  assert(joined.includes("Ок, начнём заново. Выберите страну:"), "typed new search should reset to country picker");
});

test("thanks does not reset context and responds politely", async () => {
  const result = await runConversation([
    { type: "text", text: "Египет 7 ночей до 120к" },
    { type: "text", text: "спасибо" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("Пожалуйста! 😊"), "should answer politely");
  assert(result.finalState.lastSearchArgs?.country_id === 54, "should keep existing search context");
});

test("yes after favorites prompt opens favorites", async () => {
  const result = await runConversation([
    { type: "text", text: "Турция 7 ночей до 120к" },
    { type: "callback", data: "fav:save_collection" },
    { type: "text", text: "да" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("Подборка сохранена ⭐"), "save collection prompt shown");
  assert(joined.includes("⭐ Ваше избранное"), "affirmative should open favorites");
});

test("want_tour from favorites starts booking flow using favorites store", async () => {
  const result = await runConversation([
    { type: "text", text: "Турция 7 ночей до 120к" },
    { type: "callback_label", label: "⭐ Сохранить тур" },
    { type: "callback", data: "new" },
    { type: "text", text: "избранное" },
    { type: "callback_label", label: "💚 Хочу этот тур" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("⭐ Ваше избранное"), "should show favorites list");
  assert(joined.includes("Минутку, проверяю наличие и цену"), "should start booking flow from favorites");
  assert((result.finalState as any).step === "await_phone", "should move to phone step");
});

test("want_tour from current results starts booking flow", async () => {
  const result = await runConversation([
    { type: "text", text: "Египет 7 ночей до 120к" },
    { type: "callback_label", label: "💚 Хочу этот тур" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("Минутку, проверяю наличие и цену"), "booking flow should start");
  assert((result.finalState as any).step === "await_phone", "should wait for phone");
});

test("want_tour missing everywhere shows graceful error (no неактуален)", async () => {
  const result = await runConversation([
    { type: "callback", data: "want:unknown:999999:fav" }
  ]);
  const joined = result.messages.join("\n");
  assert(joined.includes("Не удалось найти тур"), "should show graceful not found error");
  assert(!joined.includes("неактуален"), "should not show stale/irrelevant message in demo");
});
