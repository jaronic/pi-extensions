import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { PlanArtifactStore, PlanArtifactTarget } from "../src/artifacts.ts";

interface SentMessage {
  message: unknown;
  options: unknown;
}

interface JournalEntry {
  type: "custom";
  customType: string;
  data: unknown;
}

type RegisteredHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CoordinationHandler = (data: unknown) => void;

export interface ToolInvocationOptions {
  signal?: AbortSignal;
  toolCallId?: string;
}

export interface ExtensionHarnessOptions {
  sessionFile?: string;
  sessionId?: string;
  terminalWidth?: number;
  terminalRows?: number;
}

interface DeferredArtifactWrite {
  promise: Promise<string | undefined>;
  resolve(path?: string): void;
  reject(error: unknown): void;
}

export class InMemoryPlanArtifactStore implements PlanArtifactStore {
  readonly files = new Map<string, string>();
  readonly writes: Array<{ markdown: string; target: PlanArtifactTarget }> = [];
  readonly discardedPaths: string[] = [];
  cleanupCount = 0;
  private nextWriteFailure: unknown;
  private nextReturnedPath: string | undefined;
  private nextDeferredWrite: DeferredArtifactWrite | undefined;
  private sequence = 0;

  failNextWrite(error: unknown): void {
    this.nextWriteFailure = error;
  }

  returnNextPath(path: string): void {
    this.nextReturnedPath = path;
  }

  deferNextWrite(): DeferredArtifactWrite {
    let resolvePromise: (path: string | undefined) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const deferred: DeferredArtifactWrite = {
      promise: new Promise<string | undefined>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      }),
      resolve: (path) => resolvePromise(path),
      reject: (error) => rejectPromise(error),
    };
    this.nextDeferredWrite = deferred;
    return deferred;
  }

  async write(markdown: string, target: PlanArtifactTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.writes.push({ markdown, target });
    const failure = this.nextWriteFailure;
    this.nextWriteFailure = undefined;
    if (failure !== undefined) throw failure;
    const deferred = this.nextDeferredWrite;
    this.nextDeferredWrite = undefined;
    const deferredPath = deferred ? await deferred.promise : undefined;
    signal?.throwIfAborted();
    const path = deferredPath ?? this.nextReturnedPath ?? `/test-plan-artifacts/${target.sessionId}/${++this.sequence}.md`;
    this.nextReturnedPath = undefined;
    this.files.set(path, markdown);
    return path;
  }

  async discard(path: string): Promise<void> {
    this.discardedPaths.push(path);
    this.files.delete(path);
  }

  async cleanupEphemeral(): Promise<void> {
    this.cleanupCount += 1;
  }
}

export class ExtensionHarness {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly entries: JournalEntry[] = [];
  readonly notifications: Array<{ message: string; type: string | undefined }> = [];
  readonly sentMessages: SentMessage[] = [];
  readonly statuses = new Map<string, string | undefined>();
  readonly widgets = new Map<string, string[] | undefined>();
  readonly agentOperations: string[] = [];
  readonly customViews: string[][] = [];
  readonly customCompletionStates: boolean[] = [];
  abortCount = 0;
  waitForIdleCount = 0;

  private readonly commands = new Map<string, unknown>();
  private readonly tools = new Map<string, unknown>();
  private readonly handlers = new Map<string, RegisteredHandler[]>();
  private readonly coordinationHandlers = new Map<string, CoordinationHandler[]>();
  private activeTools: string[];
  private pendingMessages = false;
  private idle = true;
  private customResponses: Array<string | undefined> = [];
  private customInputs: string[] = [];
  private holdWaitForIdle = false;
  private idleWaiters: Array<() => void> = [];
  private sessionId = "session-1";
  private readonly configuredToolSources = new Map<string, string>();
  private sessionFile: string | undefined;
  private terminalWidth: number;
  private terminalRows: number;
  private nextAppendEntryFailure: unknown;

