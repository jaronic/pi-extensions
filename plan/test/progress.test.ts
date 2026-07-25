import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionHarness } from "./harness.ts";
import {
  EXECUTION_PROGRESS_CHANNEL,
  closeProgressProvider,
  decodeProgressSnapshot,
  discoverProgressProviders,
  openProgressProvider,
  readProgressProvider,
  updateProgressProvider,
  type ProgressProvider,
  type ProgressStepDefinition,
} from "../src/progress.ts";

const STEPS: readonly ProgressStepDefinition[] = [
  { id: "step-1", text: "Inspect" },
  { id: "step-2", text: "Implement" },
];

function offerProviders(value: unknown, providers: readonly ProgressProvider[]): void {
  if (value === null || typeof value !== "object" || !("offer" in value) || typeof value.offer !== "function") {
    throw new Error("Expected a progress discovery envelope.");
  }
  for (const provider of providers) value.offer(provider);
}

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

test("progress discovery selects the first valid provider by priority and records declined failures", async () => {
  const harness = new ExtensionHarness();
  let lowStatus: "pending" | "inProgress" | "completed" = "pending";
  let closed = false;
  const malformed: ProgressProvider = {
    id: "malformed",
    priority: 200,
    async open(request) {
      return { executionId: request.executionId, revision: 1, steps: [] };
    },
    async read() {
      return undefined;
    },
    async update() {
      return undefined;
    },
    async close() {},
  };
  const throwing: ProgressProvider = {
    id: "throwing",
    priority: 100,
    async open() {
      throw new Error("offline");
    },
    async read() {
      return undefined;
    },
    async update() {
      return undefined;
    },
    async close() {},
  };
  const selected: ProgressProvider = {
    id: "selected",
    priority: 10,
    async open(request) {
      return progressSnapshot(request.executionId);
    },
    async read(request) {
      return progressSnapshot(request.executionId, lowStatus);
    },
    async update(request) {
      lowStatus = request.status === "blocked" ? "pending" : request.status;
      return progressSnapshot(request.executionId, lowStatus);
    },
    async close() {
      closed = true;
    },
  };
  harness.api.events.on(EXECUTION_PROGRESS_CHANNEL, (value: unknown) => {
    offerProviders(value, [selected, throwing, malformed]);
  });

  assert.deepEqual(discoverProgressProviders(harness.api.events).map((provider) => provider.id), [
    "malformed",
    "throwing",
    "selected",
  ]);
  const opened = await openProgressProvider(harness.api.events, {
    sessionId: "session",
    executionId: "execution",
    steps: STEPS,
  });
  assert.equal(opened.opened?.providerId, "selected");
  assert.deepEqual(opened.failures, [
    "malformed: Progress snapshot does not contain every approved Plan step.",
    "throwing: offline",
  ]);

  const updated = await updateProgressProvider(harness.api.events, "selected", {
    sessionId: "session",
    executionId: "execution",
    requestId: "request-1",
    stepId: "step-1",
    status: "inProgress",
  }, STEPS);
  assert.equal(updated.steps[0]?.status, "inProgress");
  const read = await readProgressProvider(harness.api.events, "selected", {
    sessionId: "session",
    executionId: "execution",
  }, STEPS);
  assert.deepEqual(read, updated);
  await closeProgressProvider(harness.api.events, "selected", {
    sessionId: "session",
    executionId: "execution",
    outcome: "cancelled",
  });
  assert.equal(closed, true);
});

test("duplicate provider IDs are rejected instead of depending on listener order", () => {
  const harness = new ExtensionHarness();
  const provider = (priority: number): ProgressProvider => ({
    id: "duplicate",
    priority,
    async open() { return undefined; },
    async read() { return undefined; },
    async update() { return undefined; },
    async close() {},
  });
  harness.api.events.on(EXECUTION_PROGRESS_CHANNEL, (value: unknown) => {
    offerProviders(value, [provider(1), provider(2)]);
  });
  assert.deepEqual(discoverProgressProviders(harness.api.events), []);
});

test("progress snapshots reject unknown fields", () => {
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
});

test("provider discovery failure falls back cleanly and abort wins over fallback", async () => {
  const throwingHarness = new ExtensionHarness();
  throwingHarness.api.events.on(EXECUTION_PROGRESS_CHANNEL, () => {
    throw new Error("listener failed");
  });
  assert.deepEqual(await openProgressProvider(throwingHarness.api.events, {
    sessionId: "session",
    executionId: "execution",
    steps: STEPS,
  }), { failures: ["discovery: listener failed"] });

  const abortHarness = new ExtensionHarness();
  const controller = new AbortController();
  const provider: ProgressProvider = {
    id: "aborting",
    priority: 1,
    async open(request) {
      controller.abort();
      return progressSnapshot(request.executionId);
    },
    async read() { return undefined; },
    async update() { return undefined; },
    async close() {},
  };
  abortHarness.api.events.on(EXECUTION_PROGRESS_CHANNEL, (value: unknown) => offerProviders(value, [provider]));
  await assert.rejects(openProgressProvider(abortHarness.api.events, {
    sessionId: "session",
    executionId: "execution",
    steps: STEPS,
    signal: controller.signal,
  }), /aborted/i);
});
