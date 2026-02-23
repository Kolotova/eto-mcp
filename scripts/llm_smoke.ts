import { strict as assert } from "node:assert";

import { MockLLMProvider } from "../src/llm/providers/mock.js";
import { ParsedIntentSchema } from "../src/llm/types.js";

function fail(message: string): never {
  throw new Error(message);
}

function pass(message: string): void {
  process.stdout.write(`[PASS] ${message}\n`);
}

async function main(): Promise<void> {
  const provider = new MockLLMProvider();

  const case1 = await provider.parseIntent("хочу тур в Турцию на 7 ночей до 120к");
  const parsed1 = ParsedIntentSchema.parse(case1);
  if (parsed1.type !== "search_tours") {
    fail("case1 should be search_tours");
  }
  assert.equal(parsed1.args.country_name, "Turkey");
  assert.equal(parsed1.args.nights_min, 7);
  assert.equal(parsed1.args.nights_max, 7);
  assert.equal(parsed1.args.budget_max, 120000);
  pass("case1 parsed search_tours");

  const case2 = await provider.parseIntent("Египет 10 ночей all inclusive");
  const parsed2 = ParsedIntentSchema.parse(case2);
  if (parsed2.type !== "search_tours") {
    fail("case2 should be search_tours");
  }
  assert.equal(parsed2.args.country_name, "Egypt");
  assert.equal(parsed2.args.nights_min, 10);
  assert.equal(parsed2.args.nights_max, 10);
  assert.equal(parsed2.args.meal, "AI");
  pass("case2 parsed search_tours");

  const case3 = await provider.parseIntent("посоветуй что-то");
  const parsed3 = ParsedIntentSchema.parse(case3);
  if (parsed3.type !== "unknown") {
    fail("case3 should be unknown");
  }
  assert.ok((parsed3.questions?.length ?? 0) >= 1, "case3 should contain clarification questions");
  pass("case3 parsed unknown with questions");

  process.stdout.write("[OK] llm smoke passed\n");
}

void main();
