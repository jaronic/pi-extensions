import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { BigIntStats, Dirent } from "node:fs";
import type { OperationRecord } from "./operations.ts";
import { throwIfCancelledOrExpired } from "./operations.ts";
import {
  fileIdentity,
  isPathContained,
  sameIdentity,
  type FileIdentity,
  type WorkspaceTarget,
} from "./paths.ts";

const MAX_COMPONENTS = 64;
const MAX_RESULT_PATH_CHARS = 4096;
const MAX_DIRECTORY_STAMPS = 256;
const MAX_RAW_ENTRIES = 1_000_000;
const MAX_CACHED_COMPONENTS = 4096;

interface DirectoryStamp extends FileIdentity {}

interface CacheEntry {
  stamp: DirectoryStamp;
  verified: Set<string>;
}

interface RawDirectory extends AsyncIterable<Dirent<Buffer>> {
  close(): Promise<void>;
}

const openRawDirectory = opendir as unknown as (
  path: string,
  options: { encoding: "buffer"; bufferSize: number },
) => Promise<RawDirectory>;

function stampFrom(stats: BigIntStats): DirectoryStamp {
  return fileIdentity(stats);
}

function splitRecordPath(file: string): string[] {
  if (process.platform === "win32") {
    return file.split(/[\\/]/u);
  }
  return file.split("/");
}

export interface ValidatedDirectoryRecord {
  canonicalPath: string;
  displayPath: string;
}

export class LosslessDirectoryValidator {
  readonly #workspace: string;
  readonly #scope: WorkspaceTarget;
  readonly #record: OperationRecord;
  readonly #cache = new Map<string, CacheEntry>();
  #entriesScanned = 0;
  #cachedComponents = 0;

  constructor(scope: WorkspaceTarget, record: OperationRecord) {
    if (scope.kind !== "directory") {
      throw new Error("lossless directory validation requires a directory scope.");
    }
    this.#workspace = scope.canonicalWorkspace;
    this.#scope = scope;
    this.#record = record;
  }

  get entriesScanned(): number {
    return this.#entriesScanned;
  }

