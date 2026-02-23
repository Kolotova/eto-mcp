import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type EventInput =
  | { type: "text"; text: string }
  | { type: "callback"; data: string }
  | { type: "callback_label"; label: string; index?: number };

type TestCase = {
  id: string;
  group: number;
  title: string;
  conversation: EventInput[];
  expected: {
    contains?: string[];
    not_contains?: string[];
    final_state?: Record<string, unknown>;
    no_button_text?: string[];
  };
  tags: string[];
  notes?: string;
};

const GROUP_COUNTS: Record<number, number> = {
  1: 6, 2: 4, 3: 6, 4: 6, 5: 6, 6: 6, 7: 4, 8: 8, 9: 6, 10: 10, 11: 5, 12: 4, 13: 2, 14: 2
};

function tc(group: number, index: number, title: string, conversation: EventInput[], expected: TestCase["expected"], tags: string[] = [], notes?: string): TestCase {
  return { id: `g${group.toString().padStart(2, "0")}_${index.toString().padStart(2, "0")}`, group, title, conversation, expected, tags, notes };
}

function rowsToCsv(cases: TestCase[]): string {
  const header = ["id", "group", "title", "conversation", "expected", "tags", "notes"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, "\"\"")}"`;
  const lines = [header.join(",")];
  for (const c of cases) {
    lines.push([
      esc(c.id),
      esc(c.group),
      esc(c.title),
      esc(JSON.stringify(c.conversation)),
      esc(JSON.stringify(c.expected)),
      esc(c.tags.join("|")),
      esc(c.notes ?? "")
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

function rowsToTsv(cases: TestCase[]): string {
  const header = ["id", "group", "initial_state", "title", "user_message", "expected_intent", "expected_slots", "expected_bot_action", "expected_message_snapshot_key", "tags", "notes"];
  const sanitize = (v: unknown) => String(v ?? "").replace(/\t/g, " ").replace(/\n/g, " ");
  const lines = [header.join("\t")];
  for (const c of cases) {
    const firstText = c.conversation.find((e) => e.type === "text") as { type: "text"; text: string } | undefined;
    const lastCb = [...c.conversation].reverse().find((e) => e.type !== "text") as any;
    const initialState =
      c.tags.includes("guided") ? "mid-flow/guided" :
      c.tags.includes("followup") ? "post-results" :
      "empty";
    const expectedIntent =
      c.tags.includes("cancel") ? "cancel" :
      c.tags.includes("help") || c.tags.includes("meta") ? "help" :
      c.tags.includes("smalltalk") ? "smalltalk" :
      c.tags.includes("dedupe") ? "select_tour" :
      c.tags.includes("pagination") ? "show_more" :
      c.tags.includes("filters") ? "change_filters" :
      c.tags.includes("one-shot") ? "search" :
      c.tags.includes("followup") ? "refine" :
      (lastCb?.data === "new" ? "new_search" : "search");
    const expectedBotAction =
      (c.expected.contains ?? []).some((x) => x.includes("Нашла")) ? "run_search" :
      (c.expected.contains ?? []).some((x) => x.includes("Обновляю поиск")) ? "run_refine_search" :
      (c.expected.contains ?? []).some((x) => x.includes("Какой бюджет") || x.includes("На сколько ночей")) ? "ask_missing" :
      (c.expected.contains ?? []).some((x) => x.includes("Пока могу искать только")) ? "show_country_keyboard" :
      "reply";
    const expectedSlots = JSON.stringify({
      country: c.tags.includes("country-switch") ? "switch" : undefined,
      nights: c.tags.includes("nights") ? true : undefined,
      budget: c.tags.includes("budget") ? true : undefined,
      month: c.tags.includes("month") || c.tags.includes("period") ? true : undefined,
      meal: c.tags.includes("meal") ? true : undefined
    });
    lines.push([
      sanitize(c.id),
      sanitize(c.group),
      sanitize(initialState),
      sanitize(c.title),
      sanitize(firstText?.text ?? ""),
      sanitize(expectedIntent),
      sanitize(expectedSlots),
      sanitize(expectedBotAction),
      sanitize(c.id),
      sanitize(c.tags.join("|")),
      sanitize(c.notes ?? "")
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function buildCases(): TestCase[] {
  const cases: TestCase[] = [];
  let i = 1;
  // (1) Start / Reset / Cancel
  cases.push(tc(1, i++, "/start shows intro", [{ type: "text", text: "/start" }], { contains: ["AI-ассистент", "Турция на 7 ночей"], final_state: { step: "idle" } }, ["start"]));
  cases.push(tc(1, i++, "cancel from idle", [{ type: "text", text: "отмена" }], { contains: ["Ок, сбросила поиск", "Доступные страны:"], final_state: { aiMode: true, aiAwaiting: "country" } }, ["cancel"]));
  cases.push(tc(1, i++, "cancel alias /cancel", [{ type: "text", text: "/cancel" }], { contains: ["Ок, сбросила поиск"] }, ["cancel"]));
  cases.push(tc(1, i++, "cancel from ai nights", [{ type: "text", text: "Привет, хочу в Турцию" }, { type: "text", text: "стоп" }], { contains: ["На сколько ночей", "Ок, сбросила поиск"], final_state: { aiAwaiting: "country" } }, ["cancel","ai"]));
  cases.push(tc(1, i++, "cancel from guided budget", [{ type: "text", text: "/start" }, { type: "callback", data: "start_search" }, { type: "callback", data: "country:47" }, { type: "text", text: "reset" }], { contains: ["Какой бюджет", "Ок, сбросила поиск"] }, ["cancel","guided"]));
  cases.push(tc(1, i++, "cancel phrase начать заново", [{ type: "text", text: "начать заново" }], { contains: ["Ок, сбросила поиск"] }, ["cancel"]));

  // (2) Help / Smalltalk
  i = 1;
  cases.push(tc(2, i++, "/help response", [{ type: "text", text: "/help" }], { contains: ["Я подбираю туры по 6 странам", "Турция на 7 ночей до 120к"] }, ["help"]));
  cases.push(tc(2, i++, "smalltalk hello", [{ type: "text", text: "привет" }], { contains: ["Привет!", "Турция на 7 ночей"] }, ["smalltalk"]));
  cases.push(tc(2, i++, "capabilities question", [{ type: "text", text: "что ты умеешь?" }], { contains: ["Я помогу подобрать тур", "Турция, Египет"] }, ["meta"]));
  cases.push(tc(2, i++, "neutral thanks in ai state", [{ type: "text", text: "хочу в турцию" }, { type: "text", text: "спасибо" }], { contains: ["На сколько ночей", "Пожалуйста"] }, ["smalltalk","state"]));

  // (3) Country selection / unsupported
  i = 1;
  cases.push(tc(3, i++, "unsupported Africa prompt", [{ type: "text", text: "Покажи Африку" }], { contains: ["Пока могу искать только", "Турция"], not_contains: ["Африка"] }, ["unsupported-country","required"]));
  cases.push(tc(3, i++, "unsupported Africa with nights", [{ type: "text", text: "Африка на 7 ночей" }], { contains: ["Пока могу искать только"] }, ["unsupported-country","required"]));
  cases.push(tc(3, i++, "supported Turkey ru", [{ type: "text", text: "хочу в Турцию" }], { contains: ["Поняла: Турция", "На сколько ночей"] }, ["country"]));
  cases.push(tc(3, i++, "supported Thailand ru", [{ type: "text", text: "Таиланд" }], { contains: ["Таиланд"] }, ["country"]));
  cases.push(tc(3, i++, "unsupported Italy 3 days", [{ type: "text", text: "Италия на 3 дня" }], { contains: ["Пока могу искать только"] }, ["unsupported-country","required"]));
  cases.push(tc(3, i++, "country switch after prior search text", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "text", text: "Хочу в Сейшелы на 10 ночей" }], { contains: ["Меняю направление на Сейшелы"] }, ["followup","country-switch"]));

  // (4) Nights parsing
  i = 1;
  cases.push(tc(4, i++, "7 nights phrase", [{ type: "text", text: "Турция на 7 ночей" }], { contains: ["Какой бюджет"], not_contains: ["На сколько ночей"] }, ["nights"]));
  cases.push(tc(4, i++, "week phrase", [{ type: "text", text: "Турция на неделю" }], { contains: ["Какой бюджет"], not_contains: ["На сколько ночей"] }, ["nights"]));
  cases.push(tc(4, i++, "10 days phrase", [{ type: "text", text: "Египет на 10 дней до 100к" }], { contains: ["Ищу", "Нашла"], not_contains: ["На сколько ночей"] }, ["nights","one-shot"]));
  cases.push(tc(4, i++, "two weeks phrase", [{ type: "text", text: "Мальдивы на две недели" }], { contains: ["Какой бюджет"], not_contains: ["На сколько ночей"] }, ["nights"]));
  cases.push(tc(4, i++, "weekend phrase", [{ type: "text", text: "Таиланд на выходные" }], { contains: ["Какой бюджет"], not_contains: ["На сколько ночей"] }, ["nights","required"]));
  cases.push(tc(4, i++, "nights typed while asked", [{ type: "text", text: "Турция" }, { type: "text", text: "15" }], { contains: ["На сколько ночей", "Какой бюджет"], final_state: { aiAwaiting: "budget" } }, ["nights","typing"]));

  // (5) Budget parsing
  i = 1;
  cases.push(tc(5, i++, "budget do 120k", [{ type: "text", text: "Турция 7 ночей до 120к" }], { contains: ["Ищу", "Нашла"], not_contains: ["Какой бюджет"] }, ["budget","one-shot"]));
  cases.push(tc(5, i++, "budget raw 120000", [{ type: "text", text: "Турция 7 ночей 120000" }], { contains: ["Ищу"], not_contains: ["Какой бюджет"] }, ["budget"]));
  cases.push(tc(5, i++, "budget around 100k", [{ type: "text", text: "Покажи туры на Мальдивы в сентябре в районе 100000" }], { contains: ["На сколько ночей"] }, ["budget","slot-filling","required"]));
  cases.push(tc(5, i++, "budget around phrase около", [{ type: "text", text: "Египет около 100к на 7 ночей" }], { contains: ["Нашла"] }, ["budget"]));
  cases.push(tc(5, i++, "clarification preserves country Egypt", [{ type: "text", text: "Египет около 120к" }, { type: "text", text: "около 120000" }], { contains: ["На сколько ночей"], not_contains: ["🇹🇷 Turkey", "это максимум или ориентир"], final_state: { aiAwaiting: "nights" } }, ["budget","followup","required"]));
  cases.push(tc(5, i++, "budget range 90-120k", [{ type: "text", text: "Турция 7 ночей 90–120к" }], { contains: ["Нашла"], not_contains: ["Какой бюджет"], final_state: { "lastSearchArgs.country_id": 47, "lastSearchArgs.nights_min": 7, "lastSearchArgs.nights_max": 7, "lastSearchArgs.budget_min": 90000, "lastSearchArgs.budget_max": 120000 } }, ["budget","range","required"]));

  // (6) Date / Month parsing
  i = 1;
  cases.push(tc(6, i++, "September month phrase", [{ type: "text", text: "Хочу в Турцию в сентябре" }], { contains: ["На сколько ночей"], not_contains: ["Какую страну"] }, ["month"]));
  cases.push(tc(6, i++, "09 month numeric", [{ type: "text", text: "Турция 09" }], { contains: ["На сколько ночей"] }, ["month"]));
  cases.push(tc(6, i++, "November follow-up", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "text", text: "а в ноябре?" }], { contains: ["Обновляю поиск"], not_contains: ["Выберите страну"] }, ["followup","month","required"]));
  cases.push(tc(6, i++, "Autumn phrase", [{ type: "text", text: "Турция осенью 7 ночей до 120к" }], { contains: ["Ищу"] }, ["period"]));
  cases.push(tc(6, i++, "Next month phrase", [{ type: "text", text: "Египет в ближайший месяц" }], { contains: ["На сколько ночей"] }, ["period"]));
  cases.push(tc(6, i++, "1-2 months phrase", [{ type: "text", text: "Таиланд через 1-2 месяца" }], { contains: ["На сколько ночей"] }, ["period"]));

  // (7) Meal parsing
  i = 1;
  cases.push(tc(7, i++, "AI phrase", [{ type: "text", text: "Турция 7 ночей до 120к всё включено" }], { contains: ["Ищу"], not_contains: ["Какое питание"] }, ["meal","required"]));
  cases.push(tc(7, i++, "BB phrase", [{ type: "text", text: "Египет 7 ночей до 100к завтраки" }], { contains: ["Ищу"] }, ["meal"]));
  cases.push(tc(7, i++, "No meals phrase", [{ type: "text", text: "Таиланд 7 ночей до 120к без питания" }], { contains: ["Ищу"] }, ["meal"]));
  cases.push(tc(7, i++, "followup meal refine", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "text", text: "без питания" }], { contains: ["Обновляю поиск"], final_state: { "lastSearchArgs.meal": "RO" } }, ["meal","followup","required"]));

  // (8) Full free-text one-shot (8)
  i = 1;
  cases.push(tc(8, i++, "Турция на 7 ночей до 120 000 ₽, всё включено", [{ type: "text", text: "Турция на 7 ночей до 120 000 ₽, всё включено" }], { contains: ["Нашла", "💚 Хочу этот тур"], not_contains: ["На сколько ночей", "Какой бюджет"] }, ["one-shot","required"]));
  cases.push(tc(8, i++, "Мальдивы сентябрь 10 ночей 100k range", [{ type: "text", text: "Мальдивы в сентябре в районе 100000 на 10 ночей" }], { contains: ["Нашла", "Maldives"], not_contains: ["это максимум или ориентир", "На сколько ночей"] }, ["one-shot","required"]));
  cases.push(tc(8, i++, "ОАЭ 3 nights budget", [{ type: "text", text: "ОАЭ 3 ночи до 100к" }], { contains: ["Нашла"], not_contains: ["Какой бюджет", "На сколько ночей"] }, ["one-shot"]));
  cases.push(tc(8, i++, "Египет на выходные до 100к", [{ type: "text", text: "Египет на выходные до 100к" }], { contains: ["Нашла"], not_contains: ["Фильтры: Сейшелы"], final_state: { countryId: 54, "lastSearchArgs.country_id": 54, "lastSearchArgs.nights_min": 3, "lastSearchArgs.nights_max": 3, "lastSearchArgs.budget_max": 100000 } }, ["one-shot","required","country"]));
  cases.push(tc(8, i++, "Thailand weekends", [{ type: "text", text: "Таиланд на выходные" }], { contains: ["Какой бюджет"], not_contains: ["На сколько ночей"] }, ["one-shot","required"]));
  cases.push(tc(8, i++, "UAE breakfasts one-shot", [{ type: "text", text: "ОАЭ 7 ночей до 150к завтраки" }], { contains: ["Нашла"] }, ["one-shot"]));
  cases.push(tc(8, i++, "Seychelles one-shot", [{ type: "text", text: "Сейшелы 10 ночей до 250к" }], { contains: ["Нашла"] }, ["one-shot"]));
  cases.push(tc(8, i++, "Maldives low budget one-shot", [{ type: "text", text: "Мальдивы 7 ночей до 100к" }], { contains: ["Нашла"] }, ["one-shot"]));

  // (9) Guided flow correctness (6)
  i = 1;
  cases.push(tc(9, i++, "guided start->country->budget", [{ type: "text", text: "/start" }, { type: "callback", data: "start_search" }, { type: "callback", data: "country:47" }, { type: "callback", data: "budget:100000" }], { contains: ["Какое качество отеля смотрим?"] }, ["guided"]));
  cases.push(tc(9, i++, "guided budget manual typing", [{ type: "text", text: "/start" }, { type: "callback", data: "start_search" }, { type: "callback", data: "country:47" }, { type: "text", text: "150000" }], { contains: ["Какой бюджет", "Какое качество отеля"] }, ["guided"]));
  cases.push(tc(9, i++, "ai nights preset 7", [{ type: "text", text: "Привет, хочу в Турцию" }, { type: "callback", data: "ai:nights:7" }], { contains: ["Ночи зафиксировала", "Какой бюджет"] }, ["ai","buttons"]));
  cases.push(tc(9, i++, "ai budget preset 100k after nights", [{ type: "text", text: "Турция" }, { type: "text", text: "7" }, { type: "callback", data: "ai:budget:100000" }], { contains: ["Запускаю поиск по уточнённым параметрам", "Нашла"] }, ["ai","buttons"]));
  cases.push(tc(9, i++, "manual nights 15 in ai", [{ type: "text", text: "Турция" }, { type: "text", text: "15" }, { type: "text", text: "120000" }], { contains: ["Нашла"] }, ["ai","manual"]));
  cases.push(tc(9, i++, "guided full chain to results", [{ type: "text", text: "/start" }, { type: "callback", data: "start_search" }, { type: "callback", data: "country:47" }, { type: "callback", data: "budget:100000" }, { type: "callback", data: "rating:any" }, { type: "callback", data: "period:summer" }, { type: "callback", data: "meal:ANY" }], { contains: ["Нашла", "💚 Хочу этот тур"] }, ["guided","full"]));

  // (10) Follow-up refinements (10)
  i = 1;
  const base = [{ type: "text", text: "Турция 7 ночей до 120к всё включено" }] as EventInput[];
  cases.push(tc(10, i++, "followup сентябрь", [...base, { type: "text", text: "есть в сентябре?" }], { contains: ["Обновляю поиск"], not_contains: ["Выберите страну"] }, ["followup","month","required"]));
  cases.push(tc(10, i++, "followup ноябрь", [...base, { type: "text", text: "а в ноябре?" }], { contains: ["Обновляю поиск"] }, ["followup","month"]));
  cases.push(tc(10, i++, "followup cheaper", [...base, { type: "text", text: "а дешевле?" }], { contains: ["Обновляю поиск"] }, ["followup","sort"]));
  cases.push(tc(10, i++, "followup expensive", [...base, { type: "text", text: "а дороже?" }], { contains: ["Обновляю поиск"] }, ["followup","sort"]));
  cases.push(tc(10, i++, "followup 14 nights", [...base, { type: "text", text: "а на две недели?" }], { contains: ["Обновляю поиск"] }, ["followup","nights"]));
  cases.push(tc(10, i++, "followup to 250k", [...base, { type: "text", text: "а до 250к?" }], { contains: ["Обновляю поиск"] }, ["followup","budget"]));
  cases.push(tc(10, i++, "followup Seychelles country switch", [...base, { type: "text", text: "а в Сейшелы?" }], { contains: ["Меняю направление на Сейшелы"] }, ["followup","country-switch"]));
  cases.push(tc(10, i++, "followup 10 nights + Seychelles", [...base, { type: "text", text: "Хочу в Сейшелы на 10 ночей" }], { contains: ["Меняю направление на Сейшелы"] }, ["followup","country-switch","required"]));
  cases.push(tc(10, i++, "followup breakfasts", [...base, { type: "text", text: "а завтраки?" }], { contains: ["Обновляю поиск"] }, ["followup","meal"]));
  cases.push(tc(10, i++, "followup next month", [...base, { type: "text", text: "в следующем месяце" }], { contains: ["Обновляю поиск"] }, ["followup","period"]));

  // (11) Buttons show more / filters / new search (5)
  i = 1;
  cases.push(tc(11, i++, "show more after one-shot", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "callback_label", label: "🔁 Показать ещё" }], { contains: ["Действия:"] }, ["buttons","pagination"]));
  cases.push(tc(11, i++, "filters menu opens", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "callback", data: "filters" }], { contains: ["Что изменить?"] }, ["buttons","filters"]));
  cases.push(tc(11, i++, "filter back to results", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "callback", data: "filters" }, { type: "callback", data: "filtermenu:back" }], { contains: ["💚 Хочу этот тур"] }, ["buttons","filters"]));
  cases.push(tc(11, i++, "new search resets once", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "callback", data: "new" }], { contains: ["Выберите страну для отдыха:"], no_button_text: ["Другое…"] }, ["buttons","new"]));
  cases.push(tc(11, i++, "change budget filter reruns", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "callback", data: "filters" }, { type: "callback", data: "filtermenu:budget" }, { type: "callback", data: "budget:150000" }], { contains: ["Ищу лучшие варианты", "Нашла"] }, ["buttons","filters"]));

  // (12) Dedupe & anti-race (4)
  i = 1;
  cases.push(tc(12, i++, "double tap heart dedupe", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "callback_label", label: "💚 Хочу этот тур", index: 0 }, { type: "callback_label", label: "💚 Хочу этот тур", index: 0 }], { contains: ["Минутку, проверяю наличие и цену…", "Уже проверяю этот тур ✅"] }, ["dedupe","heart","required"]));
  cases.push(tc(12, i++, "rapid refine messages no duplicate stale cards", [...base, { type: "text", text: "а в сентябре?" }, { type: "text", text: "а в ноябре?" }], { contains: ["Обновляю поиск по вашему уточнению ✨"] }, ["race","followup"]));
  cases.push(tc(12, i++, "callback ack country", [{ type: "text", text: "/start" }, { type: "callback", data: "start_search" }, { type: "callback", data: "country:47" }], { contains: ["Какой бюджет"] }, ["callback-ack"]));
  cases.push(tc(12, i++, "callback ack more", [{ type: "text", text: "Турция 7 ночей до 120к" }, { type: "callback_label", label: "🔁 Показать ещё" }], { contains: ["Действия:"] }, ["callback-ack","pagination"]));

  // (13) Error handling / empty results (2)
  i = 1;
  cases.push(tc(13, i++, "invalid nights out of range", [{ type: "text", text: "Турция" }, { type: "text", text: "35" }], { contains: ["Введите количество ночей числом от 1 до 30."] }, ["validation"]));
  cases.push(tc(13, i++, "invalid budget negative", [{ type: "text", text: "/start" }, { type: "callback", data: "start_search" }, { type: "callback", data: "country:47" }, { type: "callback", data: "budget:custom" }, { type: "text", text: "-100" }], { contains: ["Введите сумму цифрами"] }, ["validation","guided"]));

  // (14) Keyboard UX structure (2)
  i = 1;
  cases.push(tc(14, i++, "country keyboard compact 2x3", [{ type: "text", text: "/start" }, { type: "callback", data: "show_countries" }], { contains: ["Доступные страны:"], no_button_text: ["Другое…"] }, ["keyboard","countries","required"]));
  cases.push(tc(14, i++, "ai nights budget keyboards compact", [{ type: "text", text: "хочу в Турцию" }], { contains: ["На сколько ночей"], no_button_text: ["✍️ Ввести вручную", "Другое…"] }, ["keyboard","ai"]));

  const total = cases.length;
  if (total !== 75) {
    throw new Error(`Expected 75 cases, got ${total}`);
  }
  for (const [group, expectedCount] of Object.entries(GROUP_COUNTS)) {
    const actual = cases.filter((c) => c.group === Number(group)).length;
    if (actual !== expectedCount) {
      throw new Error(`Group ${group} expected ${expectedCount}, got ${actual}`);
    }
  }
  return cases;
}

const cases = buildCases();
const outDir = path.join(process.cwd(), "fixtures");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, "test_cases.json"),
  `${JSON.stringify({ meta: { total: cases.length, groups: GROUP_COUNTS }, cases }, null, 2)}\n`,
  "utf8"
);
writeFileSync(path.join(outDir, "test_cases.csv"), rowsToCsv(cases), "utf8");
writeFileSync(path.join(outDir, "fixtures.tsv"), rowsToTsv(cases), "utf8");
process.stdout.write(`Generated ${cases.length} test cases\n`);
