import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

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

/**
 * Minimal Pi extension harness for Goal command tests. It doubles the
 * ExtensionAPI/ExtensionContext surface exercised by the Goal extension and
 * allows a fake Plan workflow listener to be registered on the shared
 * EventBus so exclusivity arbitration can be exercised in isolation.
 */
export class ExtensionHarness {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly entries: JournalEntry[] = [];
  readonly notifications: Array<{ message: string; type: string | undefined }> = [];
  readonly sentMessages: SentMessage[] = [];
  readonly statuses = new Map<string, string | undefined>();
  readonly agentOperations: string[] = [];
  private readonly commands = new Map<string, unknown>();
  private readonly tools = new Map<string, unknown>();
  private readonly handlers = new Map<string, RegisteredHandler[]>();
  private readonly coordinationHandlers = new Map<string, CoordinationHandler[]>();
  private activeTools: string[];
  private pendingMessages = false;
  private idle = true;
  private customResponses: Array<string | undefined> = [];
  private sessionId = "session-1";

  constructor(
    initialTools: string[] = ["read", "bash", "edit", "write", "unknown_writer"],
    hasUI = true,
  ) {
    this.activeTools = [...initialTools];
    const theme = {
      fg: (_color: string, value: string) => value,
      bg: (_color: string, value: string) => value,
      bold: (value: string) => value,
      italic: (value: string) => value,
      strikethrough: (value: string) => value,
      underline: (value: string) => value,
      inverse: (value: string) => value,
    } as unknown as Theme;
    const ui = {
      editor: async (_title: string, prefill?: string) => {
        const response = this.customResponses.shift();
        return response === undefined ? prefill : response;
      },
      confirm: async () => true,
      notify: (message: string, type?: string) => this.notifications.push({ message, type }),
      setStatus: (key: string, value: string | undefined) => this.statuses.set(key, value),
      setWidget: (_key: string, _value: unknown) => undefined,
      theme,
    };
    const sessionManager = {
      getSessionId: () => this.sessionId,
      getBranch: () => this.entries,
    };
    const contextDouble = {
      ui,
      mode: hasUI ? "tui" : "print",
      hasUI,
      sessionManager,
      isIdle: () => this.idle,
      isProjectTrusted: () => true,
      abort: () => {
        this.agentOperations.push("abort");
      },
      hasPendingMessages: () => this.pendingMessages,
      waitForIdle: async () => {
        this.agentOperations.push("wait");
        this.pendingMessages = false;
        this.idle = true;
      },
    };
    // This test double intentionally implements only the ExtensionContext surface exercised by the Goal extension.
    this.context = contextDouble as unknown as ExtensionContext;

    const eventBus = {
      on: (channel: string, handler: CoordinationHandler) => {
        const listeners = this.coordinationHandlers.get(channel) ?? [];
        listeners.push(handler);
        this.coordinationHandlers.set(channel, listeners);
        return () => {
          this.coordinationHandlers.set(
            channel,
            (this.coordinationHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
          );
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
      registerCommand: (name: string, definition: unknown) => {
        this.commands.set(name, definition);
      },
      registerTool: (definition: unknown) => {
        if (!definition || typeof definition !== "object" || !("name" in definition) || typeof definition.name !== "string") {
          throw new Error("Invalid tool definition in test harness.");
        }
        this.tools.set(definition.name, definition);
        if (!this.activeTools.includes(definition.name)) this.activeTools.push(definition.name);
      },
      getActiveTools: () => [...this.activeTools],
      setActiveTools: (names: string[]) => {
        this.activeTools = [...names];
      },
      appendEntry: (customType: string, data: unknown) => {
        this.entries.push({ type: "custom", customType, data });
      },
      sendMessage: (message: unknown, options: unknown) => {
        this.sentMessages.push({ message, options });
        this.agentOperations.push("send");
        this.pendingMessages = true;
        this.idle = false;
      },
    };
    // This test double intentionally implements only the ExtensionAPI surface exercised by the Goal extension.
    this.api = apiDouble as unknown as ExtensionAPI;
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  clearPendingMessages(): void {
    this.pendingMessages = false;
    this.idle = true;
  }

  setIdle(value: boolean): void {
    this.idle = value;
  }

  setSessionId(value: string): void {
    this.sessionId = value;
  }

  setCustomResponses(...responses: Array<string | undefined>): void {
    this.customResponses = responses;
  }

  async emit(eventName: string, event: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(eventName) ?? []) {
      results.push(await handler(event, this.context));
    }
    return results;
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

  async tool(name: string, params: Record<string, unknown>): Promise<unknown> {
    const definition = this.tools.get(name);
    if (!definition || typeof definition !== "object" || !("execute" in definition)) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const execute = definition.execute;
    if (typeof execute !== "function") throw new Error(`Tool has no execute function: ${name}`);
    return Reflect.apply(execute, definition, ["call-1", params, new AbortController().signal, undefined, this.context]);
  }
}
