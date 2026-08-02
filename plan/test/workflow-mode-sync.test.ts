import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The exclusive-workflow query protocol is deliberately duplicated into plan,
// goal, and loop so no package imports another's src in production. The three
// copies must stay byte-identical: a silent divergence under the same
// `pi-extensions:exclusive-workflow:v1` version would break Plan/Goal/Loop
// exclusivity at runtime without any compile-time signal.
test("plan, goal, and loop workflow-mode.ts copies are byte-identical", async () => {
  const planCopy = fileURLToPath(new URL("../src/workflow-mode.ts", import.meta.url));
  const goalCopy = fileURLToPath(new URL("../../goal/src/workflow-mode.ts", import.meta.url));
  const loopCopy = fileURLToPath(new URL("../../loop/src/workflow-mode.ts", import.meta.url));
  const [planBytes, goalBytes, loopBytes] = await Promise.all([
    readFile(planCopy),
    readFile(goalCopy),
    readFile(loopCopy),
  ]);
  assert.ok(
    planBytes.equals(goalBytes) && planBytes.equals(loopBytes),
    "plan/src/workflow-mode.ts, goal/src/workflow-mode.ts, and loop/src/workflow-mode.ts have diverged; " +
      "sync all three copies (and all coexistence suites) before changing the " +
      "pi-extensions:exclusive-workflow:v1 semantics",
  );
});
