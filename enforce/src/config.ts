import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUILTIN_RULES, normalizeRule } from "./rules.ts";
import type {
  EnforceConfig,
  EnforceConfigPathOptions,
  EnforceRule,
  EnforceRuleInput,
  EnforceRuleSource,
} from "./types.ts";

const MAX_RULES = 100;

const RAW_CONFIG_KEYS: Record<string, true> = {
  rules: true,
};

const RULE_PATCH_KEYS = {
  tool: true,
  action: true,
  message: true,
  example: true,
  paramField: true,
  paramPattern: true,
  fileParam: true,
  fileGlob: true,
  recommend: true,
  once: true,
  disabled: true,
} satisfies Record<keyof EnforceRuleInput, true>;

export function enforceConfigPaths(
  cwd: string,
  includeProject: boolean,
  options: EnforceConfigPathOptions = {},
): string[] {
  const paths = [join(options.agentDir ?? getAgentDir(), "enforce.json")];
  if (includeProject) paths.push(join(cwd, options.projectConfigDirName ?? CONFIG_DIR_NAME, "enforce.json"));
  return paths;
}

/**
 * Load layered configuration: built-in defaults < global < project. Any
 * unreadable or invalid config file fails closed: the result keeps only the
 * built-in nudge rules and carries the error message for `/enforce status`.
 */
export async function loadConfig(
  cwd: string,
  includeProject: boolean,
  options: EnforceConfigPathOptions = {},
): Promise<EnforceConfig> {
  const patches: Array<{ path: string; source: EnforceRuleSource; rules: Record<string, EnforceRuleInput> }> = [];
  const paths = enforceConfigPaths(cwd, includeProject, options);
  try {
    for (const [index, path] of paths.entries()) {
      const rules = await readConfigFile(path);
      if (rules) patches.push({ path, source: index === 0 ? "global" : "project", rules });
    }
    return mergeRules(patches);
  } catch (error) {
    return {
      rules: mergeRules([]).rules,
      loadedFrom: [],
      error: `Invalid enforce configuration; using built-in nudge rules only. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function mergeRules(
  patches: readonly { path: string; source: EnforceRuleSource; rules: Record<string, EnforceRuleInput> }[],
): EnforceConfig {
  const merged = new Map<string, { input: EnforceRuleInput; source: EnforceRuleSource }>();
  for (const [id, input] of Object.entries(BUILTIN_RULES)) merged.set(id, { input: { ...input }, source: "builtin" });
  const loadedFrom: string[] = [];
  for (const patch of patches) {
    loadedFrom.push(patch.path);
    for (const [id, rulePatch] of Object.entries(patch.rules)) {
      if (rulePatch.disabled === true) {
        merged.delete(id);
        continue;
      }
      const existing = merged.get(id);
      const input = { ...existing?.input, ...rulePatch };
      merged.set(id, { input, source: patch.source });
    }
  }
  if (merged.size > MAX_RULES) throw new Error(`enforce configuration exceeds the ${MAX_RULES}-rule limit`);
  const rules: EnforceRule[] = [];
  for (const [id, entry] of merged) rules.push(normalizeRule(id, entry.input, entry.source));
  return { rules, loadedFrom };
}

async function readConfigFile(path: string): Promise<Record<string, EnforceRuleInput> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid enforce config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return decodeRawConfig(parsed, path);
}

function decodeRawConfig(value: unknown, path: string): Record<string, EnforceRuleInput> {
  if (!isRecord(value)) throw new Error(`${path}: root must be an object`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(RAW_CONFIG_KEYS, key)) throw new Error(`${path}: root contains unknown property ${key}`);
  }
  if (value.rules === undefined) return {};
  if (!isRecord(value.rules)) throw new Error(`${path}: rules must be an object keyed by rule id`);
  const rules: Record<string, EnforceRuleInput> = {};
  for (const [id, patch] of Object.entries(value.rules)) {
    rules[id] = validateRulePatch(patch, `${path}: rule ${id}`);
  }
  return rules;
}

function validateRulePatch(value: unknown, label: string): EnforceRuleInput {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(RULE_PATCH_KEYS, key)) throw new Error(`${label} contains unknown property ${key}`);
  }
  if (value.tool !== undefined && typeof value.tool !== "string") throw new Error(`${label}: tool must be a string`);
  if (value.action !== undefined && value.action !== "nudge" && value.action !== "gate") {
    throw new Error(`${label}: action must be "nudge" or "gate"`);
  }
  if (value.message !== undefined && typeof value.message !== "string") throw new Error(`${label}: message must be a string`);
  if (value.example !== undefined && !isRecord(value.example)) throw new Error(`${label}: example must be an object`);
  if (value.paramField !== undefined && typeof value.paramField !== "string") throw new Error(`${label}: paramField must be a string`);
  if (value.paramPattern !== undefined && typeof value.paramPattern !== "string") throw new Error(`${label}: paramPattern must be a string`);
  if (value.fileParam !== undefined && typeof value.fileParam !== "string") throw new Error(`${label}: fileParam must be a string`);
  if (value.fileGlob !== undefined && typeof value.fileGlob !== "string") throw new Error(`${label}: fileGlob must be a string`);
  if (value.recommend !== undefined && typeof value.recommend !== "string") throw new Error(`${label}: recommend must be a string`);
  if (value.once !== undefined && typeof value.once !== "boolean") throw new Error(`${label}: once must be a boolean`);
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") throw new Error(`${label}: disabled must be a boolean`);
  return value as EnforceRuleInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
