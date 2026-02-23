import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import { assertDeepEqual } from "./assert.js";

const SNAPSHOT_DIR = path.join(process.cwd(), "tests", "snapshots");
const GOLDEN_DIR = path.join(process.cwd(), "tests", "golden");

export function ensureSnapshotDir(): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  mkdirSync(GOLDEN_DIR, { recursive: true });
}

export function snapshotPath(name: string): string {
  return path.join(SNAPSHOT_DIR, `${name}.json`);
}

export function matchFileSnapshot(name: string, data: unknown, update = false): void {
  ensureSnapshotDir();
  const file = snapshotPath(name);
  if (update || !existsSync(file)) {
    const body = `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(file, body, "utf8");
    writeFileSync(path.join(GOLDEN_DIR, `${name}.json`), body, "utf8");
    return;
  }
  const expected = JSON.parse(readFileSync(file, "utf8"));
  assertDeepEqual(data, expected, `Snapshot mismatch: ${name}`);
}
