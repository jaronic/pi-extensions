import assert from "node:assert/strict";
import test from "node:test";
import {
  TODO_MANAGED_PROGRESS_TYPE,
  buildManagedProgressEntry,
  createTodoProgressProvider,
  managedProgressFooter,
  managedProgressPrompt,
  restoreManagedProgress,
  type ManagedProgressState,
} from "../src/progress-provider.ts";

test("Todo managed progress is durable, idempotent, and separate from the ordinary board", async () => {
  let state: ManagedProgressState | null = null;
  let phase = "awaitingApproval";
  let now = 10;
  const commits: Array<ManagedProgressState | null> = [];
  const provider = createTodoProgressProvider({
    getState: () => state,
    getSessionId: () => "session",
    getPlanPhase: () => phase,
    now: () => ++now,
    commit(next) {
      state = next;
      commits.push(next);
    },
  });
  const steps = [
    { id: "step-1", text: "Inspect <input>" },
    { id: "step-2", text: "Implement" },
  ];

  const opened = await provider.open({ sessionId: "session", executionId: "execution", steps });
  assert.deepEqual(opened, {
    executionId: "execution",
    revision: 1,
    steps: [
      { id: "step-1", status: "pending" },
      { id: "step-2", status: "pending" },
    ],
  });
  assert.equal(commits.length, 1);
  assert.match(managedProgressFooter(state!).text, /Plan 0\/2/);
  assert.match(managedProgressPrompt(state!) ?? "", /Inspect &lt;input&gt;/);

  phase = "executing";
  const updated = await provider.update({
    sessionId: "session",
    executionId: "execution",
    requestId: "request-1",
    stepId: "step-1",
    status: "inProgress",
  });
  assert.deepEqual(updated, {
    executionId: "execution",
    revision: 2,
    steps: [
      { id: "step-1", status: "inProgress" },
      { id: "step-2", status: "pending" },
    ],
  });
  assert.equal(commits.length, 2);
  assert.match(managedProgressFooter(state!).text, /#1 Inspect/);

  assert.deepEqual(await provider.update({
    sessionId: "session",
    executionId: "execution",
    requestId: "request-1",
    stepId: "step-1",
    status: "inProgress",
  }), updated);
  assert.equal(commits.length, 2, "replaying an identical request does not append another state");
  await assert.rejects(provider.update({
    sessionId: "session",
    executionId: "execution",
    requestId: "request-1",
    stepId: "step-2",
    status: "completed",
  }), /reused with different input/);

  assert.deepEqual(await provider.read({ sessionId: "session", executionId: "execution" }), updated);
  const restored = restoreManagedProgress([{
    type: "custom",
    customType: TODO_MANAGED_PROGRESS_TYPE,
    data: buildManagedProgressEntry(state),
  }], "session");
  assert.deepEqual(restored.state, state);

  await provider.close({ sessionId: "session", executionId: "execution", outcome: "cancelled" });
  assert.equal(state, null);
  assert.equal(commits.at(-1), null);
});

test("managed progress replay fails closed after a malformed latest record", () => {
  const valid: ManagedProgressState = {
    version: 1,
    sessionId: "session",
    executionId: "execution",
    revision: 1,
    steps: [{ id: "step-1", text: "Inspect", status: "pending" }],
    createdAt: 1,
    updatedAt: 1,
  };
  const restored = restoreManagedProgress([
    { type: "custom", customType: TODO_MANAGED_PROGRESS_TYPE, data: buildManagedProgressEntry(valid) },
    { type: "custom", customType: TODO_MANAGED_PROGRESS_TYPE, data: { version: 1, state: { ...valid, forged: true } } },
  ], "session");
  assert.equal(restored.state, null);
  assert.match(restored.warning ?? "", /ignored/);
});

test("managed progress rejects non-exact provider inputs and journal envelopes", async () => {
  const provider = createTodoProgressProvider({
    getState: () => null,
    getSessionId: () => "session",
    getPlanPhase: () => "awaitingApproval",
    now: () => 1,
    commit() {},
  });
  await assert.rejects(provider.open({
    sessionId: "session",
    executionId: "execution",
    steps: [{ id: "step-1", text: "Inspect", forged: true }],
  } as never), /exact object/);
  const valid: ManagedProgressState = {
    version: 1,
    sessionId: "session",
    executionId: "execution",
    revision: 1,
    steps: [{ id: "step-1", text: "Inspect", status: "pending" }],
    createdAt: 1,
    updatedAt: 1,
  };
  const restored = restoreManagedProgress([{
    type: "custom",
    customType: TODO_MANAGED_PROGRESS_TYPE,
    data: { ...buildManagedProgressEntry(valid), forged: true },
  }], "session");
  assert.equal(restored.state, null);
  assert.match(restored.warning ?? "", /ignored/);
});
