import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import goalExtension from "../../goal/src/index.ts";
import requestUIExtension from "../src/index.ts";
import { requestFromUser } from "../src/protocol.ts";
import type { AskAnswerDetails } from "../src/tool.ts";
import { requestFromExternalFixture } from "./external-fixture.ts";
import { RequestHarness } from "./harness.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: AskAnswerDetails | { results: AskAnswerDetails[] };
}

const YES_NO = [
  { label: "Yes", description: "Proceed with the proposed behavior." },
  { label: "No", description: "Keep the current behavior." },
];

async function startRequestExtension(harness: RequestHarness): Promise<void> {
  requestUIExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
}

test("ask tool matches the single-choice, multi-select, and Other interaction model", async () => {
  const harness = new RequestHarness();
  await startRequestExtension(harness);

  harness.queueDialog("\x1b[B", "\r");
  const single = await harness.tool("ask", {
    i: "Confirm deployment",
    questions: [{
      id: "deploy",
      header: "Deployment",
      question: "Deploy this change?",
      options: YES_NO,
      recommended: 0,
      multi: false,
    }],
  }) as ToolResult;
  assert.equal(single.content[0]?.text, "User selected: No");
  assert.deepEqual((single.details as AskAnswerDetails).selectedOptions, ["No"]);
  const firstFrame = harness.customFrames[0];
  assert.ok(firstFrame);
  assert.match(firstFrame.join("\n"), /Ask · SELECT ONE/);
  assert.match(firstFrame.join("\n"), /\u001b\[96m╭/, "active frame uses borderAccent");
  assert.match(firstFrame.join("\n"), /\u001b\[48;5;238m/, "active choice uses selectedBg");
  assert.match(firstFrame.join("\n"), /Recommended/);
  assert.match(firstFrame.join("\n"), /Other \(type your own\)/);
  assert.ok(firstFrame.every((line) => visibleWidth(line) === 80));

  harness.queueDialog(" ", "\x1b[B", " ", "\r");
  const multiple = await harness.tool("ask", {
    i: "Select checks",
    questions: [{
      id: "checks",
      header: "Checks",
      question: "Which checks should run?",
      options: [{ label: "Typecheck" }, { label: "Tests" }],
      multi: true,
      recommended: 0,
    }],
  }) as ToolResult;
  assert.deepEqual((multiple.details as AskAnswerDetails).selectedOptions, ["Typecheck", "Tests"]);

  harness.queueDialog("\x1b[B", "\x1b[B", "\r", "c", "u", "s", "t", "o", "m", "\r");
  const custom = await harness.tool("ask", {
    i: "Collect alternative",
    questions: [{
      id: "alternative",
      header: "Alternative",
      question: "Choose an implementation.",
      options: [{ label: "A" }, { label: "B" }],
      recommended: 0,
    }],
  }) as ToolResult;
  assert.deepEqual(custom.details, {
    id: "alternative",
    multi: false,
    selectedOptions: [],
    customInput: "custom",
  });

  const tool = harness.getTool("ask");
  const renderedCall = tool.renderCall?.({
    i: "Preview",
    questions: [{ id: "deploy", question: "Deploy?", options: YES_NO, recommended: 0 }],
  }, harness.ui.theme, { expanded: true }).render(100).join("\n");
  assert.match(renderedCall ?? "", /Ask 1 question/);
  assert.match(renderedCall ?? "", /\[deploy\]/);
  assert.match(renderedCall ?? "", /Proceed with the proposed behavior/);
});

test("single-choice Review replaces an option with Other instead of returning both", async () => {
  const harness = new RequestHarness();
  await startRequestExtension(harness);
  harness.queueDialog(
    "\r",
    "\r",
    "\x1b[A",
    "\x1b[A",
    "\r",
    "\x1b[B",
    "\x1b[B",
    "\r",
    "x",
    "\r",
    "\r",
    "\r",
  );

  const result = await harness.tool("ask", {
    questions: [
      { id: "first", question: "First?", options: [{ label: "A" }, { label: "B" }], recommended: 0 },
      { id: "second", question: "Second?", options: YES_NO, recommended: 0 },
    ],
  }) as ToolResult;

  const details = result.details as { results: AskAnswerDetails[] };
  assert.deepEqual(details.results[0], {
    id: "first",
    multi: false,
    selectedOptions: [],
    customInput: "x",
  });
});

test("ask renderers neutralize unvalidated terminal control sequences", () => {
  const harness = new RequestHarness();
  requestUIExtension(harness.api);
  const osc = "\u001b]52;c;UkVQUk9fT0s=\u0007";
  const rendered = harness.getTool("ask").renderCall?.({
    questions: [{ id: "unsafe", question: osc, options: [{ label: "Yes" }] }],
  }, harness.ui.theme, { expanded: true }).render(80).join("\n") ?? "";

  assert.equal(rendered.includes(osc), false);
  assert.match(rendered, /�/);
});

test("multi-question requests navigate through Review and allow unanswered submission", async () => {
  const harness = new RequestHarness({ terminalWidth: 88 });
  await startRequestExtension(harness);
  harness.queueDialog("\r", "\x1b[B", "\r", "\t", "\r");

  const result = await requestFromExternalFixture(harness.api.events, [
    { id: "first", header: "First", question: "First confirmation?", options: YES_NO, recommended: 0 },
    { id: "second", header: "Second", question: "Second confirmation?", options: YES_NO, recommended: 0 },
    { id: "third", header: "Third", question: "Third confirmation?", options: YES_NO, recommended: 0 },
  ]);

  assert.deepEqual(result.results.map((answer) => answer.selectedOptions), [["Yes"], ["No"], []]);
  const reviewFrame = [...harness.customFrames].reverse().find((frame) => frame.join("\n").includes("Review answers"));
  assert.ok(reviewFrame);
  assert.match(reviewFrame.join("\n"), /1 unanswered question; Enter still submits\./);
  assert.match(reviewFrame.join("\n"), /✓ Submit/);
  assert.ok(reviewFrame.every((line) => visibleWidth(line) === 88));
});

test("peer extensions inherit select, confirm, and input without changing return semantics", async () => {
  const harness = new RequestHarness();
  await startRequestExtension(harness);
  assert.notEqual(harness.ui.select, harness.originalSelect);
  assert.notEqual(harness.ui.confirm, harness.originalConfirm);
  assert.notEqual(harness.ui.input, harness.originalInput);

  harness.queueDialog("\x1b[B", "\r");
  assert.equal(await harness.context.ui.select("Choose target", ["Alpha", "Beta"]), "Beta");

  harness.queueDialog("\r");
  assert.equal(await harness.context.ui.confirm("Apply", "Apply this change?"), true);

  harness.queueDialog("v", "a", "l", "u", "e", "\r");
  assert.equal(await harness.context.ui.input("Value", "Type a value"), "value");
  harness.queueDialog("\r");
  assert.equal(await harness.context.ui.input("Optional", "May be empty"), "");
  harness.queueDialog(" ", "v", "a", "l", "u", "e", " ", "\r");
  assert.equal(await harness.context.ui.input("Whitespace", "Preserve it"), " value ");

  harness.queueNativeSelect(" spaced ");
  assert.equal(await harness.context.ui.select("Fallback", [" spaced "]), " spaced ");
  assert.equal(harness.nativeCalls.at(-1)?.method, "select");

  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
  assert.equal(harness.ui.select, harness.originalSelect);
  assert.equal(harness.ui.confirm, harness.originalConfirm);
  assert.equal(harness.ui.input, harness.originalInput);
});

test("Goal replacement confirmation inherits the unified Request renderer", async () => {
  const harness = new RequestHarness();
  requestUIExtension(harness.api);
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  await harness.command("goal", "Keep the first objective");
  harness.queueDialog("\x1b[B", "\r");
  await harness.command("goal", "Replace with a second objective");

  const confirmation = harness.customFrames.at(-1);
  assert.ok(confirmation);
  assert.match(confirmation.join("\n"), /Ask · SELECT ONE/);
  assert.match(confirmation.join("\n"), /Replace active goal\?/);
  assert.match(confirmation.join("\n"), /Current: Keep the first objective/);
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
});

test("external requests serialize, cancel, timeout, and shut down safely", async () => {
  const harness = new RequestHarness();
  await startRequestExtension(harness);
  const question = [{ id: "confirm", header: "Confirm", question: "Continue?", options: YES_NO, recommended: 0 }];

  harness.queueDialog("\r");
  harness.queueDialog("\x1b[B", "\r");
  const [first, second] = await Promise.all([
    requestFromExternalFixture(harness.api.events, question),
    requestFromExternalFixture(harness.api.events, question),
  ]);
  assert.deepEqual(first.results[0]?.selectedOptions, ["Yes"]);
  assert.deepEqual(second.results[0]?.selectedOptions, ["No"]);
  assert.equal(harness.maxConcurrentCustom, 1);

  harness.queueDialog("\x1b");
  await assert.rejects(harness.tool("ask", {
    i: "Cancel request",
    questions: [{ id: "cancel", question: "Cancel?", options: YES_NO }],
  }), /cancelled by the user/);

  harness.holdNextDialog();
  assert.equal(await harness.context.ui.select("Timeout", ["Yes", "No"], { timeout: 5 }), undefined);

  harness.holdNextDialog();
  const pending = harness.context.ui.select("Shutdown", ["Yes", "No"]);
  await harness.waitForDialogOpen();
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(await pending, undefined);
  assert.equal(harness.ui.select, harness.originalSelect);
});

test("missing and headless Request UI paths fail closed while compact rendering stays bounded", async () => {
  const missing = new RequestHarness();
  await assert.rejects(requestFromUser(missing.api, [{
    id: "missing",
    question: "Loaded?",
    options: [{ label: "Yes" }],
  }]), /not loaded or not ready/);

  const headless = new RequestHarness({ hasUI: false, mode: "print" });
  await startRequestExtension(headless);
  await assert.rejects(headless.tool("ask", {
    i: "Headless request",
    questions: [{ id: "headless", question: "Continue?", options: YES_NO }],
  }), /interactive TUI/);

  const narrow = new RequestHarness({ terminalWidth: 12 });
  await startRequestExtension(narrow);
  narrow.queueDialog("\r");
  assert.equal(await narrow.context.ui.select("Narrow", ["Yes", "No"]), "Yes");
  assert.ok(narrow.customFrames.flat().every((line) => visibleWidth(line) <= 12));
});