  async validate(file: string): Promise<ValidatedDirectoryRecord> {
    throwIfCancelledOrExpired(this.#record);
    if (file.length === 0 || file.length > MAX_RESULT_PATH_CHARS || !file.isWellFormed() || file.includes("\0") || isAbsolute(file)) {
      throw new Error("incompatible/corrupt ast-grep output: directory result path is invalid.");
    }
    const components = splitRecordPath(file);
    if (components.length === 0 || components.length > MAX_COMPONENTS
      || components.some((component) => component.length === 0 || component === "." || component === "..")) {
      throw new Error("incompatible/corrupt ast-grep output: directory result path has invalid components.");
    }
    const scopeComponents = this.#scope.nativeRelativePath === "."
      ? []
      : splitRecordPath(this.#scope.nativeRelativePath);
    if (components.length <= scopeComponents.length
      || scopeComponents.some((component, index) => components[index] !== component)) {
      throw new Error("incompatible/corrupt ast-grep output: result is outside the requested directory scope.");
    }
    const suffix = components.slice(scopeComponents.length);
    let parent = this.#scope.canonicalPath;
    let parentIdentity = this.#scope.identity;
    for (const [index, component] of suffix.entries()) {
      throwIfCancelledOrExpired(this.#record);
      await this.#validateExactComponent(parent, component, parentIdentity);
      throwIfCancelledOrExpired(this.#record);
      const child = join(parent, component);
      const childStats = await lstat(child, { bigint: true });
      if (childStats.isSymbolicLink()) {
        throw new Error("incompatible/corrupt ast-grep output: result traverses a symlink or junction.");
      }
      const isFinal = index === suffix.length - 1;
      if (isFinal ? !childStats.isFile() : !childStats.isDirectory()) {
        throw new Error(`incompatible/corrupt ast-grep output: result ${isFinal ? "is not a regular file" : "contains a non-directory component"}.`);
      }
      const canonicalChild = await realpath(child);
      if (!isPathContained(this.#workspace, canonicalChild) || !isPathContained(this.#scope.canonicalPath, canonicalChild)) {
        throw new Error("incompatible/corrupt ast-grep output: result resolves outside its workspace scope.");
      }
      const canonicalStats = await lstat(canonicalChild, { bigint: true });
      const childIdentity = fileIdentity(childStats);
      if (canonicalStats.isSymbolicLink() || !sameIdentity(fileIdentity(canonicalStats), childIdentity)) {
        throw new Error("incompatible/corrupt ast-grep output: result component changed during validation.");
      }
      parent = canonicalChild;
      parentIdentity = childIdentity;
    }
    const display = relative(this.#workspace, parent) || ".";
    return {
      canonicalPath: parent,
      displayPath: sep === "/" ? display : display.split(sep).join("/"),
    };
  }

  async #validateExactComponent(parent: string, component: string, expectedParent: FileIdentity): Promise<void> {
    const validateParent = async (): Promise<DirectoryStamp> => {
      const stats = await lstat(parent, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("incompatible/corrupt ast-grep output: validated parent stopped being a real directory.");
      }
      const canonical = await realpath(parent);
      if (canonical !== parent
        || !isPathContained(this.#workspace, canonical)
        || !isPathContained(this.#scope.canonicalPath, canonical)) {
        throw new Error("incompatible/corrupt ast-grep output: validated parent namespace changed.");
      }
      return stampFrom(stats);
    };

    const before = await validateParent();
    if (!sameIdentity(before, expectedParent)) {
      throw new Error("directory identity changed before lossless filename validation; retry against a stable workspace.");
    }
    const cached = this.#cache.get(parent);
    if (cached !== undefined && sameIdentity(cached.stamp, before) && cached.verified.has(component)) {
      this.#cache.delete(parent);
      this.#cache.set(parent, cached);
      return;
    }
    if (cached !== undefined && !sameIdentity(cached.stamp, before)) {
      this.#cachedComponents -= cached.verified.size;
      this.#cache.delete(parent);
    }

    let found = false;
    const directory = await openRawDirectory(parent, { encoding: "buffer", bufferSize: 32 });
    const onAbort = () => void directory.close().catch(() => undefined);
    this.#record.controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const entry of directory) {
        throwIfCancelledOrExpired(this.#record);
        this.#countEntry();
        if (!Buffer.isBuffer(entry.name)) {
          throw new Error("runtime opendir did not provide raw filename bytes as required.");
        }
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(entry.name);
        } catch {
          throw new Error(process.platform === "win32"
            ? "directory contains a filename with an unpaired UTF-16 surrogate; directory search is unsafe."
            : "directory contains a non-UTF-8 filename; ast-grep's lossy JSON path cannot be trusted in this scope.");
        }
        if (decoded === component) {
          found = true;
        }
      }
    } catch (error) {
      throwIfCancelledOrExpired(this.#record);
      throw error;
    } finally {
      this.#record.controller.signal.removeEventListener("abort", onAbort);
    }

    const after = await validateParent();
    if (!sameIdentity(before, after)) {
      throw new Error("directory changed during lossless filename validation; retry against a stable workspace.");
    }
    if (!found) {
      throw new Error("incompatible/corrupt ast-grep output: result filename has no exact filesystem entry.");
    }
    const entry = this.#cache.get(parent) ?? { stamp: after, verified: new Set<string>() };
    if (!entry.verified.has(component) && this.#cachedComponents < MAX_CACHED_COMPONENTS) {
      entry.verified.add(component);
      this.#cachedComponents += 1;
    }
    entry.stamp = after;
    this.#cache.delete(parent);
    this.#cache.set(parent, entry);
    while (this.#cache.size > MAX_DIRECTORY_STAMPS) {
      const oldest = this.#cache.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#cachedComponents -= oldest[1].verified.size;
      this.#cache.delete(oldest[0]);
    }
  }

  #countEntry(): void {
    this.#entriesScanned += 1;
    if (this.#entriesScanned > MAX_RAW_ENTRIES) {
      throw new Error(`lossless filename validation exceeded ${MAX_RAW_ENTRIES} raw directory entries.`);
    }
  }
}
