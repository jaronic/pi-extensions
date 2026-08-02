import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";

interface ToolDefinition {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
  renderCall?: (...args: unknown[]) => Component;
  renderResult?: (...args: unknown[]) => Component;
  [key: string]: unknown;
}

interface CommandDefinition {
  handler: (args: string, ctx: ExtensionCommandContext) => unknown | Promise<unknown>;
  getArgumentCompletions?: (prefix: string) => unknown;
}

type LifecycleHandler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CoordinationHandler = (value: unknown) => void;
type WidgetValue = string[] | ((tui: TUI, theme: Theme) => Component) | undefined;

export interface TodoHarnessOptions {
  readonly mode?: "tui" | "rpc" | "json" | "print";
  readonly hasUI?: boolean;
  readonly sessionId?: string;
  readonly terminalWidth?: number;
  readonly terminalRows?: number;
  readonly initialTools?: readonly string[];
}

export class TodoHarness {
  readonly api: ExtensionAPI;
  readonly context: ExtensionCommandContext;
  readonly entries: unknown[] = [];
  readonly notifications: Array<{ message: string; type?: string }> = [];
  readonly statuses = new Map<string, string | undefined>();
  readonly widgets = new Map<string, string[] | undefined>();
  readonly customFrames: string[][] = [];
  readonly operations: string[] = [];
  readonly themeColors: string[] = [];
  abortCount = 0;
  waitForIdleCount = 0;
  setActiveToolsCount = 0;
  readonly toolRegistrationCounts = new Map<string, number>();
  readonly commandRegistrationCounts = new Map<string, number>();
  readonly lifecycleRegistrationCounts = new Map<string, number>();
  readonly coordinationRegistrationCounts = new Map<string, number>();

  private readonly handlers = new Map<string, LifecycleHandler[]>();
  private readonly coordinationHandlers = new Map<string, CoordinationHandler[]>();
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly toolSources = new Map<string, string>();
  private readonly confirmQueue: Array<{ result: boolean; effect?: () => void | Promise<void> }> = [];
  private readonly customInputs: string[][] = [];
  private readonly customFallbacks: unknown[] = [];
  private activeTools: string[];
  private sessionId: string;
  private idle = true;
  private appendFailure: unknown;
  private readonly terminalWidth: number;
  private readonly terminalRows: number;

