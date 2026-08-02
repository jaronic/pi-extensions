import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../src/index.ts";
import { LOOP_CONTINUATION_TYPE, LOOP_STATE_TYPE } from "../src/protocol.ts";
import { blockedDecision, ExtensionHarness } from "./harness.ts";

function continuationMessage(loopId: string, generation: number, round: number): unknown {
  return {
    role: "custom",
    customType: LOOP_CONTINUATION_TYPE,
    content: "Continue loop round",
    display: false,
    details: { loopId, generation, round },
    timestamp: 1,
  };
}

function assistantMessage(stopReason = "end_turn", text = "Worked on the round", errorMessage?: string): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    errorMessage,
  };
}

function contextEvent(loopId: string, generation: number, round: number): unknown {
  return { type: "context", messages: [continuationMessage(loopId, generation, round)] };
}

function turnEndEvent(text = "Worked on the round"): unknown {
  return {
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" },
    toolResults: [],
  };
}

function agentEndEvent(...messages: unknown[]): unknown {
  return { type: "agent_end", messages };
}

function emittedRoundContext(
  harness: ExtensionHarness,
  loopId: string,
  generation: number,
  round: number,
): Promise<unknown[]> {
  return harness.emit("context", contextEvent(loopId, generation, round));
}

test("/loop N objective creates a running loop and queues the first round", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  await harness.command("loop", "3 polish the docs");

  assert.equal(harness.statuses.get("loop"), "Loop 0/3");
  assert.ok((harness.widgets.get("loop") ?? []).some((line) => line.startsWith("Objective: polish the docs")));
  assert.equal(harness.sentMessages.length, 1);
  const sent = harness.sentMessages[0] as {
    message: { customType: string; details: { loopId: string; generation: number; round: number } };
    options: { triggerTurn: boolean };
  };
  assert.equal(sent.message.customType, LOOP_CONTINUATION_TYPE);
  assert.deepEqual(sent.message.details, { loopId: sent.message.details.loopId, generation: 1, round: 1 });
  assert.equal(sent.options.triggerTurn, true);
  const stateEntry = harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE);
  assert.ok(stateEntry);
  const state = stateEntry.data as { action: string; loop: { status: string } };
  assert.equal(state.action, "create");
  assert.equal(state.loop.status, "running");
});

test("a full round settles via context binding and settled, then queues the next round", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "2 fix the tests");
  const created = harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE);
  const loopId = (created?.data as { loop: { id: string } }).loop.id;

  await emittedRoundContext(harness, loopId, 1, 1);
  await harness.emit("message_start", { type: "message_start", message: continuationMessage(loopId, 1, 1) });
  await harness.emit("turn_end", turnEndEvent("Fixed the failing test"));
  await harness.emit("agent_end", agentEndEvent(assistantMessage()));
  await harness.emit("agent_settled", { type: "agent_settled" });

  const settle = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { action: string; loop: { status: string; completedIterations: number; roundLog: Array<{ round: number; status: string; turns: number; summary: string }> } } };
  assert.equal(settle.data.action, "settle");
  assert.equal(settle.data.loop.completedIterations, 1);
  assert.equal(settle.data.loop.roundLog.length, 1);
  assert.equal(settle.data.loop.roundLog[0]?.round, 1);
  assert.equal(settle.data.loop.roundLog[0]?.turns, 1);
  assert.match(settle.data.loop.roundLog[0]?.summary ?? "", /Fixed the failing test/);
  assert.equal(harness.statuses.get("loop"), "Loop 1/2");
  const queued = harness.sentMessages.at(-1) as { message: { details: { round: number } } };
  assert.equal(queued.message.details.round, 2, "next round is queued after settle");
});

test("retry and compaction sub-runs count as one round; last agent_end wins", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "1 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;

  await emittedRoundContext(harness, loopId, 1, 1);
  await harness.emit("message_start", { type: "message_start", message: continuationMessage(loopId, 1, 1) });
  await harness.emit("turn_end", turnEndEvent("First attempt"));
  await harness.emit("agent_end", agentEndEvent(assistantMessage("error", "", "overloaded")));
  // auto-retry sub-run: same round, no new context binding
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("turn_end", turnEndEvent("Retried successfully"));
  await harness.emit("agent_end", agentEndEvent(assistantMessage()));
  await harness.emit("agent_settled", { type: "agent_settled" });

  const settle = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { action: string; loop: { completedIterations: number; roundLog: Array<{ turns: number; summary: string }>; status: string } } };
  assert.equal(settle.data.action, "settle");
  assert.equal(settle.data.loop.completedIterations, 1, "retry sub-run does not double count");
  assert.equal(settle.data.loop.roundLog[0]?.turns, 2, "turns accumulate across sub-runs");
  assert.match(settle.data.loop.roundLog[0]?.summary ?? "", /Retried successfully/, "last sub-run text wins");
  assert.equal(settle.data.loop.status, "finished", "round 1 of 1 finishes");
});

