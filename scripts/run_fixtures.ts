import { readFileSync } from "node:fs";
import path from "node:path";

import { assertFixtureCase } from "../tests/helpers/assertions.js";
import type { FixtureCase } from "../tests/helpers/fixtures.js";
import { runConversation, summarizeConversation } from "../tests/helpers/harness.js";
import { matchFileSnapshot } from "../tests/helpers/snapshot.js";

const update = process.argv.includes("--update");
const fixtureFile = path.join(process.cwd(), "fixtures", "test_cases.json");
const fixtureData = JSON.parse(readFileSync(fixtureFile, "utf8")) as { cases: FixtureCase[] };

let passed = 0;
for (const c of fixtureData.cases) {
  try {
    const result = await runConversation(c.conversation, {
      forceLLMActive: !c.tags.includes("guided")
    });
    assertFixtureCase(c, result);
    matchFileSnapshot(`fixture-${c.id}`, summarizeConversation(result), update);
    process.stdout.write(`[PASS] ${c.id} ${c.title}\n`);
    passed += 1;
  } catch (err) {
    process.stderr.write(`[FAIL] ${c.id} ${c.title}: ${(err as Error).message}\n`);
    process.exitCode = 1;
    break;
  }
}

if (process.exitCode !== 1) {
  process.stdout.write(`[OK] Fixtures passed: ${passed}/${fixtureData.cases.length}\n`);
}

