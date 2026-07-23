import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

const REQUIRED_COLORS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText",
  "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading",
  "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
  "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
  "thinkingXhigh", "thinkingMax", "bashMode",
];

const CRITICAL_PAGE_ROLES = [
  "text", "muted", "thinkingText", "accent", "success", "error", "warning", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdCode", "mdCodeBlock", "mdQuote", "mdListBullet", "toolDiffAdded", "toolDiffRemoved",
  "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
  "syntaxNumber", "syntaxType", "syntaxOperator", "bashMode",
];
const SECONDARY_PAGE_ROLES = ["dim", "mdLinkUrl", "syntaxPunctuation"];
const ACTIVE_DECORATION_ROLES = [
  "border", "borderAccent", "mdCodeBlockBorder", "mdQuoteBorder", "mdHr", "thinkingMinimal", "thinkingLow",
  "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax",
];
const SUBTLE_DECORATION_ROLES = ["borderMuted", "thinkingOff"];
const TOOL_BACKGROUNDS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(left, right) {
  const first = luminance(left);
  const second = luminance(right);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function resolveColor(value, vars, chain = []) {
  if (isHex(value)) return value;
  if (typeof value !== "string" || !(value in vars)) {
    throw new Error(`unresolved color ${JSON.stringify(value)}`);
  }
  if (chain.includes(value)) throw new Error(`circular color reference ${[...chain, value].join(" -> ")}`);
  return resolveColor(vars[value], vars, [...chain, value]);
}

const files = (await readdir(directory)).filter((name) => /^pi-extensions-.*\.json$/.test(name)).sort();
if (files.length === 0) throw new Error("No pi-extensions theme files found");

const failures = [];
const names = new Set();

for (const file of files) {
  const path = join(directory, file);
  let theme;
  try {
    theme = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    failures.push(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  if (!isRecord(theme) || typeof theme.name !== "string" || !isRecord(theme.vars) || !isRecord(theme.colors)) {
    failures.push(`${file}: expected name, vars, and colors objects`);
    continue;
  }
  if (file !== `${theme.name}.json`) failures.push(`${file}: filename must match theme name ${theme.name}`);
  if (names.has(theme.name)) failures.push(`${file}: duplicate theme name ${theme.name}`);
  names.add(theme.name);

  const missing = REQUIRED_COLORS.filter((role) => !(role in theme.colors));
  const extra = Object.keys(theme.colors).filter((role) => !REQUIRED_COLORS.includes(role));
  if (missing.length > 0) failures.push(`${file}: missing colors: ${missing.join(", ")}`);
  if (extra.length > 0) failures.push(`${file}: unknown colors: ${extra.join(", ")}`);
  if (missing.length > 0) continue;

  let colors;
  try {
    colors = Object.fromEntries(Object.entries(theme.colors).map(([role, value]) => [role, resolveColor(value, theme.vars)]));
  } catch (error) {
    failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const page = theme.export?.pageBg;
  if (!isHex(page) || !isHex(theme.export?.cardBg) || !isHex(theme.export?.infoBg)) {
    failures.push(`${file}: export.pageBg, cardBg, and infoBg must be six-digit hex colors`);
    continue;
  }

  const checks = [];
  for (const role of CRITICAL_PAGE_ROLES) checks.push([`${role}/pageBg`, colors[role], page, 4.5]);
  for (const role of SECONDARY_PAGE_ROLES) checks.push([`${role}/pageBg`, colors[role], page, 3]);
  for (const role of ACTIVE_DECORATION_ROLES) checks.push([`${role}/pageBg`, colors[role], page, 3]);
  for (const role of SUBTLE_DECORATION_ROLES) checks.push([`${role}/pageBg`, colors[role], page, 1.5]);
  checks.push(
    ["text/selectedBg", colors.text, colors.selectedBg, 4.5],
    ["userMessageText/userMessageBg", colors.userMessageText, colors.userMessageBg, 4.5],
    ["customMessageText/customMessageBg", colors.customMessageText, colors.customMessageBg, 4.5],
    ["customMessageLabel/customMessageBg", colors.customMessageLabel, colors.customMessageBg, 4.5],
  );
  for (const background of TOOL_BACKGROUNDS) {
    checks.push([`toolTitle/${background}`, colors.toolTitle, colors[background], 4.5]);
    checks.push([`toolOutput/${background}`, colors.toolOutput, colors[background], 4.5]);
  }

  let minimumMargin = Number.POSITIVE_INFINITY;
  for (const [label, foreground, background, threshold] of checks) {
    const value = contrast(foreground, background);
    minimumMargin = Math.min(minimumMargin, value / threshold);
    if (value < threshold) failures.push(`${file}: ${label} ${value.toFixed(2)}:1 < ${threshold.toFixed(1)}:1`);
  }
  console.log(`${theme.name}: ${checks.length} contrast checks, minimum margin ${minimumMargin.toFixed(2)}x`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`${files.length} themes passed schema and role-aware contrast validation`);
}
