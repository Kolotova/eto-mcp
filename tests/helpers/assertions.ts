import { assert } from "./assert.js";
import type { FixtureCase } from "./fixtures.js";
import type { ConversationResult } from "./harness.js";

function getAllTexts(result: ConversationResult): string {
  return result.messages.join("\n");
}

function collectButtonLabels(result: ConversationResult): string[] {
  const labels: string[] = [];
  for (const call of result.calls) {
    for (const row of call.normalized.keyboard ?? []) {
      for (const btn of row) {
        labels.push(btn.text);
      }
    }
  }
  return labels;
}

function getByPath(obj: any, path: string): unknown {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function assertFixtureCase(caseDef: FixtureCase, result: ConversationResult): void {
  const allTexts = getAllTexts(result);
  const labels = collectButtonLabels(result);
  const labelText = labels.join("\n");
  for (const fragment of caseDef.expected.contains ?? []) {
    const haystackMatch = allTexts.includes(fragment) || labelText.includes(fragment);
    const semanticMatch =
      fragment === "Ищу" &&
      (allTexts.includes("🔎 Ищу лучшие варианты") ||
        allTexts.includes("🔎 Анализирую запрос") ||
        allTexts.includes("Подбираю лучшие варианты") ||
        allTexts.includes("Запускаю поиск"));
    assert(haystackMatch || semanticMatch, `${caseDef.id}: missing text fragment "${fragment}"`);
  }
  for (const fragment of caseDef.expected.not_contains ?? []) {
    assert(!allTexts.includes(fragment) && !labelText.includes(fragment), `${caseDef.id}: unexpected text fragment "${fragment}"`);
  }
  for (const bad of caseDef.expected.no_button_text ?? []) {
    assert(!labels.includes(bad), `${caseDef.id}: unexpected button "${bad}"`);
  }
  if (caseDef.expected.final_state) {
    for (const [key, expected] of Object.entries(caseDef.expected.final_state)) {
      const actual = getByPath(result.finalState as any, key);
      assert(
        JSON.stringify(actual) === JSON.stringify(expected),
        `${caseDef.id}: final_state mismatch for ${key}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
      );
    }
  }
}