  constructor(options: TodoHarnessOptions = {}) {
    const mode = options.mode ?? "tui";
    const hasUI = options.hasUI ?? (mode === "tui" || mode === "rpc");
    this.sessionId = options.sessionId ?? "todo-session";
    this.terminalWidth = options.terminalWidth ?? 100;
    this.terminalRows = options.terminalRows ?? 35;
    this.activeTools = [...(options.initialTools ?? ["read", "bash", "edit", "write"])];
    for (const name of this.activeTools) this.toolSources.set(name, "builtin");

    const colorCodes: Record<string, number> = {
      accent: 36,
      borderAccent: 96,
      borderMuted: 90,
      dim: 90,
      error: 31,
      muted: 90,
      success: 32,
      text: 37,
      toolTitle: 36,
      warning: 33,
    };
    const theme = {
      fg: (color: string, value: string) => {
        this.themeColors.push(color);
        const code = colorCodes[color];
        return code === undefined ? value : `\u001b[${code}m${value}\u001b[0m`;
      },
      bg: (_color: string, value: string) => value,
      bold: (value: string) => `\u001b[1m${value}\u001b[0m`,
      italic: (value: string) => value,
      strikethrough: (value: string) => value,
      underline: (value: string) => value,
      inverse: (value: string) => value,
    } as unknown as Theme;
    const keyMap: Record<string, KeyId[]> = {
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.select.pageUp": ["pageUp"],
      "tui.select.pageDown": ["pageDown"],
      "tui.select.confirm": ["enter"],
      "tui.select.cancel": ["escape", "ctrl+c"],
    };
    const keybindings = {
      matches: (data: string, id: string) => (keyMap[id] ?? []).some((key) => matchesKey(data, key)),
    } as unknown as KeybindingsManager;
    const tui = { terminal: { rows: this.terminalRows }, requestRender: () => undefined } as unknown as TUI;

    const ui = {
      select: async () => undefined,
      confirm: async () => {
        const entry = this.confirmQueue.shift();
        if (entry?.effect !== undefined) await entry.effect();
        return entry?.result ?? false;
      },
      input: async () => undefined,
      notify: (message: string, type?: string) => this.notifications.push({ message, ...(type === undefined ? {} : { type }) }),
      setStatus: (key: string, value: string | undefined) => this.statuses.set(key, value),
      setWidget: (key: string, value: WidgetValue) => {
        const rendered = typeof value === "function" ? value(tui, theme).render(this.terminalWidth) : value;
        this.widgets.set(key, rendered);
      },
      custom: async <T>(factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (value: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>): Promise<T> => {
        let completed = false;
        let result: T | undefined;
        const component = await factory(tui, theme, keybindings, (value) => {
          completed = true;
          result = value;
        });
        try {
          this.customFrames.push(component.render(this.terminalWidth));
          for (const input of this.customInputs.shift() ?? []) {
            component.handleInput?.(input);
            this.customFrames.push(component.render(this.terminalWidth));
            if (completed) break;
          }
          if (!completed && this.customFallbacks.length > 0) {
            result = this.customFallbacks.shift() as T;
            completed = true;
          }
          if (!completed) throw new Error("Todo harness custom component did not settle.");
          return result as T;
        } finally {
          component.dispose?.();
        }
      },
      editor: async (_title: string, prefill?: string) => prefill,
      theme,
    } as unknown as ExtensionUIContext;

    this.context = {
      ui,
      mode,
      hasUI,
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => this.sessionId,
        getBranch: () => this.entries as never,
        getSessionFile: () => undefined,
      },
      modelRegistry: {},
      model: undefined,
      isIdle: () => this.idle,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => {
        this.abortCount += 1;
        this.operations.push("abort");
      },
      waitForIdle: async () => {
        this.waitForIdleCount += 1;
        this.operations.push("wait");
        this.idle = true;
      },
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "base",
      getSystemPromptOptions: () => ({}),
      newSession: async () => ({ cancelled: false }),
      fork: async () => ({ cancelled: false }),
      navigateTree: async () => ({ cancelled: false }),
      switchSession: async () => ({ cancelled: false }),
      reload: async () => undefined,
    } as unknown as ExtensionCommandContext;

    this.api = {
      events: {
        on: (channel: string, handler: CoordinationHandler) => {
          this.coordinationRegistrationCounts.set(channel, (this.coordinationRegistrationCounts.get(channel) ?? 0) + 1);
          const handlers = this.coordinationHandlers.get(channel) ?? [];
          handlers.push(handler);
          this.coordinationHandlers.set(channel, handlers);
          return () => {
            const current = this.coordinationHandlers.get(channel) ?? [];
            this.coordinationHandlers.set(channel, current.filter((candidate) => candidate !== handler));
          };
        },
        emit: (channel: string, value: unknown) => {
          for (const handler of [...(this.coordinationHandlers.get(channel) ?? [])]) handler(value);
        },
      },
      on: (event: string, handler: LifecycleHandler) => {
        this.lifecycleRegistrationCounts.set(event, (this.lifecycleRegistrationCounts.get(event) ?? 0) + 1);
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
      },
      registerTool: (definition: ToolDefinition) => {
        this.toolRegistrationCounts.set(definition.name, (this.toolRegistrationCounts.get(definition.name) ?? 0) + 1);
        this.tools.set(definition.name, definition);
        this.toolSources.set(definition.name, "extension");
        if (!this.activeTools.includes(definition.name)) this.activeTools.push(definition.name);
      },
      registerCommand: (name: string, definition: CommandDefinition) => {
        this.commandRegistrationCounts.set(name, (this.commandRegistrationCounts.get(name) ?? 0) + 1);
        this.commands.set(name, definition);
      },
      getActiveTools: () => [...this.activeTools],
      setActiveTools: (names: string[]) => {
        this.setActiveToolsCount += 1;
        this.activeTools = [...names];
      },
      getAllTools: () => [...this.toolSources].map(([name, source]) => ({
        name,
        description: "",
        parameters: {},
        sourceInfo: { source, path: source, scope: "temporary", origin: "top-level" },
      })),
      appendEntry: (customType: string, data: unknown) => {
        const failure = this.appendFailure;
        this.appendFailure = undefined;
        if (failure !== undefined) throw failure;
        this.operations.push("append");
        this.entries.push({ type: "custom", customType, data });
      },
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;
  }

  queueConfirm(...results: boolean[]): void {
    for (const result of results) this.confirmQueue.push({ result });
  }

  /**
   * Queues a confirmation whose resolution first runs `effect` — used to
   * simulate the board moving while a confirm dialog is pending — then
   * resolves with `result`.
   */
  queueConfirmEffect(effect: () => void | Promise<void>, result = true): void {
    this.confirmQueue.push({ result, effect });
  }

  queueCustomDialog(...inputs: string[]): void {
    this.customInputs.push(inputs);
  }

  queueCustomFallback(value: unknown): void {
    this.customFallbacks.push(value);
  }

  setIdle(value: boolean): void {
    this.idle = value;
  }

  setSessionId(value: string): void {
    this.sessionId = value;
  }

  replaceBranch(entries: readonly unknown[]): void {
    this.entries.splice(0, this.entries.length, ...entries);
  }

  failNextAppend(error: unknown): void {
    this.appendFailure = error;
  }

  getTool(name = "todo"): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  commandCompletions(name: string, prefix: string): unknown {
    return this.commands.get(name)?.getArgumentCompletions?.(prefix) ?? null;
  }

  coordinationListenerCount(channel: string): number {
    return this.coordinationHandlers.get(channel)?.length ?? 0;
  }

  async emit(eventName: string, event: any): Promise<unknown[]> {
    const results: unknown[] = [];
    let current = event;
    for (const handler of this.handlers.get(eventName) ?? []) {
      const result = await handler(current, this.context);
      results.push(result);
      if (eventName === "before_agent_start" && result && typeof result === "object" && "systemPrompt" in result) {
        current = { ...current, systemPrompt: (result as { systemPrompt: string }).systemPrompt };
      }
    }
    if (event && typeof event === "object") Object.assign(event, current);
    return results;
  }

  async startSession(reason = "startup"): Promise<void> {
    await this.emit("session_start", { type: "session_start", reason });
  }

  async command(name: string, args = ""): Promise<void> {
    const definition = this.commands.get(name);
    if (!definition) throw new Error(`Unknown command: ${name}`);
    await definition.handler(args, this.context);
  }

  async tool(
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; persist?: boolean; toolCallId?: string } = {},
  ): Promise<any> {
    return this.executeTool("todo", params, options);
  }

  async executeTool(
    name: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; persist?: boolean; toolCallId?: string } = {},
  ): Promise<any> {
    const tool = this.getTool(name);
    const signal = options.signal ?? new AbortController().signal;
    const toolCallId = options.toolCallId ?? `${name}-call`;
    try {
      const result = await tool.execute(toolCallId, params, signal, undefined, this.context) as any;
      if (options.persist !== false) {
        const message = {
          role: "toolResult",
          toolCallId,
          toolName: name,
          content: result.content,
          details: result.details,
          isError: false,
          timestamp: Date.now(),
        };
        this.entries.push({ type: "message", message });
        await this.emit("tool_result", { type: "tool_result", ...message, input: params });
      }
      return result;
    } catch (error) {
      if (options.persist !== false) {
        const message = {
          role: "toolResult",
          toolCallId,
          toolName: name,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: undefined,
          isError: true,
          timestamp: Date.now(),
        };
        this.entries.push({ type: "message", message });
        await this.emit("tool_result", { type: "tool_result", ...message, input: params });
      }
      throw error;
    }
  }
}
