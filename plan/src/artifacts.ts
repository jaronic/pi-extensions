import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface PlanArtifactTarget {
  sessionFile?: string;
  sessionId: string;
}

export interface PlanArtifactStore {
  write(markdown: string, target: PlanArtifactTarget, signal?: AbortSignal): Promise<string>;
  discard(path: string): Promise<void>;
  cleanupEphemeral(): Promise<void>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

class FilePlanArtifactStore implements PlanArtifactStore {
  private ephemeralDirectoryPromise: Promise<string> | undefined;
  private readonly ownedPaths = new Set<string>();
  private readonly ephemeralPaths = new Set<string>();
  private lifecycle = Promise.resolve();

  write(markdown: string, target: PlanArtifactTarget, signal?: AbortSignal): Promise<string> {
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const directory = await this.resolveDirectory(target);
      signal?.throwIfAborted();
      const finalPath = join(directory, `${randomUUID()}.md`);
      const temporaryPath = join(directory, `.${randomUUID()}.tmp`);

      try {
        await writeFile(temporaryPath, `${markdown}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
          signal,
        });
        await chmod(temporaryPath, 0o600);
        signal?.throwIfAborted();
        await withFileMutationQueue(finalPath, async () => {
          await rename(temporaryPath, finalPath);
        });
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }

      this.ownedPaths.add(finalPath);
      if (!target.sessionFile) this.ephemeralPaths.add(finalPath);
      return finalPath;
    });
  }

  discard(path: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.ownedPaths.has(path)) return;
      await rm(path, { force: true });
      this.ownedPaths.delete(path);
      this.ephemeralPaths.delete(path);
    });
  }

  cleanupEphemeral(): Promise<void> {
    return this.serialize(async () => {
      const directoryPromise = this.ephemeralDirectoryPromise;
      this.ephemeralDirectoryPromise = undefined;
      if (!directoryPromise) return;
      const directory = await directoryPromise.catch(() => undefined);
      if (!directory) return;
      await rm(directory, { recursive: true, force: true });
      for (const path of this.ephemeralPaths) this.ownedPaths.delete(path);
      this.ephemeralPaths.clear();
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async resolveDirectory(target: PlanArtifactTarget): Promise<string> {
    if (!SESSION_ID_PATTERN.test(target.sessionId)) {
      throw new Error("Plan artifact session ID is invalid.");
    }
    if (target.sessionFile) {
      const sessionFile = resolve(target.sessionFile);
      const root = join(dirname(sessionFile), ".plan-artifacts");
      const directory = join(root, target.sessionId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      await chmod(directory, 0o700);
      return directory;
    }

    this.ephemeralDirectoryPromise ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), "pi-plan-"));
      await chmod(directory, 0o700);
      return directory;
    })();
    return this.ephemeralDirectoryPromise;
  }
}

export function createPlanArtifactStore(): PlanArtifactStore {
  return new FilePlanArtifactStore();
}
