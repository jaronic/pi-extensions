import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type EventHandler = (value: unknown) => void;

interface ToolDefinition {
  name: string;
  execute: (...args: unknown[]) => unknown;
  renderCall?: (...args: unknown[]) => Component;
  renderResult?: (...args: unknown[]) => Component;
}

interface CommandDefinition {
  handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
}

export interface RequestHarnessOptions {
  hasUI?: boolean;
  mode?: "tui" | "print" | "rpc" | "json";
  terminalRows?: number;
  terminalWidth?: number;
}

export class RequestHarness {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly ui: ExtensionUIContext;
  readonly customFrames: string[][] = [];
  readonly nativeCalls: Array<{ method: "select" | "confirm" | "input"; values: unknown[] }> = [];
  readonly originalSelect: ExtensionUIContext["select"];
  readonly originalConfirm: ExtensionUIContext["confirm"];
  readonly originalInput: ExtensionUIContext["input"];
  maxConcurrentCustom = 0;
  readonly toolRegistrationCounts = new Map<string, number>();
  readonly lifecycleRegistrationCounts = new Map<string, number>();
  readonly eventListenerRegistrationCounts = new Map<string, number>();

  private readonly handlers = new Map<string, LifecycleHandler[]>();
  private readonly eventHandlers = new Map<string, EventHandler[]>();
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly dialogInputs: string[][] = [];
  private readonly nativeSelectResults: Array<string | undefined> = [];
  private readonly nativeConfirmResults: boolean[] = [];
  private readonly nativeInputResults: Array<string | undefined> = [];
  private readonly dialogOpenWaiters: Array<() => void> = [];
  private activeCustom = 0;
  private holdNextCustom = false;

  constructor(options: RequestHarnessOptions = {}) {
    const terminalWidth = options.terminalWidth ?? 80;
    const terminalRows = options.terminalRows ?? 30;
    const hasUI = options.hasUI ?? true;
    const mode = options.mode ?? (hasUI ? "tui" : "print");

    this.originalSelect = async (title, values, dialogOptions) => {
      this.nativeCalls.push({ method: "select", values: [title, values, dialogOptions] });
      return this.nativeSelectResults.shift();
    };
    this.originalConfirm = async (title, message, dialogOptions) => {
      this.nativeCalls.push({ method: "confirm", values: [title, message, dialogOptions] });
      return this.nativeConfirmResults.shift() ?? false;
    };
    this.originalInput = async (title, placeholder, dialogOptions) => {
      this.nativeCalls.push({ method: "input", values: [title, placeholder, dialogOptions] });
      return this.nativeInputResults.shift();
    };

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
    const theme = {
      bg: (color: string, value: string) => color === "selectedBg" ? `\u001b[48;5;238m${value}\u001b[0m` : value,
      fg: (color: string, value: string) => {
        const code = color === "success" ? 32 : color === "error" ? 31 : color === "warning" ? 33 : color === "accent" ? 36 : color === "borderAccent" ? 96 : color === "borderMuted" || color === "muted" || color === "dim" ? 90 : undefined;
        return code ? `\u001b[${code}m${value}\u001b[0m` : value;
      },
      bold: (value: string) => `\u001b[1m${value}\u001b[0m`,
      italic: (value: string) => value,
      strikethrough: (value: string) => value,
      underline: (value: string) => value,
      inverse: (value: string) => `\u001b[7m${value}\u001b[0m`,
    } as unknown as Theme;
    const tui = { terminal: { rows: terminalRows }, requestRender: () => undefined } as unknown as TUI;

    const ui = {
      select: this.originalSelect,
      confirm: this.originalConfirm,
      input: this.originalInput,
      custom: async <T>(factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>): Promise<T> => {
        this.activeCustom += 1;
        this.maxConcurrentCustom = Math.max(this.maxConcurrentCustom, this.activeCustom);
        for (const resolve of this.dialogOpenWaiters.splice(0)) resolve();
        let completed = false;
        let result: T | undefined;
        let release: (() => void) | undefined;
        const component = await factory(tui, theme, keybindings, (value) => {
          if (completed) return;
          completed = true;
          result = value;
          release?.();
        });
        const render = () => this.customFrames.push(component.render(terminalWidth));
        try {
          render();
          for (const input of this.dialogInputs.shift() ?? []) {
            component.handleInput?.(input);
            render();
            if (completed) break;
          }
          if (!completed && this.holdNextCustom) {
            this.holdNextCustom = false;
            const gate = Promise.withResolvers<void>();
            release = gate.resolve;
            if (completed) gate.resolve();
            await gate.promise;
            render();
          }
          if (!completed) throw new Error("Request test dialog did not settle; queue input or hold the dialog explicitly.");
          return result as T;
        } finally {
          component.dispose?.();
          this.activeCustom -= 1;
        }
      },
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
      editor: async (_title: string, prefill?: string) => prefill,
      theme,
    } as unknown as ExtensionUIContext;
    this.ui = ui;

    this.context = {
      ui,
      mode,
      hasUI,
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => "request-session",
        getBranch: () => [],
        getSessionFile: () => undefined,
      },
      modelRegistry: {},
      model: undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      waitForIdle: async () => undefined,
      getContextUsage: () => undefined,
      compact: async () => undefined,
      newSession: async () => ({ cancelled: false }),
      fork: async () => ({ cancelled: false }),
      navigateTree: async () => ({ cancelled: false }),
    } as unknown as ExtensionContext;