  constructor(
    initialTools: string[] = ["read", "bash", "edit", "write", "unknown_writer"],
    hasUI = true,
    options: ExtensionHarnessOptions = {},
  ) {
    this.sessionId = options.sessionId ?? "session-1";
    this.sessionFile = options.sessionFile;
    this.terminalWidth = options.terminalWidth ?? 100;
    this.terminalRows = options.terminalRows ?? 40;
    this.activeTools = [...initialTools];
    const builtinTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    for (const name of new Set([...initialTools, "grep", "find", "ls"])) {
      this.configuredToolSources.set(name, builtinTools.has(name) ? "builtin" : "test");
    }
    const themeCodes: Record<string, number> = {
      accent: 36,
      borderAccent: 96,
      borderMuted: 90,
      dim: 90,
      error: 31,
      mdCode: 35,
      mdCodeBlock: 32,
      mdCodeBlockBorder: 90,
      mdHeading: 34,
      mdHr: 90,
      mdLink: 94,
      mdLinkUrl: 90,
      mdListBullet: 36,
      mdQuote: 90,
      mdQuoteBorder: 90,
      muted: 90,
      success: 32,
      text: 37,
      warning: 33,
    };
    const ui = {
      select: async () => undefined,
      custom: async <T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (result: T) => void,
        ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      ): Promise<T> => {
        const tui = { terminal: { rows: this.terminalRows }, requestRender: () => undefined } as unknown as TUI;
        const theme = {
          bg: (color: string, value: string) => color === "selectedBg" ? `\u001b[48;5;238m${value}\u001b[0m` : value,
          fg: (color: string, value: string) => {
            const code = themeCodes[color];
            return code ? `\u001b[${code}m${value}\u001b[0m` : value;
          },
          bold: (value: string) => `\u001b[1m${value}\u001b[0m`,
          italic: (value: string) => value,
          strikethrough: (value: string) => value,
          underline: (value: string) => value,
          inverse: (value: string) => `\u001b[7m${value}\u001b[0m`,
        } as unknown as Theme;
        const defaultKeys: Record<string, KeyId[]> = {
          "tui.select.up": ["up"],
          "tui.select.down": ["down"],
          "tui.select.pageUp": ["pageUp"],
          "tui.select.pageDown": ["pageDown"],
          "tui.select.confirm": ["enter"],
          "tui.select.cancel": ["escape", "ctrl+c"],
        };
        const keybindings = {
          matches: (data: string, id: string) => (defaultKeys[id] ?? []).some((key) => matchesKey(data, key)),
        } as unknown as KeybindingsManager;
        let completed: T | undefined;
        let didComplete = false;
        const component = await factory(tui, theme, keybindings, (value) => {
          completed = value;
          didComplete = true;
        });
        component.render(this.terminalWidth);
        for (const input of this.customInputs.splice(0)) component.handleInput?.(input);
        this.customCompletionStates.push(didComplete);
        this.customViews.push(component.render(this.terminalWidth));
        const result = didComplete ? completed : this.customResponses.shift() as T;
        component.dispose?.();
        return result as T;
      },
      confirm: async () => true,
      input: async () => undefined,
      editor: async (_title: string, prefill?: string) => prefill,
      notify: (message: string, type?: string) => this.notifications.push({ message, type }),
      setStatus: (key: string, value: string | undefined) => this.statuses.set(key, value),
      setWidget: (key: string, value: string[] | undefined) => this.widgets.set(key, value),
      theme: { fg: (_color: string, value: string) => value },
    };
    const sessionManager = {
      getSessionId: () => this.sessionId,
      getBranch: () => this.entries,
      getSessionFile: () => this.sessionFile,
    };
    const contextDouble = {
      ui,
      mode: hasUI ? "tui" : "print",
      hasUI,
      cwd: process.cwd(),
      sessionManager,
      modelRegistry: {},
      model: undefined,
      isIdle: () => this.idle,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => {
        this.abortCount += 1;
        this.agentOperations.push("abort");
      },
      hasPendingMessages: () => this.pendingMessages,
      waitForIdle: async () => {
        this.agentOperations.push("wait");
        this.waitForIdleCount += 1;
        if (this.holdWaitForIdle) {
          await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
        }
        this.pendingMessages = false;
        this.idle = true;
      },
      getContextUsage: () => undefined,
      compact: async () => undefined,
      newSession: async () => ({ cancelled: false }),
      fork: async () => ({ cancelled: false }),
      navigateTree: async () => ({ cancelled: false }),
    };
    // This test double intentionally implements only the ExtensionContext surface exercised by these plugins.
    this.context = contextDouble as unknown as ExtensionContext;

