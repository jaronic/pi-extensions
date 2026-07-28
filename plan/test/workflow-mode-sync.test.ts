import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The exclusive-workflow query protocol is deliberately duplicated into plan
// and goal so neither package imports the other's src in production. The two
// copies must stay byte-identical: a silent divergence under the same
// `pi-extensions:exclusive-workflow:v1` version would break Plan/Goal
// exclusivity at runtime without any compile-time signal.
test("plan and goal workflow-mode.ts copies are byte-identical", async () => {
  const planCopy = fileURLToPath(new URL("../src/workflow-mode.ts", import.meta.url));
  const goalCopy = fileURLToPath(new URL("../../goal/src/workflow-mode.ts", import.meta.url));
  const [planBytes, goalBytes] = await Promise.all([readFile(planCopy), readFile(goalCopy)]);
  assert.ok(
    planBytes.equals(goalBytes),
    "plan/src/workflow-mode.ts and goal/src/workflow-mode.ts have diverged; " +
      "sync both copies (and both coexistence suites) before changing the " +
      "pi-extensions:exclusive-workflow:v1 semantics",
  );
});
