import { loadFixtures } from "./helpers/fixtures.js";
import { runRegistered } from "./helpers/runner.js";

const updateSnapshots = process.argv.includes("--update");

// Register tests (side-effect imports)
await import("./parser.spec.js");
await import("./flow.spec.js");
await import("./keyboard.spec.js");
await import("./dedupe.spec.js");
await import("./favorites.spec.js");

// Basic fixture sanity before running
const fixtures = loadFixtures();
if (fixtures.cases.length !== 75) {
  throw new Error(`Fixture count mismatch: expected 75, got ${fixtures.cases.length}`);
}

await runRegistered(updateSnapshots);
