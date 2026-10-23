// Runs the Python unit tests under the same command as the Bun suite, so a
// regression in the prune logic — the most destructive script in the package —
// is not invisible to `bun test`. The script is tested with Python's own
// unittest because it is Python; this file only bridges the two runners.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const TEST_FILE = join(import.meta.dir, "codeintel-instance-prune_test.py");

describe("codeintel-instance-prune.py", () => {
  test("python unittest suite passes", () => {
    const result = Bun.spawnSync({
      cmd: ["python3", "-m", "unittest", "codeintel-instance-prune_test.py", "-v"],
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(output).not.toContain("FAILED");
    expect(result.exitCode).toBe(0);
  });
});
