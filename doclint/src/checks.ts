/**
 * Documentation-contract checks as pure functions over a filesystem adapter.
 *
 * `runDocLint` never touches node:fs directly, so tests drive it with an
 * in-memory adapter and get fully deterministic findings.
 */
import {
  BUILTIN_SLASH_COMMANDS,
  BUILTIN_TOOL_NAMES,
  extractAgentsPackageTable,
  extractBacktickIdentifiers,
  extractNpmScriptMentions,
  extractSurfaceMentions,
  scanRegisteredNames,
  type RegisteredNames,
} from "./scan.ts";

export type CheckId = "agents-table" | "surface-names" | "npm-scripts" | "manifest-paths";
export type FindingSeverity = "error" | "warning";

export interface Finding {
  /** Repository-relative file the finding belongs to. */
  file: string;
  check: CheckId;
  severity: FindingSeverity;
  message: string;
}

export interface LintReport {
  /** Absolute real path of the linted repository root. */
  root: string;
  /** Top-level directories holding a valid pi.extensions manifest. */
  packagesScanned: string[];
  findings: Finding[];
  /** Findings dropped by the maxFindings cap. */
  omitted: number;
}

export const DEFAULT_MAX_FINDINGS = 100;

/**
 * Minimal filesystem surface the checks need. Paths are absolute; the
 * adapter decides how to resolve them. Missing/unreadable files are
 * reported as `null`/`false`, never thrown.
 */
export interface RepoFileSystem {
  readTextFile(absolutePath: string): string | null;
  fileExists(absolutePath: string): boolean;
  /** Immediate child directories of root, excluding dotdirs and node_modules. */
  listTopLevelDirectories(root: string): string[];
  /** All *.ts files below dir, recursively, excluding dotdirs and node_modules. */
  listSourceFiles(dir: string): string[];
}

export interface LintOptions {
  maxFindings?: number;
}

interface PackageInfo {
  dir: string;
  extensions: string[];
  scripts: Record<string, string>;
}

function joinPath(root: string, relative: string): string {
  return root.endsWith("/") ? root + relative : `${root}/${relative}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a package.json text. Returns null (with a finding) for malformed
 * input, and null (without a finding) for directories that are not Pi
 * extension packages. pi/extensions shape violations still produce a
 * PackageInfo with an empty extension list so other checks keep running.
 */
function parseManifest(dir: string, raw: string, findings: Finding[]): PackageInfo | null {
  const file = `${dir}/package.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    findings.push({ file, check: "manifest-paths", severity: "error", message: "package.json is not valid JSON" });
    return null;
  }
  if (!isPlainObject(parsed)) {
    findings.push({ file, check: "manifest-paths", severity: "error", message: "package.json must be a JSON object" });
    return null;
  }
  if (parsed.pi === undefined) return null;
  let extensions: string[] = [];
  const pi = parsed.pi;
  const rawExtensions = isPlainObject(pi) ? pi.extensions : undefined;
  if (
    !Array.isArray(rawExtensions) ||
    rawExtensions.length === 0 ||
    rawExtensions.some((entry) => typeof entry !== "string")
  ) {
    findings.push({
      file,
      check: "manifest-paths",
      severity: "error",
      message: "pi.extensions must be a non-empty array of strings",
    });
  } else {
    extensions = rawExtensions as string[];
  }
  const scripts: Record<string, string> = {};
  if (parsed.scripts !== undefined) {
    if (!isPlainObject(parsed.scripts) || Object.values(parsed.scripts).some((value) => typeof value !== "string")) {
      findings.push({
        file,
        check: "npm-scripts",
        severity: "error",
        message: "scripts must be an object mapping names to command strings",
      });
    } else {
      Object.assign(scripts, parsed.scripts);
    }
  }
  return { dir, extensions, scripts };
}

function checkAgentsTable(
  table: ReturnType<typeof extractAgentsPackageTable>,
  packages: readonly PackageInfo[],
  findings: Finding[],
): void {
  if (!table.present) {
    findings.push({
      file: "AGENTS.md",
      check: "agents-table",
      severity: "error",
      message: "no package table (a Markdown table whose header row is \"Package\") found in AGENTS.md",
    });
    return;
  }
  const listed = new Set(table.packages);
  for (const pkg of packages) {
    if (!listed.has(pkg.dir)) {
      findings.push({
        file: "AGENTS.md",
        check: "agents-table",
        severity: "error",
        message: `package "${pkg.dir}" declares pi.extensions but is missing from the AGENTS.md package table`,
      });
    }
  }
  const dirs = new Set(packages.map((pkg) => pkg.dir));
  for (const entry of table.packages) {
    if (!dirs.has(entry)) {
      findings.push({
        file: "AGENTS.md",
        check: "agents-table",
        severity: "warning",
        message: `package table entry "${entry}" has no pi.extensions manifest (non-package resources such as themes/ must keep the trailing "/")`,
      });
    }
  }
}

function checkManifestPaths(root: string, pkg: PackageInfo, fs: RepoFileSystem, findings: Finding[]): void {
  const file = `${pkg.dir}/package.json`;
  for (const entry of pkg.extensions) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      findings.push({
        file,
        check: "manifest-paths",
        severity: "error",
        message: `pi.extensions entry "${entry}" must be a relative path inside the package directory`,
      });
      continue;
    }
    const relative = entry.startsWith("./") ? entry.slice(2) : entry;
    if (!fs.fileExists(joinPath(root, `${pkg.dir}/${relative}`))) {
      findings.push({
        file,
        check: "manifest-paths",
        severity: "error",
        message: `pi.extensions entry "${entry}" does not exist at ${pkg.dir}/${relative}`,
      });
    }
  }
}

