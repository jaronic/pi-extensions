import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { createRequestComponent } from "../src/component.ts";
import { RequestCoordinator } from "../src/dialog.ts";
import { normalizeRequestQuestions, type RequestDialogResult, type RequestQuestion } from "../src/request.ts";
import { RequestHarness } from "./harness.ts";

const FIRST_QUESTION: RequestQuestion = {
  id: "first",
  header: "First",
  question: "Continue with the first request?",
  options: [{ label: "Yes" }, { label: "No" }],
  recommended: 0,
};
const SECOND_QUESTION: RequestQuestion = {
  id: "second",
  header: "Second",
  question: "Continue with the second request?",
  options: [{ label: "Yes" }],
};

function renderedText(harness: RequestHarness): string {
  return harness.customFrames.flat().join("\n");
}

test("queued request abort settles immediately with cancelled while the first dialog is held", async () => {
  const harness = new RequestHarness();
  const coordinator = new RequestCoordinator();

  harness.holdNextDialog();
  const firstController = new AbortController();
  const first = coordinator.request(harness.ui, [FIRST_QUESTION], { signal: firstController.signal });
  await harness.waitForDialogOpen();

  const secondController = new AbortController();
  const second = coordinator.request(harness.ui, [SECOND_QUESTION], { signal: secondController.signal });
  secondController.abort();

  const outcome = await Promise.race([
    second.then((result) => `resolved:${result.cancelled}`, (error) => `rejected:${String(error)}`),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 500)),
  ]);
  assert.match(outcome, /^resolved:true$/);

  firstController.abort();
  const firstResult = await first;
  assert.equal(firstResult.cancelled, true);
  assert.equal(harness.maxConcurrentCustom, 1);
  assert.ok(!renderedText(harness).includes("Continue with the second request?"));
});

test("queued request timeout starts at enqueue and the timed-out request is never displayed", async () => {
  const harness = new RequestHarness();
  const coordinator = new RequestCoordinator();

  harness.holdNextDialog();
  const firstController = new AbortController();
  const first = coordinator.request(harness.ui, [FIRST_QUESTION], { signal: firstController.signal });
  await harness.waitForDialogOpen();

  const enqueuedAt = Date.now();
  const second = coordinator.request(harness.ui, [SECOND_QUESTION], { timeout: 100 });
  const outcome = await Promise.race([
    second.then((result) => `resolved:${result.cancelled}`, (error) => `rejected:${String(error)}`),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 500)),
  ]);
  assert.match(outcome, /^resolved:true$/);
  assert.ok(Date.now() - enqueuedAt < 500, "timeout must start at enqueue, not at display");

  firstController.abort();
  const firstResult = await first;
  assert.equal(firstResult.cancelled, true);
  assert.equal(harness.maxConcurrentCustom, 1);
  assert.ok(!renderedText(harness).includes("Continue with the second request?"));
});

test("queued request displays with only the remaining timeout after the queue releases it", async () => {
  const harness = new RequestHarness();
  const coordinator = new RequestCoordinator();

  harness.holdNextDialog();
  const firstController = new AbortController();
  const first = coordinator.request(harness.ui, [FIRST_QUESTION], { signal: firstController.signal });
  await harness.waitForDialogOpen();

  const second = coordinator.request(harness.ui, [SECOND_QUESTION], { timeout: 1_500 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  harness.holdNextDialog();
  firstController.abort();
  await first;

  const secondResult = await second;
  assert.equal(secondResult.cancelled, true);
  const secondFrame = harness.customFrames.find((frame) => frame.join("\n").includes("Continue with the second request?"));
  assert.ok(secondFrame);
  assert.match(secondFrame.join("\n"), /closes in 1s/, "countdown reflects the enqueue deadline, not a fresh one");
});

test("render cache key includes terminal rows so a same-width height change re-renders the layout", async () => {
  const harness = new RequestHarness();
  let component: ReturnType<typeof createRequestComponent> | undefined;
  let tui: TUI | undefined;
  let finish: ((result: RequestDialogResult) => void) | undefined;
  harness.holdNextDialog();
  const pending = harness.ui.custom<RequestDialogResult>((capturedTui, theme, keybindings, done) => {
    tui = capturedTui;
    const created = createRequestComponent({
      tui: capturedTui,
      theme,
      keybindings,
      questions: normalizeRequestQuestions([FIRST_QUESTION]),
      done,
    });
    component = created;
    finish = done;
    return created;
  });

  assert.ok(component);
  assert.ok(tui);
  const tall = component.render(80);
  assert.ok(tall.join("\n").includes("╭"), "30-row terminal renders the framed layout");

  (tui.terminal as { rows: number }).rows = 8;
  const short = component.render(80);
  assert.ok(!short.join("\n").includes("╭"), "same width at 8 rows must render the compact layout");

  finish?.({ cancelled: true, results: [] });
  await pending;
});
