import { assert } from "./helpers/assert.js";
import { casesByGroups } from "./helpers/fixtures.js";
import { runConversation, summarizeConversation } from "./helpers/harness.js";
import { test } from "./helpers/runner.js";
import { matchFileSnapshot } from "./helpers/snapshot.js";

function latestInlineKeyboard(result: Awaited<ReturnType<typeof runConversation>>) {
  const calls = [...result.calls].reverse();
  for (const call of calls) {
    if (call.normalized.keyboard) return call.normalized.keyboard;
  }
  return undefined;
}

test("keyboard fixtures groups 2 and 14 and structural checks", async ({ updateSnapshots }) => {
  const cases = casesByGroups([2, 14]);
  const snaps: Record<string, unknown> = {};
  for (const c of cases) {
    const result = await runConversation(c.conversation);
    const kb = latestInlineKeyboard(result);
    snaps[c.id] = summarizeConversation(result);
    if (c.id.startsWith("g14_01")) {
      assert(Boolean(kb), "country keyboard expected");
      assert((kb?.length ?? 0) >= 2, "country keyboard should have at least 2 rows");
      const btnCount = (kb ?? []).flat().length;
      assert(btnCount >= 6, "country keyboard should expose 6 countries");
    }
    const labels = (kb ?? []).flat().map((b) => b.text);
    assert(!labels.includes("✍️ Ввести вручную"), "no giant manual input button");
  }
  matchFileSnapshot("keyboard-groups-2-14", snaps, updateSnapshots);
});

test("AI quick keyboards are compact and no Другое…", async () => {
  const res = await runConversation([{ type: "text", text: "Привет, хочу в Турцию" }]);
  const kb = latestInlineKeyboard(res);
  assert(Boolean(kb), "AI nights keyboard should exist");
  const labels = (kb ?? []).flat().map((b) => b.text);
  assert(labels.includes("7") && labels.includes("10") && labels.includes("14"), "preset nights buttons");
  assert(!labels.includes("Другое…"), "no Другое… button");
});

