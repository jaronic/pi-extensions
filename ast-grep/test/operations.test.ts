import assert from "node:assert/strict";
import test from "node:test";
import { markTerminalCause, OperationTracker } from "../src/operations.ts";
import { NativeScheduler } from "../src/scheduler.ts";
import { operationRecord } from "./helpers.ts";

test("NativeScheduler enforces capacity, FIFO, cancellation, and close", async () => {
  const scheduler = new NativeScheduler(2, 2);
  const first = await scheduler.acquire(operationRecord());
  const second = await scheduler.acquire(operationRecord());
  assert.equal(scheduler.activeCount, 2);
  const thirdRecord = operationRecord();
  const fourthRecord = operationRecord();
  const thirdPending = scheduler.acquire(thirdRecord);
  const fourthPending = scheduler.acquire(fourthRecord);
  assert.equal(scheduler.waitingCount, 2);
  await assert.rejects(scheduler.acquire(operationRecord()), /queue is full/u);

  first.release();
  const third = await thirdPending;
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.waitingCount, 1);
  markTerminalCause(fourthRecord, "external-abort");
  await assert.rejects(fourthPending, /aborted/u);
  assert.equal(scheduler.waitingCount, 0);

  const closingRecord = operationRecord();
  const closingPending = scheduler.acquire(closingRecord);
  assert.equal(scheduler.waitingCount, 1);
  scheduler.close();
  await assert.rejects(closingPending, /closed before this call could start/u);
  await assert.rejects(scheduler.acquire(operationRecord()), /scheduler is closed/u);
  second.release();
  third.release();
  assert.equal(scheduler.activeCount, 0);
});

test("OperationTracker caps unsettled work and retains ownership through shutdown", async () => {
  const tracker = new OperationTracker(() => 0);
  const gates = Array.from({ length: 8 }, () => Promise.withResolvers<void>());
  const pending = gates.map((gate) => tracker.run(undefined, 120_000, async () => gate.promise));
  assert.equal(tracker.activeCount, 8);
  assert.throws(() => tracker.run(undefined, 120_000, async () => undefined), /at most 8 operations/u);
  for (const gate of gates) gate.resolve();
  await Promise.all(pending);
  await Promise.resolve();
  assert.equal(tracker.activeCount, 0);

  const shutdownGate = Promise.withResolvers<void>();
  const interrupted = tracker.run(undefined, 120_000, async () => shutdownGate.promise);
  const shutdown = tracker.shutdown(5000);
  await assert.rejects(interrupted, /shutting down/u);
  shutdownGate.resolve();
  await shutdown;
  assert.equal(tracker.closing, true);
  assert.throws(() => tracker.run(undefined, 120_000, async () => undefined), /new operations are closed/u);
});
