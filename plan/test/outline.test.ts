import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import planExtension from "../src/index.ts";
import { createPlanOutline } from "../src/outline.ts";
import { renderPlan } from "../src/output.ts";
import type { PlanState } from "../src/state.ts";
import { ExtensionHarness, InMemoryPlanArtifactStore } from "./harness.ts";

async function submittedHarness(
  width: number,
  plan: string,
  copyText: (text: string) => Promise<void> = async () => undefined,
): Promise<ExtensionHarness> {
  const harness = new ExtensionHarness(undefined, true, { terminalWidth: width, terminalRows: 40 });
  planExtension(harness.api, { artifactStore: new InMemoryPlanArtifactStore(), copyText });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  await harness.tool("submit_plan", { summary: "Outline review", plan, steps: ["Verify"] });
  return harness;
}

const REVIEW_BODY = [
  "## Start heading",
  "",
  ...Array.from({ length: 26 }, (_, index) => `introductory line ${index + 1}`),
  "",
  "### Middle heading with 中文 and 🙂",
  "",
  ...Array.from({ length: 26 }, (_, index) => `middle line ${index + 1}`),
  "",
  "Final Setext heading",
  "====================",
].join("\n");

test("Markdown outline lexes top-level ATX and Setext headings", () => {
  const body = [
    "# **Strong** [link](https://example.test) `code` ![image alt](image.png) <span>html</span>",
    "",
    "##",
    "",
    "#### Jumped level",
    "",
    "Setext title",
    "===",
    "",
    "```md",
    "## fenced faux heading",
    "```",
    "",
    "    ## indented faux heading",
    "",
    "> ## quote faux heading",
    "",
    "- ## list faux heading",
  ].join("\n");
  const outline = createPlanOutline(body);

  assert.deepEqual(outline.entries.map(({ depth, text }) => ({ depth, text })), [
    { depth: 1, text: "Strong link code image alt <span>html</span>" },
    { depth: 2, text: "(untitled heading)" },
    { depth: 4, text: "Jumped level" },
    { depth: 1, text: "Setext title" },
  ]);
  assert.equal(outline.stripDecoratedBody(), body);
  assert.equal(outline.entries.filter((entry) => entry.text === "(untitled heading)").length, 1);
});

test("Review outline uses rendered targets and responsive split layout", async () => {
  const harness = await submittedHarness(100, REVIEW_BODY);
  harness.setCustomResponses("Stay in plan mode");
  harness.setCustomInputs("\t", "\x1b[B", "\r");
  await harness.command("plan", "review");
  const view = harness.customViews.at(-1);
  assert.ok(view);
  assert.equal(view.length, 40);
  assert.ok(view.every((line) => visibleWidth(line) === 100));
  assert.match(view.join("\n"), /Outline/);
  assert.match(view.join("\n"), /Start heading/);
  assert.match(view.join("\n"), /Middle heading with 中文 and 🙂/);
  assert.match(view[3], /Middle heading with 中文 and 🙂/, "heading jump starts at the mapped rendered line");
  assert.equal(view.some((line) => line.includes("_plan-outline:")), false);

  harness.setCustomResponses("Stay in plan mode");
  harness.setCustomInputs("\t", "\x1b[F", "\r");
  await harness.command("plan", "review");
  const eofView = harness.customViews.at(-1);
  assert.ok(eofView);
  assert.match(eofView.join("\n"), /Final Setext heading/, "EOF heading remains visible after scroll clamping");
});

test("Review inherits host semantic theme tokens while retaining action semantics", async () => {
  const harness = await submittedHarness(100, "## Heading\n\nBody copy.\n\n[link](https://example.test)\n\n`code`");
  harness.setCustomResponses("Stay in plan mode");
  await harness.command("plan", "review");
  const view = harness.customViews.at(-1);
  assert.ok(view);
  const rendered = view.join("\n");
  assert.match(rendered, /\u001b\[34m(?:\u001b\[[0-9;]*m)*Heading/, "heading uses mdHeading");
  assert.match(rendered, /\u001b\[37mBody copy\./, "body uses text");
  assert.match(rendered, /\u001b\[94m(?:\u001b\[[0-9;]*m)*link/, "link uses mdLink");
  assert.match(rendered, /\u001b\[35mcode/, "inline code uses mdCode");
  assert.match(rendered, /\u001b\[90mReview the complete plan/, "supporting copy uses muted");
  assert.match(rendered, /\u001b\[32m/, "Execute retains its success color");
  assert.match(rendered, /\u001b\[31m/, "Cancel retains its error color");
  assert.ok(view.every((line) => visibleWidth(line) === 100));
});

test("Review outline falls back to a narrow focus list and skips absent outlines", async () => {
  const narrow = await submittedHarness(71, REVIEW_BODY);
  narrow.setCustomResponses("Stay in plan mode");
  narrow.setCustomInputs("\t", "\x1b[B", "\r");
  await narrow.command("plan", "review");
  const narrowView = narrow.customViews.at(-1);
  assert.ok(narrowView);
  assert.match(narrowView.join("\n"), /Outline/);
  assert.match(narrowView.join("\n"), /Middle heading with 中文 and 🙂/);
  assert.ok(narrowView.every((line) => visibleWidth(line) === 71));
  assert.match(narrowView[3], /Middle heading with 中文 and 🙂/, "narrow Outline Enter jumps to the mapped preview line");

  const noHeadings = await submittedHarness(71, "plain body without Markdown headings");
  noHeadings.setCustomResponses("Stay in plan mode");
  noHeadings.setCustomInputs("\t");
  await noHeadings.command("plan", "review");
  const noHeadingView = noHeadings.customViews.at(-1);
  assert.ok(noHeadingView);
  assert.match(noHeadingView.join("\n"), /Plan review.*actions/);
  assert.doesNotMatch(noHeadingView.join("\n"), /Outline · \d+\/\d+/);
});

test("responsive Review compact rows stay within narrow terminals", async () => {
  const harness = await submittedHarness(12, REVIEW_BODY);
  harness.setCustomResponses("Stay in plan mode");
  await harness.command("plan", "review");
  const view = harness.customViews.at(-1);
  assert.ok(view);
  assert.ok(view.every((line) => visibleWidth(line) <= 12));
});

test("Copy keeps the complete undecorated Plan payload", async () => {
  const copied: string[] = [];
  const harness = await submittedHarness(100, "## Copy heading\n\nCopy the real Plan only.", async (text) => {
    copied.push(text);
  });
  harness.setCustomResponses("Stay in plan mode");
  harness.setCustomInputs("c");
  await harness.command("plan", "review");
  const submitted = [...harness.entries].reverse().find((entry) => {
    return entry.customType === "plan-state-v4"
      && entry.data && typeof entry.data === "object"
      && "action" in entry.data && entry.data.action === "submit";
  });
  assert.ok(submitted?.data && typeof submitted.data === "object" && "state" in submitted.data);
  const state = submitted.data.state as PlanState;
  assert.deepEqual(copied, [renderPlan(state)]);
  assert.equal(harness.customCompletionStates.at(-1), false);
});
