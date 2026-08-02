import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import {
  createReadToolDefinition,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionContext,
  type ReadToolDetails,
  type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { reuseTextComponent, toolCallTitle } from "pi-uikit-dev";
import { snapshotTokenForBytes } from "./digest.ts";
import { abortIfNeeded, fail } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { assertEditableLineSizes, decodeEditableBytes } from "./lines.ts";
import { formatReadSnapshot } from "./output.ts";
import { displayPath } from "./paths.ts";
import { encodeSnapshotEntry } from "./persistence.ts";
import {
  READ_DESCRIPTION,
  READ_PROMPT_GUIDELINES,
  READ_PROMPT_SNIPPET,
} from "./prompts.ts";
import { MAX_EDITABLE_FILE_BYTES, MAX_PATH_CHARS } from "./schemas.ts";
import type { HashlineRuntime } from "./runtime.ts";
import type { SnapshotRecord } from "./snapshots.ts";

interface CapturedFile {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly bytes: Buffer;
  readonly linkCount: number;
}

class CaptureTooLargeError extends Error {}

function sameFileState(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function captureFile(absolutePath: string, signal: AbortSignal | undefined): Promise<CapturedFile> {
  abortIfNeeded(signal);
  const canonicalPath = await realpath(absolutePath);
  abortIfNeeded(signal);
  const initial = await stat(canonicalPath);
  abortIfNeeded(signal);
  if (!initial.isFile()) fail("E_NOT_EDITABLE", "Hashline read only supports existing regular files.");
  if (initial.size > MAX_EDITABLE_FILE_BYTES) throw new CaptureTooLargeError();
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    abortIfNeeded(signal);
    const before = await handle.stat();
    abortIfNeeded(signal);
    if (!before.isFile()) fail("E_NOT_EDITABLE", "Hashline read only supports existing regular files.");
    if (before.size > MAX_EDITABLE_FILE_BYTES) throw new CaptureTooLargeError();
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      abortIfNeeded(signal);
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      abortIfNeeded(signal);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    abortIfNeeded(signal);
    let currentCanonicalPath: string;
    try {
      currentCanonicalPath = await realpath(absolutePath);
    } catch {
      fail("E_PATH_MISMATCH", "The read path disappeared or changed target while the file was being read. Retry read.");
    }
    abortIfNeeded(signal);
    if (currentCanonicalPath !== canonicalPath) {
      fail("E_PATH_MISMATCH", "The read path changed target while the file was being read. Retry read.");
    }
    if (offset !== before.size || !sameFileState(before, after)) {
      fail("E_STALE_SNAPSHOT", "File changed while it was being read. No snapshot was saved; retry read.");
    }
    return Object.freeze({ absolutePath, canonicalPath, bytes, linkCount: after.nlink });
  } finally {
    await handle.close();
  }
}

export function detectSupportedImageMimeType(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return undefined;
}

function textResult(text: string, details: ReadToolDetails | undefined): AgentToolResult<ReadToolDetails | undefined> {
  return Object.freeze({ content: [{ type: "text" as const, text }], details });
}

const NOOP_LOGGER: Logger = { error() {}, warn() {}, info() {}, debug() {} };

export function createHashlineReadTool(runtime: HashlineRuntime, logger: Logger = NOOP_LOGGER) {
  const renderer = createReadToolDefinition(process.cwd());
  const renderCall: NonNullable<typeof renderer.renderCall> = (args, theme, context) => {
    const start = args.offset ?? 1;
    const range = args.offset === undefined && args.limit === undefined
      ? ""
      : args.limit === undefined ? `:${start}` : `:${start}-${start + args.limit - 1}`;
    return reuseTextComponent(
      context.lastComponent,
      toolCallTitle(theme, { brand: "Hashline", action: "read", target: `${args.path}${range}` }),
    );
  };
  return {
    ...renderer,
    label: "Hashline read",
    renderCall,
    description: READ_DESCRIPTION,
    promptSnippet: READ_PROMPT_SNIPPET,
    promptGuidelines: [...READ_PROMPT_GUIDELINES],
    async execute(
      toolCallId: string,
      params: ReadToolInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ReadToolDetails | undefined> | undefined,
      ctx: ExtensionContext,
    ) {
      if (params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 1)) {
        throw new Error("[E_BAD_REQUEST] offset must be a safe integer greater than or equal to 1.");
      }
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
        throw new Error("[E_BAD_REQUEST] limit must be a safe integer greater than or equal to 1.");
      }
      abortIfNeeded(signal);
      const generation = runtime.getGeneration();
      let capturePromise: Promise<CapturedFile> | undefined;
      const ensureCapture = (absolutePath: string): Promise<CapturedFile> => {
        capturePromise ??= captureFile(absolutePath, signal);
        return capturePromise;
      };
      const builtin = createReadToolDefinition(ctx.cwd, {
        operations: {
          access: (absolutePath) => access(absolutePath, constants.R_OK),
          async detectImageMimeType(absolutePath) {
            return detectSupportedImageMimeType((await ensureCapture(absolutePath)).bytes);
          },
          async readFile(absolutePath) {
            return (await ensureCapture(absolutePath)).bytes;
          },
        },
      });
      // The host preread counts lines via split("\n"), so a CR-only file looks
      // like a single line and any offset > 1 would fail before Hashline's
      // CR-aware line table could apply. Preread without the range; editable
      // text has offset/limit validated and applied below against physical
      // lines, while images and non-editable fallbacks keep the host's own
      // range semantics (Pi line counting, truncation and image handling).
      const prereadParams: ReadToolInput = { ...params, offset: undefined, limit: undefined };
      const hostRangedResult = (): Promise<AgentToolResult<ReadToolDetails | undefined>> =>
        builtin.execute(toolCallId, params, signal, onUpdate, ctx).catch((error) => {
          abortIfNeeded(signal);
          logger.debug("read_failed", { path: params.path, offset: params.offset, limit: params.limit, error });
          throw error;
        });
      let builtinResult: AgentToolResult<ReadToolDetails | undefined>;
      try {
        builtinResult = await builtin.execute(toolCallId, prereadParams, signal, onUpdate, ctx);
      } catch (error) {
        abortIfNeeded(signal);
        if (error instanceof CaptureTooLargeError) {
          try {
            return await createReadToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
          } catch (fallbackError) {
            abortIfNeeded(signal);
            logger.debug("read_failed", { path: params.path, offset: params.offset, limit: params.limit, error: fallbackError });
            throw fallbackError;
          }
        }
        // Capture and built-in read failures both surface here; log the request
        // shape so the failing path can be reproduced. Routine access errors are
        // debug-level noise, so this stays below the error threshold.
        logger.debug("read_failed", { path: params.path, offset: params.offset, limit: params.limit, error });
        throw error;
      }
      const captured = await capturePromise;
      if (
        builtinResult.content.some((content) => content.type === "image") ||
        (captured && detectSupportedImageMimeType(captured.bytes) !== undefined)
      ) return builtinResult;

      if (
        !captured ||
        captured.linkCount > 1 ||
        captured.bytes.length > MAX_EDITABLE_FILE_BYTES ||
        captured.canonicalPath.length > MAX_PATH_CHARS ||
        captured.canonicalPath.includes("\0")
      ) {
        return hostRangedResult();
      }
      let editable;
      try {
        editable = decodeEditableBytes(captured.bytes);
        assertEditableLineSizes(editable.lines);
      } catch {
        return hostRangedResult();
      }
      if (editable.lines.length === 0) {
        return textResult("[Empty file. Use write for explicit full-file content.]", undefined);
      }
      const startLine = params.offset ?? 1;
      if (startLine > editable.lines.length) {
        throw new Error(`[E_RANGE] Offset ${startLine} is beyond end of file (${editable.lines.length} physical lines).`);
      }
      const requestedCount = params.limit ?? editable.lines.length - startLine + 1;
      const token = snapshotTokenForBytes(captured.bytes);
      const displayFilePath = displayPath(captured.absolutePath, ctx.cwd);
      const formatted = formatReadSnapshot(
        editable.lines,
        startLine,
        requestedCount,
        displayFilePath,
        token,
      );
      if (!formatted) return hostRangedResult();
      const tokenResult = textResult(formatted.tokenText, formatted.details);
      const noTokenResult = textResult(formatted.noTokenText, formatted.details);
      const record: SnapshotRecord = Object.freeze({
        token,
        digest: token.slice(3),
        canonicalPath: captured.canonicalPath,
        byteLength: captured.bytes.length,
        lineCount: editable.lines.length,
        seen: formatted.seen,
        source: "read",
      });
      const entry = encodeSnapshotEntry(record);
      abortIfNeeded(signal);
      if (runtime.getGeneration() !== generation) return noTokenResult;
      try {
        runtime.commitRecord(record, entry, captured.bytes);
      } catch {
        return noTokenResult;
      }
      logger.debug("snapshot_captured", {
        path: displayFilePath,
        token,
        bytes: captured.bytes.length,
        lines: editable.lines.length,
        offset: startLine,
        limit: requestedCount,
        seenRanges: formatted.seen.length,
        generation,
      });
      return tokenResult;
    },
  };
}
