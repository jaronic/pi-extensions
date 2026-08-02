import type {
  EnforceDecision,
  EnforceRule,
  EnforceRuleInput,
  EnforceRuleMatch,
  EnforceRuleSource,
} from "./types.ts";

export const MAX_RULE_ID_CHARS = 64;
export const MAX_RULE_TOOL_CHARS = 64;
export const MAX_RULE_MESSAGE_CHARS = 1000;
export const MAX_RULE_PATTERN_CHARS = 500;
export const MAX_RULE_GLOB_CHARS = 256;
export const MAX_RULE_EXAMPLE_KEYS = 20;
export const MAX_INTERPOLATION_VALUE_CHARS = 200;
export const MAX_DECISION_TEXT_CHARS = 4000;

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Built-in rules are intentionally conservative: every one is a nudge, and
 * each fires only while the recommended tool is actually active. Gate actions
 * exist only when a user config file explicitly upgrades a rule.
 */
export const BUILTIN_RULES: Record<string, EnforceRuleInput> = {
  "prefer-lsp-symbols-grep": {
    tool: "grep",
    action: "nudge",
    paramField: "pattern",
    paramPattern: "^[A-Za-z_$][A-Za-z0-9_$]{2,64}$",
    recommend: "lsp",
    message:
      "The grep pattern is a bare identifier. The lsp tool resolves symbols semantically " +
      "(definitions, references, workspace symbols) and usually answers this faster than text search.",
    example: { tool: "lsp", input: { action: "workspace_symbols", query: "${pattern}" } },
  },
  "prefer-lsp-symbols-rg": {
    tool: "rg",
    action: "nudge",
    paramField: "pattern",
    paramPattern: "^[A-Za-z_$][A-Za-z0-9_$]{2,64}$",
    recommend: "lsp",
    message:
      "The rg pattern is a bare identifier. The lsp tool resolves symbols semantically " +
      "(definitions, references, workspace symbols) and usually answers this faster than text search.",
    example: { tool: "lsp", input: { action: "workspace_symbols", query: "${pattern}" } },
  },
  "prefer-ast-grep-search-grep": {
    tool: "grep",
    action: "nudge",
    paramField: "pattern",
    paramPattern: "\\$\\$\\$",
    recommend: "ast_grep_search",
    message:
      "The grep pattern contains an ast-grep meta-variable ($$$), which text search cannot interpret. " +
      "Use the ast_grep_search tool so the pattern is matched structurally.",
    example: { tool: "ast_grep_search", input: { pattern: "${pattern}", language: "<language>" } },
  },
  "prefer-ast-grep-search-rg": {
    tool: "rg",
    action: "nudge",
    paramField: "pattern",
    paramPattern: "\\$\\$\\$",
    recommend: "ast_grep_search",
    message:
      "The rg pattern contains an ast-grep meta-variable ($$$), which text search cannot interpret. " +
      "Use the ast_grep_search tool so the pattern is matched structurally.",
    example: { tool: "ast_grep_search", input: { pattern: "${pattern}", language: "<language>" } },
  },
  "prefer-ast-grep-edit-sed": {
    tool: "bash",
    action: "nudge",
    paramField: "command",
    paramPattern: "(^|[|;&]\\s*)sed\\s+(-[A-Za-z]+\\s+)*-i\\b",
    recommend: "ast_grep_edit",
    message:
      "In-place sed rewrites are brittle for source code. The ast_grep_edit tool rewrites structural " +
      "patterns with a mandatory preview step, which is safer for code edits.",
    example: {
      tool: "ast_grep_edit",
      input: { action: "preview", path: "<file>", language: "<language>", pattern: "<structural pattern>", rewrite: "<replacement>" },
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function normalizeRule(id: string, input: EnforceRuleInput, source: EnforceRuleSource): EnforceRule {
  if (!RULE_ID_PATTERN.test(id) || id.length > MAX_RULE_ID_CHARS) {
    throw new Error(`rule ${JSON.stringify(id)}: id must be ${MAX_RULE_ID_CHARS} or fewer lowercase letters, digits, and hyphens`);
  }
  if (typeof input.tool !== "string" || input.tool.length === 0 || input.tool.length > MAX_RULE_TOOL_CHARS) {
    throw new Error(`rule ${id}: tool must be a non-empty string of at most ${MAX_RULE_TOOL_CHARS} characters`);
  }
  if (input.action !== "nudge" && input.action !== "gate") {
    throw new Error(`rule ${id}: action must be "nudge" or "gate"`);
  }
  if (typeof input.message !== "string" || input.message.trim().length === 0 || input.message.length > MAX_RULE_MESSAGE_CHARS) {
    throw new Error(`rule ${id}: message must be a non-empty string of at most ${MAX_RULE_MESSAGE_CHARS} characters`);
  }
  if (input.example !== undefined) {
    if (!isRecord(input.example)) throw new Error(`rule ${id}: example must be an object`);
    if (Object.keys(input.example).length > MAX_RULE_EXAMPLE_KEYS) {
      throw new Error(`rule ${id}: example must have at most ${MAX_RULE_EXAMPLE_KEYS} keys`);
    }
  }
  if (input.paramField !== undefined && (typeof input.paramField !== "string" || input.paramField.length === 0)) {
    throw new Error(`rule ${id}: paramField must be a non-empty string`);
  }
  let paramPattern: RegExp | undefined;
  if (input.paramPattern !== undefined) {
    if (typeof input.paramPattern !== "string" || input.paramPattern.length === 0 || input.paramPattern.length > MAX_RULE_PATTERN_CHARS) {
      throw new Error(`rule ${id}: paramPattern must be a non-empty string of at most ${MAX_RULE_PATTERN_CHARS} characters`);
    }
    if (!input.paramField) throw new Error(`rule ${id}: paramPattern requires paramField`);
    try {
      paramPattern = new RegExp(input.paramPattern, "u");
    } catch (error) {
      throw new Error(`rule ${id}: paramPattern does not compile: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const fileParam = input.fileParam ?? "path";
  if (typeof fileParam !== "string" || fileParam.length === 0) {
    throw new Error(`rule ${id}: fileParam must be a non-empty string`);
  }
  if (input.fileGlob !== undefined && (typeof input.fileGlob !== "string" || input.fileGlob.length === 0 || input.fileGlob.length > MAX_RULE_GLOB_CHARS)) {
    throw new Error(`rule ${id}: fileGlob must be a non-empty string of at most ${MAX_RULE_GLOB_CHARS} characters`);
  }
  if (input.recommend !== undefined && (typeof input.recommend !== "string" || input.recommend.length === 0 || input.recommend.length > MAX_RULE_TOOL_CHARS)) {
    throw new Error(`rule ${id}: recommend must be a non-empty string of at most ${MAX_RULE_TOOL_CHARS} characters`);
  }
  return {
    id,
    tool: input.tool,
    action: input.action,
    message: input.message,
    example: input.example === undefined ? undefined : { ...input.example },
    paramField: input.paramField,
    paramPattern,
    fileParam,
    fileGlob: input.fileGlob,
    recommend: input.recommend,
    once: input.once ?? true,
    source,
  };
}

/** Minimal glob matcher: `*` within a path segment, `**` across segments, `?` one character. */
export function matchGlob(glob: string, value: string): boolean {
  let source = "^";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 2;
      } else {
        source += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      index += 1;
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      index += 1;
    }
  }
  source += "$";
  return new RegExp(source, "u").test(value);
}

/** Substitute `${name}` placeholders from values; unknown placeholders stay literal. */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{([^{}]+)\}/g, (raw, name: string) => {
    const value = values[name.trim()];
    return value === undefined ? raw : bounded(value, MAX_INTERPOLATION_VALUE_CHARS);
  });
}

function inputScalar(value: unknown): string | undefined {
  const kind = typeof value;
  if (kind === "string") return value as string;
  if (kind === "number" || kind === "boolean") return String(value);
  return undefined;
}

export function matchRule(rule: EnforceRule, toolName: string, input: Record<string, unknown>): EnforceRuleMatch | undefined {
  if (rule.tool !== toolName) return undefined;
  const values: Record<string, string> = {};
  if (rule.paramPattern && rule.paramField) {
    const scalar = inputScalar(input[rule.paramField]);
    if (scalar === undefined) return undefined;
    values[rule.paramField] = scalar;
    const match = rule.paramPattern.exec(scalar);
    if (!match) return undefined;
    values["0"] = match[0];
    for (let group = 1; group < match.length && group <= 9; group += 1) {
      const captured = match[group];
      if (captured !== undefined) values[String(group)] = captured;
    }
  }
  if (rule.fileGlob) {
    const file = inputScalar(input[rule.fileParam]);
    if (file === undefined || !matchGlob(rule.fileGlob, file)) return undefined;
    values[rule.fileParam] = file;
  }
  return { rule, values };
}

function renderExample(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") return interpolate(value, values);
  if (Array.isArray(value)) return value.map((entry) => renderExample(entry, values));
  if (isRecord(value)) {
    const rendered: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) rendered[key] = renderExample(entry, values);
    return rendered;
  }
  return value;
}

export function renderMatchText(match: EnforceRuleMatch): string {
  const { rule, values } = match;
  let text = interpolate(rule.message, values);
  if (rule.example) {
    const rendered = renderExample(rule.example, values);
    text += `\n\nSuggested replacement call:\n${JSON.stringify(rendered, null, 2)}`;
  }
  return bounded(text, MAX_DECISION_TEXT_CHARS);
}

/**
 * Evaluate rules against one tool call. Rules whose `recommend` tool is not
 * currently active never fire. A matching gate rule wins over any nudge.
 */
export function evaluateToolCall(
  rules: readonly EnforceRule[],
  activeTools: readonly string[],
  toolName: string,
  input: Record<string, unknown>,
): EnforceDecision | undefined {
  let firstNudge: EnforceRuleMatch | undefined;
  for (const rule of rules) {
    if (rule.recommend !== undefined && !activeTools.includes(rule.recommend)) continue;
    const match = matchRule(rule, toolName, input);
    if (!match) continue;
    if (rule.action === "gate") return { kind: "gate", ruleId: rule.id, text: renderMatchText(match) };
    if (!firstNudge) firstNudge = match;
  }
  if (firstNudge) return { kind: "nudge", ruleId: firstNudge.rule.id, text: renderMatchText(firstNudge) };
  return undefined;
}