test("unbound runs (user input, foreign runs) never consume rounds", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  const before = harness.entries.length;

  // A run without any loop continuation in context settles without counting.
  await harness.emit("turn_end", turnEndEvent("unrelated"));
  await harness.emit("agent_end", agentEndEvent(assistantMessage()));
  await harness.emit("agent_settled", { type: "agent_settled" });

  const after = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { loop: { completedIterations: number } } };
  assert.equal(after.data.loop.completedIterations, 0, "foreign run must not consume a round");
  assert.equal(harness.entries.length, before, "no extra journal entry");
  assert.equal(harness.sentMessages.length, 1, "no duplicate continuation");
});

test("a final-round error pauses with lastAttempt and never finishes", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "1 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;

  await emittedRoundContext(harness, loopId, 1, 1);
  await harness.emit("agent_end", agentEndEvent(assistantMessage("error", "", "rate limit exceeded")));
  await harness.emit("agent_settled", { type: "agent_settled" });

  const last = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as {
    data: { action: string; loop: { status: string; pauseReason: string; completedIterations: number; lastAttempt: { round: number; status: string; reason: string } } };
  };
  assert.equal(last.data.action, "status");
  assert.equal(last.data.loop.status, "paused");
  assert.equal(last.data.loop.pauseReason, "usage-limit");
  assert.equal(last.data.loop.completedIterations, 0, "failed round is not counted");
  assert.equal(last.data.loop.lastAttempt.round, 1);
  assert.equal(harness.sentMessages.length, 1, "no continuation after a failed final round");
  assert.match(harness.notifications.at(-1)?.message ?? "", /paused after an agent error/);
});

test("an aborted round pauses without counting", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;

  await emittedRoundContext(harness, loopId, 1, 1);
  await harness.emit("agent_end", agentEndEvent(assistantMessage("aborted")));
  await harness.emit("agent_settled", { type: "agent_settled" });

  const last = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { loop: { status: string; pauseReason: string; completedIterations: number } } };
  assert.equal(last.data.loop.status, "paused");
  assert.equal(last.data.loop.pauseReason, "abort");
  assert.equal(last.data.loop.completedIterations, 0);
});

test("a length-truncated round counts and continues within the limit", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "2 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;

  await emittedRoundContext(harness, loopId, 1, 1);
  await harness.emit("turn_end", turnEndEvent("Truncated output here"));
  await harness.emit("agent_end", agentEndEvent(assistantMessage("length")));
  await harness.emit("agent_settled", { type: "agent_settled" });

  const last = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { loop: { roundLog: Array<{ status: string }>; completedIterations: number } } };
  assert.equal(last.data.loop.completedIterations, 1);
  assert.equal(last.data.loop.roundLog[0]?.status, "length");
  assert.equal((harness.sentMessages.at(-1) as { message: { details: { round: number } } }).message.details.round, 2);
});

test("pause persists before abort and blocks leftover tool calls of the stale round", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;
  await emittedRoundContext(harness, loopId, 1, 1);
  harness.setIdle(false);

  await harness.command("loop", "pause");

  const paused = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { action: string; loop: { status: string; pauseReason: string } } };
  assert.equal(paused.data.action, "status");
  assert.equal(paused.data.loop.status, "paused");
  assert.equal(paused.data.loop.pauseReason, "user");
  assert.ok(harness.agentOperations.includes("abort"), "abort follows the durable pause");
  assert.equal(harness.abortCount, 1);
  const gate = await harness.emit("tool_call", { type: "tool_call", toolName: "edit", toolCallId: "stale-edit", input: {} });
  assert.equal(blockedDecision(gate)?.block, true, "stale in-flight round tools are blocked after pause");
});

test("stop persists stopped before abort and blocks stale-round tools", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;
  await emittedRoundContext(harness, loopId, 1, 1);
  harness.setIdle(false);

  await harness.command("loop", "stop");

  const last = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { loop: { status: string } } };
  assert.equal(last.data.loop.status, "stopped");
  assert.equal(harness.abortCount, 1);
});

test("clear writes a tombstone that survives reload without resurrecting the loop", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  await harness.command("loop", "clear");

  const last = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { action: string; loop: null } };
  assert.equal(last.data.action, "clear");
  assert.equal(last.data.loop, null);
  assert.equal(harness.statuses.get("loop"), undefined);

  await harness.emit("session_start", { type: "session_start", reason: "reload" });
  assert.equal(harness.statuses.get("loop"), undefined, "cleared loop must not resurrect after reload");
  assert.equal(harness.sentMessages.length, 1, "no continuation after clear");
});

