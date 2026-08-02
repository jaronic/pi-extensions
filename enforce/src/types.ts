export type EnforceAction = "nudge" | "gate";

export type EnforceRuleSource = "builtin" | "global" | "project";

/** Raw rule patch as accepted from enforce.json files. All fields optional so a patch can override one field of a built-in rule. */
export interface EnforceRuleInput {
  tool?: string;
  action?: EnforceAction;
  message?: string;
  example?: Record<string, unknown>;
  paramField?: string;
  paramPattern?: string;
  fileParam?: string;
  fileGlob?: string;
  recommend?: string;
  once?: boolean;
  disabled?: boolean;
}

/** Validated, normalized rule ready for matching. */
export interface EnforceRule {
  id: string;
  tool: string;
  action: EnforceAction;
  message: string;
  example?: Record<string, unknown>;
  paramField?: string;
  paramPattern?: RegExp;
  fileParam: string;
  fileGlob?: string;
  recommend?: string;
  once: boolean;
  source: EnforceRuleSource;
}

/** A rule that matched one concrete tool call, with interpolation values collected. */
export interface EnforceRuleMatch {
  rule: EnforceRule;
  values: Record<string, string>;
}

export type EnforceDecision =
  | { kind: "nudge"; ruleId: string; text: string }
  | { kind: "gate"; ruleId: string; text: string };

export interface EnforceConfig {
  rules: EnforceRule[];
  loadedFrom: string[];
  /** Set when a config file failed validation; rules then fall back to built-in nudge rules only (fail closed). */
  error?: string;
}

export interface EnforceConfigPathOptions {
  agentDir?: string;
  projectConfigDirName?: string;
}
