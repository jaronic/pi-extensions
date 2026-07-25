import { watch } from "node:fs";
import { dirname, resolve } from "node:path";

export interface BranchWatcher {
  close(): void;
  on(event: "error", listener: () => void): unknown;
}

export type GitCommandRunner = (args: string[], cwd: string) => Promise<string>;
export type BranchChangeListener = (branch: string | undefined) => void;
export type WatchDirectory = (
  directory: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => BranchWatcher;

export interface BranchMonitorOptions {
  runGit: GitCommandRunner;
  onBranch: BranchChangeListener;
  debounceMs?: number;
  watchDirectory?: WatchDirectory;
}

const DEFAULT_DEBOUNCE_MS = 50;

const defaultWatchDirectory: WatchDirectory = (directory, listener) =>
  watch(directory, { persistent: false }, listener);

export class BranchMonitor {
  private readonly debounceMs: number;
  private readonly onBranch: BranchChangeListener;
  private readonly runGit: GitCommandRunner;
  private readonly watchDirectory: WatchDirectory;
  private cwd: string | undefined;
  private refreshGeneration = 0;
  private timer: NodeJS.Timeout | undefined;
  private watcher: BranchWatcher | undefined;
  private watcherGeneration = 0;

  constructor(options: BranchMonitorOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onBranch = options.onBranch;
    this.runGit = options.runGit;
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
  }

  async start(cwd: string): Promise<void> {
    this.stop();
    this.cwd = cwd;
    const watcherGeneration = ++this.watcherGeneration;
    await Promise.all([
      this.refresh(cwd),
      this.installWatcher(cwd, watcherGeneration),
    ]);
  }

  stop(): void {
    this.watcherGeneration += 1;
    this.refreshGeneration += 1;
    this.cwd = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async installWatcher(cwd: string, generation: number): Promise<void> {
    let headPath: string;
    try {
      headPath = (await this.runGit(["rev-parse", "--git-path", "HEAD"], cwd)).trim();
    } catch {
      return;
    }
    if (!headPath || generation !== this.watcherGeneration || cwd !== this.cwd) return;

    let watcher: BranchWatcher;
    try {
      watcher = this.watchDirectory(dirname(resolve(cwd, headPath)), (_eventType, filename) => {
        if (filename !== null && String(filename) !== "HEAD") return;
        this.scheduleRefresh(cwd);
      });
    } catch {
      return;
    }
    if (generation !== this.watcherGeneration || cwd !== this.cwd) {
      watcher.close();
      return;
    }

    this.watcher = watcher;
    watcher.on("error", () => {
      if (this.watcher !== watcher || generation !== this.watcherGeneration) return;
      this.watcher = undefined;
      watcher.close();
      this.scheduleRefresh(cwd);
      void this.installWatcher(cwd, generation);
    });
  }

  private scheduleRefresh(cwd: string): void {
    if (cwd !== this.cwd) return;
    this.refreshGeneration += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(cwd);
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private async refresh(cwd: string): Promise<void> {
    const generation = ++this.refreshGeneration;
    try {
      const branch = (await this.runGit(["branch", "--show-current"], cwd)).trim();
      if (generation !== this.refreshGeneration || cwd !== this.cwd) return;
      this.onBranch(branch || undefined);
    } catch {
      if (generation !== this.refreshGeneration || cwd !== this.cwd) return;
      this.onBranch(undefined);
    }
  }
}
