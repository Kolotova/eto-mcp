import { readFileSync } from "node:fs";
import path from "node:path";

import type { EventInput } from "./harness.js";

export type FixtureCase = {
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

export type FixtureFile = {
  meta: { total: number; groups: Record<string, number> };
  cases: FixtureCase[];
};

export function loadFixtures(): FixtureFile {
  const file = path.join(process.cwd(), "fixtures", "test_cases.json");
  return JSON.parse(readFileSync(file, "utf8")) as FixtureFile;
}

export function casesByGroups(groups: number[]): FixtureCase[] {
  const set = new Set(groups);
  return loadFixtures().cases.filter((c) => set.has(c.group));
}

