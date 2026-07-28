import assert from "node:assert/strict";
import test from "node:test";
import { isPlanToolAllowed, selectPlanTools } from "../src/tool-policy.ts";

test("planning exposes only explicit read-only tools and Plan submission choices", () => {
  const active = selectPlanTools(
    ["read", "grep", "bash", "edit", "write", "lsp", "rg", "get_goal", "update_goal", "unknown_writer"],
    "planning",
  );
  assert.deepEqual(active, ["read", "rg", "grep", "lsp", "submit_plan", "report_plan_blocked", "request_plan_choice"]);
});

test("awaiting approval removes submission and keeps workspace read-only", () => {
  assert.equal(isPlanToolAllowed("submit_plan", "awaitingApproval"), false);
  assert.equal(isPlanToolAllowed("read", "awaitingApproval"), true);
  assert.equal(isPlanToolAllowed("rg", "awaitingApproval"), true);
  assert.equal(isPlanToolAllowed("bash", "awaitingApproval"), false);
  assert.equal(isPlanToolAllowed("update_goal", "awaitingApproval"), false);
  assert.equal(isPlanToolAllowed("unknown_writer", "awaitingApproval"), false);
});

test("blocked Plan reporting is available only while planning", () => {
  assert.equal(isPlanToolAllowed("report_plan_blocked", "planning"), true);
  assert.equal(isPlanToolAllowed("report_plan_blocked", "blocked"), false);
});

test("off phase does not restrict tools", () => {
  assert.equal(isPlanToolAllowed("unknown_writer", "off"), true);
});
