import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

const NOTICE_RESERVE_BYTES = 1_024;
const NOTICE_RESERVE_LINES = 2;

export interface LspTruncationSummary {
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export interface BoundedLspOutput {
  text: string;
  truncation?: LspTruncationSummary;
  fullOutputPath?: string;
}

export class LspOutputStore {
  private directoryPromise: Promise<string> | undefined;

  async bound(text: string): Promise<BoundedLspOutput> {
    const result = truncateHead(text, {
      maxBytes: DEFAULT_MAX_BYTES - NOTICE_RESERVE_BYTES,
      maxLines: DEFAULT_MAX_LINES - NOTICE_RESERVE_LINES,
    });
    if (!result.truncated) return { text };

    const fullOutputPath = await this.save(text);
    const truncation: LspTruncationSummary = {
      truncatedBy: result.truncatedBy,
      totalLines: result.totalLines,
      totalBytes: result.totalBytes,
      outputLines: result.outputLines,
      outputBytes: result.outputBytes,
    };
    const notice = `[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines ` +
      `(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}). ` +
      `Full formatted output: ${fullOutputPath}]`;
    return {
      text: `${result.content}\n\n${notice}`,
      truncation,
      fullOutputPath,
    };
  }

  async cleanup(): Promise<void> {
    const directoryPromise = this.directoryPromise;
    this.directoryPromise = undefined;
    if (!directoryPromise) return;
    const directory = await directoryPromise.catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  private async save(text: string): Promise<string> {
    this.directoryPromise ??= mkdtemp(join(tmpdir(), "pi-lsp-"));
    const directory = await this.directoryPromise;
    const path = join(directory, `${randomUUID()}.txt`);
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return path;
  }
}
