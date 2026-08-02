/**
 * Pure text scanners for the documentation contract.
 *
 * Everything here is a deterministic function of file text: no I/O, no
 * package knowledge. Allowlists document which names the checks must not
 * treat as drift (Pi built-in tools and built-in slash commands).
 */

/** Pi built-in tool names (from @earendil-works/pi-coding-agent core tool definitions). */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
];

/**
 * Pi built-in slash commands (interactive mode, without the leading "/").
 * READMEs legitimately reference these; they are never registered by an
 * extension package in this repository.
 */
export const BUILTIN_SLASH_COMMANDS: readonly string[] = [
  "arminsayshi",
  "changelog",
  "clone",
  "compact",
  "copy",
  "debug",
  "dementedelves",
  "export",
  "fork",
  "hotkeys",
  "import",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "quit",
  "reload",
  "resume",
  "scoped-models",
  "session",
  "settings",
  "share",
  "tree",
  "trust",
];

/**
 * `pi.registerTool({ name: "..." })` with `name` as the first property of the
 * definition object; optional generic type arguments between the callee and
 * the argument list are tolerated, as are line breaks between the tokens.
 * Tool definitions assigned to variables and passed by reference are not seen.
 */
const REGISTERED_TOOL_PATTERN = /registerTool\s*(?:<[^()\n]*>)?\s*\(\s*\{\s*name\s*:\s*"([^"\\\n]+)"/g;

/** Command registrations pass the name as the first string argument. */
const REGISTERED_COMMAND_PATTERN = /registerCommand\s*\(\s*"([^"\\\n]+)"/g;

export interface RegisteredNames {
  tools: string[];
  commands: string[];
}

/**
 * Blank out line and block comments so documentation that quotes
 * registration-call shapes is not mistaken for an actual registration.
 * String and template-literal contents are preserved; `${...}` nesting in
 * template literals is not parsed (sufficient for name scanning).
 */
export function stripComments(source: string): string {
  let result = "";
  let index = 0;
  let state: "code" | "line" | "block" | "string" | "template" = "code";
  let quote = "";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        result += char;
      } else {
        result += " ";
      }
      index += 1;
    } else if (state === "block") {
      if (char === "*" && next === "/") {
        result += "  ";
        index += 2;
        state = "code";
      } else {
        result += char === "\n" ? "\n" : " ";
        index += 1;
      }
    } else if (state === "string" || state === "template") {
      result += char;
      if (char === "\\") {
        if (index + 1 < source.length) result += source[index + 1];
        index += 2;
        continue;
      }
      if (state === "string" ? char === quote : char === "`") state = "code";
      index += 1;
    } else if (char === "/" && next === "/") {
      result += "  ";
      index += 2;
      state = "line";
    } else if (char === "/" && next === "*") {
      result += "  ";
      index += 2;
      state = "block";
    } else {
      result += char;
      if (char === '"' || char === "'") {
        quote = char;
        state = "string";
      } else if (char === "`") {
        state = "template";
      }
      index += 1;
    }
  }
  return result;
}

function collectMatches(pattern: RegExp, source: string, into: string[]): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (!into.includes(match[1])) into.push(match[1]);
  }
}

/** Statically scan extension sources for names passed to registerTool/registerCommand. */
export function scanRegisteredNames(sources: readonly string[]): RegisteredNames {
  const tools: string[] = [];
  const commands: string[] = [];
  for (const source of sources) {
    const code = stripComments(source);
    collectMatches(REGISTERED_TOOL_PATTERN, code, tools);
    collectMatches(REGISTERED_COMMAND_PATTERN, code, commands);
  }
  return { tools, commands };
}

/** Unique single-backtick spans in a Markdown document, in first-appearance order. */
export function extractBacktickIdentifiers(markdown: string): string[] {
  const identifiers: string[] = [];
  const pattern = /`([^`\n]+)`/g;
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    if (!identifiers.includes(match[1])) identifiers.push(match[1]);
  }
  return identifiers;
}

export interface AgentsPackageTable {
  /** Whether a table whose header row mentions "Package" was found. */
  present: boolean;
  /** First-column backticked entries naming extension packages (e.g. `rg`). */
  packages: string[];
  /** First-column backticked entries ending with "/", naming non-package resources (e.g. `themes/`). */
  resources: string[];
}

/**
 * Extract the root AGENTS.md package table. The table is identified by a
 * header row whose first cells mention "Package"; rows end at the first
 * non-table line. Only backticked first-column entries are collected.
 */
export function extractAgentsPackageTable(markdown: string): AgentsPackageTable {
  const result: AgentsPackageTable = { present: false, packages: [], resources: [] };
  const lines = markdown.split("\n");
  for (let header = 0; header < lines.length; header += 1) {
    if (!/^\|\s*Package\s*\|/.test(lines[header])) continue;
    result.present = true;
    for (let row = header + 1; row < lines.length; row += 1) {
      const line = lines[row].trim();
      if (!line.startsWith("|")) break;
      if (/^\|[\s:|=-]+\|$/.test(line)) continue; // separator row
      const firstCell = line.split("|")[1] ?? "";
      const name = /`([^`]+)`/.exec(firstCell)?.[1]?.trim();
      if (!name) continue;
      if (name.endsWith("/")) {
        if (!result.resources.includes(name)) result.resources.push(name);
      } else if (!result.packages.includes(name)) {
        result.packages.push(name);
      }
    }
    break;
  }
  return result;
}

const NPM_RUN_PATTERN = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
const NPM_IMPLICIT_PATTERN = /\bnpm\s+(test)\b/g;

/**
 * npm scripts a document tells the reader to run: `npm run <name>` plus the
 * implicit `npm test` alias. Other npm subcommands (ci, install, pack, ...)
 * are npm built-ins and are ignored.
 */
export function extractNpmScriptMentions(markdown: string): string[] {
  const names: string[] = [];
  collectMatches(NPM_RUN_PATTERN, markdown, names);
  collectMatches(NPM_IMPLICIT_PATTERN, markdown, names);
  return names;
}

const SLASH_COMMAND_SHAPE = /^\/[a-z][a-z0-9-]{1,30}$/;
const TOOL_NAME_SHAPE = /^[a-z][a-z0-9_]{1,40}$/;
const POSTPOSED_MARKER = /^\s*(?:工具|命令|tools?\b|commands?\b)/;

export interface SurfaceMentions {
  /** Backticked identifiers immediately followed by a tool/command marker word. */
  tools: string[];
  /** Backticked `/name` spans, without the leading slash. */
  commands: string[];
}

/**
 * Names a README presents as part of an extension surface. This direction is
 * deliberately narrow to stay useful: a plain identifier only counts when a
 * marker word (工具/命令/tool/command) immediately follows its closing
 * backtick (`` `ask` 工具``, `` `diff_report` tool``), and `/name` spans
 * count as command references. Identifiers merely sharing a line with a
 * marker (parameter names, event names, filenames) are ignored.
 */
export function extractSurfaceMentions(markdown: string): SurfaceMentions {
  const tools: string[] = [];
  const commands: string[] = [];
  for (const line of markdown.split("\n")) {
    const pattern = /`([^`\n]+)`/g;
    for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
      const value = match[1];
      if (SLASH_COMMAND_SHAPE.test(value)) {
        const name = value.slice(1);
        if (!commands.includes(name)) commands.push(name);
        continue;
      }
      const after = line.slice(pattern.lastIndex);
      if (TOOL_NAME_SHAPE.test(value) && POSTPOSED_MARKER.test(after) && !tools.includes(value)) {
        tools.push(value);
      }
    }
  }
  return { tools, commands };
}