test("restoring a running loop pauses it for every session reason", async () => {
  for (const reason of ["startup", "reload", "resume", "fork"]) {
    const harness = new ExtensionHarness();
    loopExtension(harness.api);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("loop", "3 fix the tests");
    await harness.emit("session_start", { type: "session_start", reason });

    const last = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { loop: { status: string; pauseReason: string } } };
    assert.equal(last.data.loop.status, "paused", `${reason} must pause a running loop`);
    assert.equal(last.data.loop.pauseReason, reason === "reload" ? "reload" : "restore");
  }
});

test("session_tree restore also pauses a running loop", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  await harness.emit("session_tree", { type: "session_tree", newLeafId: "b", oldLeafId: "a" });
  const last = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { loop: { status: string; pauseReason: string } } };
  assert.equal(last.data.loop.status, "paused");
  assert.equal(last.data.loop.pauseReason, "restore");
});

test("resume after pause bumps generation and queues the pending round", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;
  await harness.command("loop", "pause");
  const sentBefore = harness.sentMessages.length;

  await harness.command("loop", "resume");

  const last = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { loop: { status: string; generation: number } } };
  assert.equal(last.data.loop.status, "running");
  assert.equal(last.data.loop.generation, 2);
  assert.equal(harness.sentMessages.length, sentBefore + 1);
  const sent = harness.sentMessages.at(-1) as { message: { details: { generation: number; round: number } } };
  assert.equal(sent.message.details.generation, 2);
  assert.equal(sent.message.details.round, 1, "resume retries the pending round");
});

test("stale continuations from an old generation are filtered from context", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;
  await harness.command("loop", "pause");
  await harness.command("loop", "resume");

  const result = await harness.emit("context", {
    type: "context",
    messages: [
      continuationMessage(loopId, 1, 1),
      continuationMessage(loopId, 2, 1),
      continuationMessage(loopId, 2, 1),
    ],
  });
  const messages = (result.at(-1) as { messages: unknown[] }).messages;
  const kept = messages.filter((message) =>
    message && typeof message === "object" && "customType" in message &&
    (message as { customType: string }).customType === LOOP_CONTINUATION_TYPE,
  );
  assert.equal(kept.length, 1, "only the newest valid continuation survives");
  assert.equal((kept[0] as { details: { generation: number } }).details.generation, 2);
  const injected = messages.at(-1) as { customType: string; content: string };
  assert.equal(injected.customType, "loop-context-v1");
  assert.match(injected.content, /Loop iteration 1 of 3/);
});

test("appendEntry failures pause in memory and skip the next continuation", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  const entriesBefore = harness.entries.length;
  harness.failNextAppendEntry(new Error("journal unavailable"));

  await harness.command("loop", "pause");

  assert.equal(harness.entries.length, entriesBefore, "failed append writes no journal entry");
  assert.ok(
    harness.notifications.some((notification) => /Failed to persist Loop state/.test(notification.message)),
    "persist failure is surfaced",
  );
});

test("headless mode deterministically rejects replacing an unfinished loop", async () => {
  const harness = new ExtensionHarness(["read", "bash"], false);
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  harness.clearPendingMessages();

  await harness.command("loop", "2 replace me");

  assert.match(harness.notifications.at(-1)?.message ?? "", /Stop or clear it before replacing/);
  assert.equal(harness.sentMessages.length, 1, "no new continuation was queued");
});

test("creating a loop while the agent is busy is rejected", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  harness.setIdle(false);
  await harness.command("loop", "3 fix the tests");
  assert.match(harness.notifications.at(-1)?.message ?? "", /requires an idle agent/);
  assert.equal(harness.entries.length, 0);
});

test("resume is only allowed from paused and re-checks exclusivity", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  await harness.command("loop", "resume");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Only a paused loop can be resumed/);
});

test("duplicate context bindings are idempotent and do not double-queue", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  const loopId = (harness.entries.find((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { id: string } }).loop.id;

  await emittedRoundContext(harness, loopId, 1, 1);
  await emittedRoundContext(harness, loopId, 1, 1);
  await harness.emit("agent_end", agentEndEvent(assistantMessage()));
  await harness.emit("agent_settled", { type: "agent_settled" });

  const settle = harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE) as { data: { loop: { completedIterations: number } } };
  assert.equal(settle.data.loop.completedIterations, 1);
  assert.equal(harness.sentMessages.length, 2, "one initial + one next-round continuation only");
});
