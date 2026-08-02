import assert from "node:assert/strict";
import test from "node:test";
import {
  extractAgentsPackageTable,
  extractBacktickIdentifiers,
  extractNpmScriptMentions,
  extractSurfaceMentions,
  scanRegisteredNames,
  stripComments,
} from "../src/scan.ts";

test("scanRegisteredNames finds tool and command names across line breaks", () => {
  const source = [
    "pi.registerTool({",
    '  name: "alpha",',
    '  description: "x",',
    "});",
    'pi.registerTool({ name: "beta" });',
    "pi.registerCommand(",
    '  "gamma",',
    "  { handler: async () => {} },",
    ");",
    'pi.registerCommand("gamma", { handler: async () => {} }); // duplicate is ignored',
  ].join("\n");
  assert.deepEqual(scanRegisteredNames([source]), { tools: ["alpha", "beta"], commands: ["gamma"] });
  assert.deepEqual(scanRegisteredNames(["const x = 1;"]), { tools: [], commands: [] });
});

test("scanRegisteredNames does not see names that are not the first tool property", () => {
  // Documented boundary: registerTool({ description: ..., name: ... }) is not detected.
  const source = 'pi.registerTool({ description: "first", name: "late" });';
  assert.deepEqual(scanRegisteredNames([source]), { tools: [], commands: [] });
});

test("extractBacktickIdentifiers returns unique spans in order", () => {
  assert.deepEqual(extractBacktickIdentifiers("use `a` and `b`, then `a` again\n`c`"), ["a", "b", "c"]);
  assert.deepEqual(extractBacktickIdentifiers("no code here"), []);
});

test("extractAgentsPackageTable collects packages and slash-suffixed resource rows", () => {
  const markdown = [
    "intro",
    "",
    "| Package | Purpose |",
    "| --- | --- |",
    "| `rg` | search |",
    "| `themes/` | palettes |",
    "| not-backticked | ignored |",
    "",
    "| Other | Table |",
    "| --- | --- |",
    "| `nope` | not the package table |",
  ].join("\n");
  assert.deepEqual(extractAgentsPackageTable(markdown), {
    present: true,
    packages: ["rg"],
    resources: ["themes/"],
  });
  assert.equal(extractAgentsPackageTable("no tables here").present, false);
});

test("extractNpmScriptMentions finds npm run targets and the npm test alias only", () => {
  const markdown = [
    "run `npm run check` and `npm test`, then `npm ci`",
    "npm run release-smoke",
    "npm install should not count",
    "npm run check again",
  ].join("\n");
  assert.deepEqual(extractNpmScriptMentions(markdown), ["check", "release-smoke", "test"]);
  assert.deepEqual(extractNpmScriptMentions("nothing"), []);
});

test("scanRegisteredNames tolerates generic type arguments on registerTool", () => {
  const source = [
    "pi.registerTool<typeof SearchParameters, SearchDetails>({",
    '  name: "ast_grep_search",',
    "});",
  ].join("\n");
  assert.deepEqual(scanRegisteredNames([source]), { tools: ["ast_grep_search"], commands: [] });
});

test("scanRegisteredNames ignores registration shapes quoted in comments", () => {
  const source = [
    "/**",
    " * Registers like `pi.registerTool({ name: \"quoted\" })` and",
    " * `pi.registerCommand(\"quoted_cmd\", { handler })` are documentation only.",
    " */",
    '// pi.registerTool({ name: "line_commented" });',
    'pi.registerTool({ name: "real" });',
  ].join("\n");
  assert.deepEqual(scanRegisteredNames([source]), { tools: ["real"], commands: [] });
});

test("stripComments blanks comments but preserves strings and newlines", () => {
  const source = 'const url = "https://example.com"; // trailing\n/* block\ncomment */\nconst t = `// not a comment`;';
  const stripped = stripComments(source);
  assert.ok(stripped.includes('"https://example.com"'));
  assert.ok(stripped.includes("`// not a comment`"));
  assert.ok(!stripped.includes("trailing"));
  assert.ok(!stripped.includes("block"));
  assert.equal(stripped.split("\n").length, source.split("\n").length, "line count is preserved");
});

test("extractSurfaceMentions requires an immediately following marker for plain identifiers", () => {
  const markdown = [
    "注册一个 `alpha` 工具与 `/alpha` 命令",
    "`beta` tool does things",
    "plain `gamma` mention without marker",
    "`delta` 出现在同一行但远离 marker 工具",
    "`/reload` anywhere counts as a command reference",
  ].join("\n");
  assert.deepEqual(extractSurfaceMentions(markdown), {
    tools: ["alpha", "beta"],
    commands: ["alpha", "reload"],
  });
});

test("extractSurfaceMentions rejects path-like and malformed spans", () => {
  const markdown = "`a/b` 工具\n`../x` 工具\n`has space` 工具\n`/A` not lowercase";
  assert.deepEqual(extractSurfaceMentions(markdown), { tools: [], commands: [] });
});
