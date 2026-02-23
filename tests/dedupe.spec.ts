import { assertFixtureCase } from "./helpers/assertions.js";
import { assert } from "./helpers/assert.js";
import { casesByGroups } from "./helpers/fixtures.js";
import { runConversation, summarizeConversation } from "./helpers/harness.js";
import { test } from "./helpers/runner.js";
import { matchFileSnapshot } from "./helpers/snapshot.js";

test("dedupe fixtures group 12", async ({ updateSnapshots }) => {
  const cases = casesByGroups([12]);
  const snaps: Record<string, unknown> = {};
  for (const c of cases) {
    const result = await runConversation(c.conversation);
    assertFixtureCase(c, result);
    snaps[c.id] = summarizeConversation(result);
  }
  matchFileSnapshot("dedupe-group-12", snaps, updateSnapshots);
});

test("double tap heart sends one checking + one dedupe notice", async () => {
  const result = await runConversation([
    { type: "text", text: "Турция 7 ночей до 120к всё включено" },
    { type: "callback_label", label: "💚 Хочу этот тур", index: 0 },
    { type: "callback_label", label: "💚 Хочу этот тур", index: 0 }
  ]);
  const messages = result.messages.filter((m) => m.includes("проверя"));
  assert(messages.some((m) => m.includes("Минутку")), "first tap should start checking");
  assert(result.messages.some((m) => m.includes("Уже проверяю этот тур")), "second tap should dedupe");
  const ackCalls = result.calls.filter((c) => c.method === "answerCallbackQuery");
  assert(ackCalls.length >= 2, "callback queries should be acked");
});

