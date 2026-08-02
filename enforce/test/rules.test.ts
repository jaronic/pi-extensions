import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_RULES,
  evaluateToolCall,
  interpolate,
  matchGlob,
  matchRule,
  normalizeRule,
  renderMatchText,
} from "../src/rules.ts";
import type { EnforceRule, EnforceRuleInput } from "../src/types.ts";

function rule(id: string, input: EnforceRuleInput): EnforceRule {
  return normalizeRule(id, input, "builtin");
}

test("every built-in rule is a conservative nudge with a recommendation", () => {
  for (const [id, input] of Object.entries(BUILTIN_RULES)) {
    assert.equal(input.action, "nudge", `${id} must default to nudge`);
    assert.equal(typeof input.recommend, "string", `${id} must name a recommended tool`);
  }
});

test("matchGlob supports *, **, and ?", () => {
  assert.equal(matchGlob("*.ts", "a.ts"), true);
  assert.equal(matchGlob("*.ts", "src/a.ts"), false);
  assert.equal(matchGlob("**/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/**", "src/deep/a.ts"), true);
  assert.equal(matchGlob("a?c", "abc"), true);
  assert.equal(matchGlob("a?c", "ac"), false);
  assert.equal(matchGlob("a+b.ts", "a+b.ts"), true);
});

test("interpolate substitutes known values and keeps unknown placeholders literal", () => {
  assert.equal(interpolate("use ${tool} with ${pattern}", { tool: "lsp", pattern: "Foo" }), "use lsp with Foo");
  assert.equal(interpolate("keep ${missing}", {}), "keep ${missing}");
  const long = "x".repeat(500);
  assert.ok(interpolate("${pattern}", { pattern: long }).length < long.length);
});

test("normalizeRule accepts a complete valid rule", () => {
  const normalized = rule("custom-gate", {
    tool: "bash",
    action: "gate",
    message: "Use rg instead.",
    example: { tool: "rg", input: { pattern: "${1}" } },
    paramField: "command",
    paramPattern: "grep\\s+-r\\s+(\\S+)",
    fileGlob: "src/**",
    recommend: "rg",
    once: false,
  });
  assert.equal(normalized.tool, "bash");
  assert.equal(normalized.action, "gate");
  assert.equal(normalized.fileParam, "path");
  assert.equal(normalized.once, false);
});

test("normalizeRule rejects malformed rules", () => {
  const base: EnforceRuleInput = { tool: "grep", action: "nudge", message: "m" };
  assert.throws(() => rule("Bad Id!", base), /id must be/);
  assert.throws(() => rule("ok", { ...base, tool: "" }), /tool must be/);
  assert.throws(() => rule("ok", { ...base, action: "block" as never }), /action must be/);
  assert.throws(() => rule("ok", { ...base, message: " " }), /message must be/);
  assert.throws(() => rule("ok", { ...base, paramPattern: "([" , paramField: "pattern" }), /does not compile/);
  assert.throws(() => rule("ok", { ...base, paramPattern: "x" }), /requires paramField/);
  assert.throws(() => rule("ok", { ...base, message: "x".repeat(1001) }), /at most/);
});

test("matchRule checks tool, parameter regex, and file glob", () => {
  const candidate = rule("symbols", {
    tool: "grep",
    action: "nudge",
    message: "m ${pattern} ${0}",
    paramField: "pattern",
    paramPattern: "^([A-Z][A-Za-z0-9]+)$",
    fileGlob: "src/**",
  });
  assert.equal(matchRule(candidate, "read", { pattern: "Foo" }), undefined);
  assert.equal(matchRule(candidate, "grep", { pattern: "foo" }), undefined);
  assert.equal(matchRule(candidate, "grep", { pattern: "Foo", path: "lib/a.ts" }), undefined);
  const matched = matchRule(candidate, "grep", { pattern: "Foo", path: "src/a.ts" });
  assert.ok(matched);
  assert.equal(matched.values["pattern"], "Foo");
  assert.equal(matched.values["1"], "Foo");
});

test("renderMatchText interpolates message and example", () => {
  const candidate = rule("symbols", {
    tool: "grep",
    action: "nudge",
    message: "Prefer lsp for ${pattern}.",
    example: { tool: "lsp", input: { action: "workspace_symbols", query: "${pattern}" } },
    paramField: "pattern",
    paramPattern: "^[A-Za-z]+$",
  });
  const matched = matchRule(candidate, "grep", { pattern: "parseConfig" });
  assert.ok(matched);
  const text = renderMatchText(matched);
  assert.match(text, /Prefer lsp for parseConfig\./);
  assert.match(text, /Suggested replacement call:/);
  assert.match(text, /"query": "parseConfig"/);
});

test("evaluateToolCall skips rules whose recommended tool is inactive", () => {
  const rules = [rule("symbols", {
    tool: "grep",
    action: "nudge",
    message: "m",
    paramField: "pattern",
    paramPattern: "^[A-Za-z]+$",
    recommend: "lsp",
  })];
  assert.equal(evaluateToolCall(rules, ["read", "grep"], "grep", { pattern: "Foo" }), undefined);
  const decision = evaluateToolCall(rules, ["read", "grep", "lsp"], "grep", { pattern: "Foo" });
  assert.equal(decision?.kind, "nudge");
});

test("evaluateToolCall prefers a gate over a nudge", () => {
  const nudge = rule("a-nudge", { tool: "bash", action: "nudge", message: "nudge" });
  const gate = rule("b-gate", { tool: "bash", action: "gate", message: "gate", example: { tool: "rg" } });
  const decision = evaluateToolCall([nudge, gate], [], "bash", {});
  assert.equal(decision?.kind, "gate");
  assert.equal(decision?.ruleId, "b-gate");
  assert.equal(evaluateToolCall([nudge], [], "bash", {})?.ruleId, "a-nudge");
  assert.equal(evaluateToolCall([nudge], [], "read", {}), undefined);
});
