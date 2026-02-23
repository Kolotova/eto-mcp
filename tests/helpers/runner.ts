type TestFn = (ctx: { updateSnapshots: boolean }) => Promise<void> | void;

const tests: Array<{ name: string; fn: TestFn }> = [];

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

export async function runRegistered(updateSnapshots: boolean): Promise<void> {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn({ updateSnapshots });
      process.stdout.write(`[PASS] ${t.name}\n`);
      passed += 1;
    } catch (err) {
      process.stderr.write(`[FAIL] ${t.name}: ${(err as Error).message}\n`);
      throw err;
    }
  }
  process.stdout.write(`[OK] ${passed} tests passed\n`);
}