    const events = {
      on: (channel: string, handler: EventHandler) => {
        this.eventListenerRegistrationCounts.set(channel, (this.eventListenerRegistrationCounts.get(channel) ?? 0) + 1);
        const handlers = this.eventHandlers.get(channel) ?? [];
        handlers.push(handler);
        this.eventHandlers.set(channel, handlers);
        return () => {
          const current = this.eventHandlers.get(channel) ?? [];
          this.eventHandlers.set(channel, current.filter((candidate) => candidate !== handler));
        };
      },
      emit: (channel: string, value: unknown) => {
        for (const handler of [...(this.eventHandlers.get(channel) ?? [])]) handler(value);
      },
    };
    this.api = {
      events,
      on: (event: string, handler: LifecycleHandler) => {
        this.lifecycleRegistrationCounts.set(event, (this.lifecycleRegistrationCounts.get(event) ?? 0) + 1);
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
      },
      registerTool: (definition: ToolDefinition) => {
        this.toolRegistrationCounts.set(definition.name, (this.toolRegistrationCounts.get(definition.name) ?? 0) + 1);
        this.tools.set(definition.name, definition);
      },
      registerCommand: (name: string, definition: CommandDefinition) => this.commands.set(name, definition),
      getActiveTools: () => [],
      setActiveTools: () => undefined,
      appendEntry: () => undefined,
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;
  }

  queueDialog(...inputs: string[]): void {
    this.dialogInputs.push(inputs);
  }

  holdNextDialog(): void {
    this.holdNextCustom = true;
  }

  waitForDialogOpen(): Promise<void> {
    if (this.activeCustom > 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.dialogOpenWaiters.push(resolve);
    return promise;
  }

  queueNativeSelect(result: string | undefined): void {
    this.nativeSelectResults.push(result);
  }

  queueNativeConfirm(result: boolean): void {
    this.nativeConfirmResults.push(result);
  }

  queueNativeInput(result: string | undefined): void {
    this.nativeInputResults.push(result);
  }

  getTool(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  async tool(name: string, params: Record<string, unknown>, signal = new AbortController().signal): Promise<unknown> {
    const tool = this.getTool(name);
    return Reflect.apply(tool.execute, tool, ["call-1", params, signal, undefined, this.context]);
  }

  async command(name: string, args = ""): Promise<void> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`Unknown command: ${name}`);
    await Reflect.apply(command.handler, command, [args, this.context]);
  }

  eventListenerCount(channel: string): number {
    return this.eventHandlers.get(channel)?.length ?? 0;
  }

  async emit(event: string, value: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(value, this.context);
  }
}