    const eventBus = {
      on: (channel: string, handler: CoordinationHandler) => {
        const listeners = this.coordinationHandlers.get(channel) ?? [];
        listeners.push(handler);
        this.coordinationHandlers.set(channel, listeners);
        return () => {
          const current = this.coordinationHandlers.get(channel) ?? [];
          this.coordinationHandlers.set(channel, current.filter((candidate) => candidate !== handler));
        };
      },
      emit: (channel: string, data: unknown) => {
        for (const handler of this.coordinationHandlers.get(channel) ?? []) handler(data);
      },
    };
    const apiDouble = {
      events: eventBus,
      on: (eventName: string, handler: RegisteredHandler) => {
        const listeners = this.handlers.get(eventName) ?? [];
        listeners.push(handler);
        this.handlers.set(eventName, listeners);
      },
      registerCommand: (name: string, definition: unknown) => this.commands.set(name, definition),
      registerTool: (definition: unknown) => {
        if (!definition || typeof definition !== "object" || !("name" in definition) || typeof definition.name !== "string") {
          throw new Error("Invalid tool definition in test harness.");
        }
        this.tools.set(definition.name, definition);
        this.configuredToolSources.set(definition.name, "extension");
        if (!this.activeTools.includes(definition.name)) this.activeTools.push(definition.name);
      },
      getActiveTools: () => [...this.activeTools],
      getAllTools: () => [...this.configuredToolSources].map(([name, source]) => ({
        name,
        description: "",
        parameters: {},
        sourceInfo: { path: source, source, scope: "temporary", origin: "top-level" },
      })),
      setActiveTools: (names: string[]) => {
        this.activeTools = [...names];
      },
      appendEntry: (customType: string, data: unknown) => {
        const failure = this.nextAppendEntryFailure;
        this.nextAppendEntryFailure = undefined;
        if (failure !== undefined) throw failure;
        this.entries.push({ type: "custom", customType, data });
      },
      sendMessage: (message: unknown, options: unknown) => {
        this.sentMessages.push({ message, options });
        this.agentOperations.push("send");
        this.pendingMessages = true;
        this.idle = false;
      },
    };
    // This test double intentionally implements only the ExtensionAPI surface exercised by these plugins.
    this.api = apiDouble as unknown as ExtensionAPI;
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  toolDefinition(name: string): unknown {
    return this.tools.get(name);
  }

  clearPendingMessages(): void {
    this.pendingMessages = false;
    this.idle = true;
  }

  deferWaitForIdle(): void {
    this.holdWaitForIdle = true;
  }

  releaseWaitForIdle(): void {
    this.holdWaitForIdle = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  setSessionId(value: string): void {
    this.sessionId = value;
  }

  failNextAppendEntry(error: unknown): void {
    this.nextAppendEntryFailure = error;
  }

  setIdle(value: boolean): void {
    this.idle = value;
  }

  setCustomResponses(...responses: Array<string | undefined>): void {
    this.customResponses = responses;
  }

  setCustomInputs(...inputs: string[]): void {
    this.customInputs = inputs;
  }

  async emit(eventName: string, event: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(eventName) ?? []) {
      results.push(await handler(event, this.context));
    }
    return results;
  }

  commandCompletions(name: string, prefix: string): unknown {
    const definition = this.commands.get(name);
    if (!definition || typeof definition !== "object" || !("getArgumentCompletions" in definition)) return null;
    const getArgumentCompletions = definition.getArgumentCompletions;
    if (typeof getArgumentCompletions !== "function") return null;
    return Reflect.apply(getArgumentCompletions, definition, [prefix]);
  }

  async command(name: string, args = ""): Promise<void> {
    const definition = this.commands.get(name);
    if (!definition || typeof definition !== "object" || !("handler" in definition)) {
      throw new Error(`Unknown command: ${name}`);
    }
    const handler = definition.handler;
    if (typeof handler !== "function") throw new Error(`Command has no handler: ${name}`);
    await Reflect.apply(handler, definition, [args, this.context]);
  }

  async tool(
    name: string,
    params: Record<string, unknown>,
    options: ToolInvocationOptions = {},
  ): Promise<unknown> {
    const definition = this.tools.get(name);
    if (!definition || typeof definition !== "object" || !("execute" in definition)) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const execute = definition.execute;
    if (typeof execute !== "function") throw new Error(`Tool has no execute function: ${name}`);
    const signal = options.signal ?? new AbortController().signal;
    return Reflect.apply(execute, definition, [options.toolCallId ?? "call-1", params, signal, undefined, this.context]);
  }
}

export function blockedDecision(results: unknown[]): { block: true; reason: string } | undefined {
  for (const result of results) {
    if (!result || typeof result !== "object" || !("block" in result) || result.block !== true) continue;
    const reason = "reason" in result && typeof result.reason === "string" ? result.reason : "blocked";
    return { block: true, reason };
  }
  return undefined;
}
