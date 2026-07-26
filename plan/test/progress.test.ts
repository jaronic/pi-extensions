import assert from "node:assert/strict";
import test from "node:test";
import {
  closeTodoProgress,
  decodeProgressSnapshot,
  openTodoProgress,
  readTodoProgress,
  updateTodoProgress,
  type ProgressStepDefinition,
  type TodoManagedProgressService,
} from "../src/progress.ts";

const STEPS: readonly ProgressStepDefinition[] = [
  { id: "step-1", text: "Inspect" },
  { id: "step-2", text: "Implement" },
];

function progressSnapshot(executionId: string, first: "pending" | "inProgress" | "completed" = "pending"): object {
  return {
    executionId,
    revision: first === "pending" ? 1 : 2,
    steps: [
      { id: "step-1", status: first },
      { id: "step-2", status: "pending" },
    ],
  };
}

test("direct Todo managed progress validates open, read, update, and close snapshots", async () => {
  let first: "pending" | "inProgress" | "completed" = "pending";
  let closed = false;
  const progress: TodoManagedProgressService = {
    async open(request) {
      return progressSnapshot(request.executionId) as never;
    },
    async read(request) {
      return progressSnapshot(request.executionId, first) as never;
    },
    async update(request) {
      first = request.status === "blocked" ? "pending" : request.status;
      return progressSnapshot(request.executionId, first) as never;
    },
    async close() {
      closed = true;
    },
  };

  const opened = await openTodoProgress(progress, {
    sessionId: "session",
    executionId: "execution",
    steps: STEPS,
  });
  assert.equal(opened.steps[0]?.status, "pending");
  const updated = await updateTodoProgress(progress, {
    sessionId: "session",
    executionId: "execution",
    requestId: "request-1",
    stepId: "step-1",
    status: "inProgress",
  }, STEPS);
  assert.equal(updated.steps[0]?.status, "inProgress");
  const read = await readTodoProgress(progress, {
    sessionId: "session",
    executionId: "execution",
  }, STEPS);
  assert.deepEqual(read, updated);
  await closeTodoProgress(progress, {
    sessionId: "session",
    executionId: "execution",
    outcome: "cancelled",
  });
  assert.equal(closed, true);
});

test("direct Todo managed progress fails closed for missing, malformed, and aborted snapshots", async () => {
  const unavailable: TodoManagedProgressService = {
    async open() { return undefined; },
    async read() { return undefined; },
    async update() { throw new Error("offline"); },
    async close() {},
  };
  await assert.rejects(openTodoProgress(unavailable, {
    sessionId: "session",
    executionId: "execution",
    steps: STEPS,
  }), /could not open/);
  assert.throws(() => decodeProgressSnapshot({
    ...progressSnapshot("execution"),
    forged: true,
  }, "execution", STEPS), /invalid snapshot/);
  assert.throws(() => decodeProgressSnapshot({
    ...progressSnapshot("execution"),
    steps: [
      { id: "step-1", status: "pending", forged: true },
      { id: "step-2", status: "pending" },
    ],
  }, "execution", STEPS), /unknown fields/);

  const controller = new AbortController();
  const aborting: TodoManagedProgressService = {
    async open(request) {
      controller.abort(new Error("caller stopped"));
      return progressSnapshot(request.executionId) as never;
    },
    async read() { return undefined; },
    async update() { throw new Error("offline"); },
    async close() {},
  };
  await assert.rejects(openTodoProgress(aborting, {
    sessionId: "session",
    executionId: "execution",
    steps: STEPS,
    signal: controller.signal,
  }), /caller stopped/);
});
