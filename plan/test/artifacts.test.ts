import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import planExtension from "../src/index.ts";
import { createPlanArtifactStore } from "../src/artifacts.ts";
import { ExtensionHarness } from "./harness.ts";

async function makeTemporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "plan-artifact-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function submitPersistentPlan(
  harness: ExtensionHarness,
  summary: string,
  plan: string,
): Promise<{ details: Record<string, unknown>; text: string }> {
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  const result = await harness.tool("submit_plan", { summary, plan, steps: ["Verify"] });
  assert.ok(result && typeof result === "object" && "details" in result && result.details && typeof result.details === "object");
  assert.ok("content" in result && Array.isArray(result.content));
  const firstContent = result.content[0];
  assert.ok(firstContent && typeof firstContent === "object" && "text" in firstContent && typeof firstContent.text === "string");
  return { details: result.details as Record<string, unknown>, text: firstContent.text };
}

test("Plan artifact store writes private immutable body mirrors", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const sessionFile = join(directory, "session.jsonl");
  const store = createPlanArtifactStore();
  const path = await store.write("## Probe\n\nthird-party-preview", { sessionFile, sessionId: "session-1" });

  assert.equal(path, join(directory, ".plan-artifacts", "session-1", `${path.split("/").at(-1)}`));
  assert.equal(await readFile(path, "utf8"), "## Probe\n\nthird-party-preview\n");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, ".plan-artifacts"))).mode & 0o777, 0o700);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);

  const foreign = join(directory, "foreign.md");
  await writeFile(foreign, "foreign", "utf8");
  await store.discard(foreign);
  assert.equal(await readFile(foreign, "utf8"), "foreign");
  await store.cleanupEphemeral();
  assert.equal(await readFile(path, "utf8"), "## Probe\n\nthird-party-preview\n");
  await store.discard(path);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("Plan artifact store abort and ephemeral cleanup leave no preview behind", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const sessionFile = join(directory, "session.jsonl");
  const store = createPlanArtifactStore();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.write("body", { sessionFile, sessionId: "session-1" }, controller.signal));
  assert.deepEqual(await readdir(directory), []);

  const ephemeralPath = await store.write("ephemeral", { sessionId: "session-1" });
  assert.equal(await readFile(ephemeralPath, "utf8"), "ephemeral\n");
  await store.cleanupEphemeral();
  await assert.rejects(readFile(ephemeralPath, "utf8"), { code: "ENOENT" });
  await assert.rejects(store.write("body", { sessionId: "../escape" }), /session ID is invalid/);
});

test("artifact persistence publishes matching planPath and retains persistent history", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const sessionFile = join(directory, "session.jsonl");
  const store = createPlanArtifactStore();
  const harness = new ExtensionHarness(undefined, true, { sessionFile });
  planExtension(harness.api, { artifactStore: store });

  const first = await submitPersistentPlan(harness, "Artifact probe", "  ## Probe\n\nthird-party-preview  ");
  assert.equal(typeof first.details.planPath, "string");
  const firstPath = first.details.planPath as string;
  assert.match(firstPath, /\.plan-artifacts\/session-1\/[^/]+\.md$/);
  assert.equal(await readFile(firstPath, "utf8"), "## Probe\n\nthird-party-preview\n");
  assert.equal(first.text.includes(firstPath), false);
  const firstJournal = harness.entries.at(-1)?.data as { action?: string; state?: { planPath?: string } };
  assert.equal(firstJournal.action, "submit");
  assert.equal(firstJournal.state?.planPath, firstPath);

  await harness.command("plan", "refine");
  const second = await harness.tool("submit_plan", {
    summary: "Artifact refinement",
    plan: "## Replacement\n\nnew immutable body",
    steps: ["Verify"],
  }) as { details: Record<string, unknown> };
  const secondPath = second.details.planPath as string;
  assert.notEqual(secondPath, firstPath);
  assert.equal(await readFile(firstPath, "utf8"), "## Probe\n\nthird-party-preview\n");
  assert.equal(await readFile(secondPath, "utf8"), "## Replacement\n\nnew immutable body\n");

  await harness.emit("session_tree", { type: "session_tree" });
  await harness.command("plan", "cancel");
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(await readFile(firstPath, "utf8"), "## Probe\n\nthird-party-preview\n");
  assert.equal(await readFile(secondPath, "utf8"), "## Replacement\n\nnew immutable body\n");
});

test("Plan artifact persistence survives approval, completion, and shutdown", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const sessionFile = join(directory, "session.jsonl");
  const store = createPlanArtifactStore();
  const harness = new ExtensionHarness(undefined, true, { sessionFile });
  planExtension(harness.api, { artifactStore: store });
  const submission = await submitPersistentPlan(harness, "Complete", "## Complete\n\npersistent preview");
  const path = submission.details.planPath as string;

  await harness.command("plan", "approve");
  await harness.tool("update_plan_step", { id: "step-1", status: "completed" });
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(await readFile(path, "utf8"), "## Complete\n\npersistent preview\n");
});