function readPackageSources(root: string, pkg: PackageInfo, fs: RepoFileSystem): string[] {
  return fs
    .listSourceFiles(joinPath(root, `${pkg.dir}/src`))
    .map((path) => fs.readTextFile(path))
    .filter((text): text is string => text !== null);
}

function checkSurfaceNames(
  pkg: PackageInfo,
  readme: string,
  registered: RegisteredNames,
  repoRegistered: ReadonlySet<string>,
  findings: Finding[],
): void {
  const file = `${pkg.dir}/README.md`;
  const backticked = new Set(extractBacktickIdentifiers(readme));
  for (const name of registered.tools) {
    if (!backticked.has(name)) {
      findings.push({
        file,
        check: "surface-names",
        severity: "error",
        message: `tool "${name}" is registered in src but never appears (in backticks) in README.md`,
      });
    }
  }
  for (const name of registered.commands) {
    if (!backticked.has(name) && !backticked.has(`/${name}`)) {
      findings.push({
        file,
        check: "surface-names",
        severity: "error",
        message: `command "/${name}" is registered in src but never appears (in backticks) in README.md`,
      });
    }
  }
  const mentions = extractSurfaceMentions(readme);
  for (const name of mentions.commands) {
    if (!repoRegistered.has(name) && !BUILTIN_SLASH_COMMANDS.includes(name)) {
      findings.push({
        file,
        check: "surface-names",
        severity: "warning",
        message: `README.md references command "/${name}" that no extension in this repository registers (heuristic; Pi built-in commands are allowlisted)`,
      });
    }
  }
  for (const name of mentions.tools) {
    if (!repoRegistered.has(name) && !BUILTIN_TOOL_NAMES.includes(name)) {
      findings.push({
        file,
        check: "surface-names",
        severity: "warning",
        message: `README.md presents "${name}" as a tool/command that no extension in this repository registers (heuristic; Pi built-in tools are allowlisted)`,
      });
    }
  }
}

function checkNpmScripts(pkg: PackageInfo, readme: string, findings: Finding[]): void {
  const file = `${pkg.dir}/README.md`;
  const mentioned = extractNpmScriptMentions(readme);
  const declared = Object.keys(pkg.scripts);
  for (const name of mentioned) {
    if (!declared.includes(name)) {
      findings.push({
        file,
        check: "npm-scripts",
        severity: "error",
        message: `README.md documents "npm run ${name}" but package.json has no "${name}" script`,
      });
    }
  }
  for (const name of declared) {
    if (!mentioned.includes(name)) {
      findings.push({
        file: `${pkg.dir}/package.json`,
        check: "npm-scripts",
        severity: "warning",
        message: `package.json script "${name}" is not documented in ${pkg.dir}/README.md`,
      });
    }
  }
}

/**
 * Run every documentation-contract check below `root`. The result is
 * deterministic for a given adapter and root; findings keep discovery order
 * and are capped at `maxFindings` (the cap is reported via `omitted`).
 */
export function runDocLint(fs: RepoFileSystem, root: string, options?: LintOptions): LintReport {
  const maxFindings = options?.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const findings: Finding[] = [];

  const agentsText = fs.readTextFile(joinPath(root, "AGENTS.md"));
  if (agentsText === null) {
    findings.push({
      file: "AGENTS.md",
      check: "agents-table",
      severity: "error",
      message: "root AGENTS.md is missing or unreadable; the package table cannot be checked",
    });
    return finish(fs, root, [], findings, maxFindings);
  }

  const packages: PackageInfo[] = [];
  for (const dir of fs.listTopLevelDirectories(root).sort()) {
    const raw = fs.readTextFile(joinPath(root, `${dir}/package.json`));
    if (raw === null) continue;
    const info = parseManifest(dir, raw, findings);
    if (info !== null) packages.push(info);
  }

  checkAgentsTable(extractAgentsPackageTable(agentsText), packages, findings);

  // Scan every package's sources once; the repo-wide name set exempts
  // cross-package README references (e.g. one extension documenting a
  // sibling's tool) from the heuristic direction.
  const registeredByPackage = new Map<string, RegisteredNames>();
  const repoRegistered = new Set<string>();
  for (const pkg of packages) {
    const registered = scanRegisteredNames(readPackageSources(root, pkg, fs));
    registeredByPackage.set(pkg.dir, registered);
    for (const name of [...registered.tools, ...registered.commands]) repoRegistered.add(name);
  }

  for (const pkg of packages) {
    checkManifestPaths(root, pkg, fs, findings);
    const readme = fs.readTextFile(joinPath(root, `${pkg.dir}/README.md`));
    if (readme === null) {
      findings.push({
        file: `${pkg.dir}/README.md`,
        check: "surface-names",
        severity: "error",
        message: `extension package "${pkg.dir}" has no README.md; the documentation contract requires one`,
      });
      continue;
    }
    const registered = registeredByPackage.get(pkg.dir) ?? { tools: [], commands: [] };
    checkSurfaceNames(pkg, readme, registered, repoRegistered, findings);
    checkNpmScripts(pkg, readme, findings);
  }

  return finish(fs, root, packages, findings, maxFindings);
}

function finish(
  _fs: RepoFileSystem,
  root: string,
  packages: readonly PackageInfo[],
  findings: Finding[],
  maxFindings: number,
): LintReport {
  let omitted = 0;
  if (findings.length > maxFindings) {
    omitted = findings.length - maxFindings;
    findings.length = maxFindings;
  }
  return {
    root,
    packagesScanned: packages.map((pkg) => pkg.dir),
    findings,
    omitted,
  };
}
