/**
 * In-memory RepoFileSystem for deterministic checker tests.
 * Keys are absolute posix-style paths, e.g. "/repo/demo/package.json".
 */
import type { RepoFileSystem } from "../src/checks.ts";

function childPrefix(dir: string): string {
  return dir.endsWith("/") ? dir : `${dir}/`;
}

function isSkippableSegment(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

export function createMemoryFs(files: Record<string, string>): RepoFileSystem {
  const paths = new Map(Object.entries(files));
  return {
    readTextFile(absolutePath) {
      return paths.get(absolutePath) ?? null;
    },
    fileExists(absolutePath) {
      return paths.has(absolutePath);
    },
    listTopLevelDirectories(root) {
      const prefix = childPrefix(root);
      const dirs = new Set<string>();
      for (const key of paths.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash <= 0) continue;
        const name = rest.slice(0, slash);
        if (!isSkippableSegment(name)) dirs.add(name);
      }
      return [...dirs];
    },
    listSourceFiles(dir) {
      const prefix = childPrefix(dir);
      return [...paths.keys()]
        .filter((key) => {
          if (!key.startsWith(prefix) || !key.endsWith(".ts")) return false;
          return !key
            .slice(prefix.length)
            .split("/")
            .some((segment) => isSkippableSegment(segment));
        })
        .sort();
    },
  };
}

export const DEMO_MANIFEST = JSON.stringify({
  name: "pi-demo-dev",
  type: "module",
  pi: { extensions: ["./src/index.ts"] },
  scripts: { check: "tsc --noEmit", test: "node --import tsx --test test/*.test.ts" },
});

export const DEMO_SOURCE = [
  'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
  "export default function demoExtension(pi: ExtensionAPI): void {",
  "  pi.registerTool({",
  '    name: "demo_tool",',
  '    description: "demo",',
  "    parameters: {},",
  "    async execute() {",
  '      return { content: [{ type: "text", text: "ok" }] };',
  "    },",
  "  });",
  '  pi.registerCommand("demo", { handler: async () => {} });',
  "}",
].join("\n");

export const DEMO_AGENTS = [
  "# Repository Guidelines",
  "",
  "| Package | Purpose |",
  "| --- | --- |",
  "| `demo` | demo package |",
  "| `themes/` | repository-wide palettes |",
  "",
  "Trailing text.",
].join("\n");

export const DEMO_README = [
  "# Demo 插件",
  "",
  "`demo` 注册 `demo_tool` 工具与 `/demo` 命令。",
  "",
  "```bash",
  "npm run check",
  "npm test",
  "```",
].join("\n");

/** A fully consistent single-package repository; every check passes. */
export function validRepoFiles(): Record<string, string> {
  return {
    "/repo/AGENTS.md": DEMO_AGENTS,
    "/repo/demo/package.json": DEMO_MANIFEST,
    "/repo/demo/src/index.ts": DEMO_SOURCE,
    "/repo/demo/README.md": DEMO_README,
  };
}
