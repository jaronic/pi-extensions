import assert from "node:assert/strict";
import test from "node:test";
import { isPlanToolAllowed, selectPlanTools } from "../src/tool-policy.ts";

test("planning preserves external interaction tools without adding Plan-owned choices", () => {
  const active = selectPlanTools(
    ["read", "grep", "bash", "edit", "write", "lsp", "ast_grep_search", "ast_grep_edit", "rg", "ask", "get_goal", "update_goal", "unknown_writer"],
    "planning",
  );
  assert.deepEqual(active, ["read", "rg", "lsp", "ast_grep_search", "ask", "get_goal", "submit_plan", "report_plan_blocked"]);
  assert.equal(isPlanToolAllowed("request_plan_choice", "planning"), false);
  assert.equal(isPlanToolAllowed("answer_plan_choice", "planning"), false);
});

test("awaiting approval removes submission and keeps workspace read-only", () => {
  assert.equal(isPlanToolAllowed("submit_plan", "awaitingApproval"), false);
  assert.equal(isPlanToolAllowed("read", "awaitingApproval"), true);
  assert.equal(isPlanToolAllowed("rg", "awaitingApproval"), true);
  assert.equal(isPlanToolAllowed("ast_grep_search", "awaitingApproval"), true);
  assert.equal(isPlanToolAllowed("ast_grep_edit", "awaitingApproval"), false);
  assert.equal(isPlanToolAllowed("bash", "awaitingApproval"), false);
  assert.equal(isPlanToolAllowed("update_goal", "awaitingApproval"), false);
  assert.equal(isPlanToolAllowed("unknown_writer", "awaitingApproval"), false);
});

test("blocked Plan reporting is available only while planning", () => {
  assert.equal(isPlanToolAllowed("report_plan_blocked", "planning"), true);
  assert.equal(isPlanToolAllowed("report_plan_blocked", "blocked"), false);
});

test("executing and off phases do not restrict tools", () => {
  assert.equal(isPlanToolAllowed("bash", "executing"), true);
  assert.equal(isPlanToolAllowed("unknown_writer", "off"), true);
});
