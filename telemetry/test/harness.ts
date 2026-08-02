import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface HarnessEntry {
  type: "custom";
  customType: string;
  data: unknown;
}

type RegisteredHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface CommandDefinition {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown;
}

export interface TelemetryHarnessOptions {
  hasUI?: boolean;
  cwd?: string;
  sessionId?: string;
}

export class TelemetryHarness {
  readonly entries: HarnessEntry[] = [];
  readonly notifications: Array<{ message: string; type: string | undefined }> = [];
  readonly toolRegistrationCounts = new Map<string, number>();
  readonly commandRegistrationCounts = new Map<string, number>();
  model: { provider: string; id: string } | undefined = { provider: "anthropic", id: "claude-test" };
  confirmResponses: boolean[] = [];
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly handlers = new Map<string, RegisteredHandler[]>();
  private readonly sessionId: string;
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;

  constructor(options: TelemetryHarnessOptions = {}) {
    const hasUI = options.hasUI ?? true;
    this.sessionId = options.sessionId ?? "session-1";
    const ui = {
      notify: (message: string, type?: string) => this.notifications.push({ message, type }),
      confirm: async () => this.confirmResponses.shift() ?? true,
      setStatus: () => undefined,
      setWidget: () => undefined,
    };
    const sessionManager = {
      getSessionId: () => this.sessionId,
      getBranch: () => this.entries,
    };
    const contextDouble = {
      ui,
      mode: hasUI ? "tui" : "print",
      hasUI,
      cwd: options.cwd ?? process.cwd(),
      sessionManager,
      model: this.model,
      isIdle: () => true,
      hasPendingMessages: () => false,
    };
    // This test double intentionally implements only the ExtensionContext surface telemetry uses.
    this.context = new Proxy(contextDouble, {
      get: (target, property) => {
        if (property === "model") return this.model;
        return Reflect.get(target, property);
      },
    }) as unknown as ExtensionContext;

    const apiDouble = {
      on: (eventName: string, handler: RegisteredHandler) => {
        const listeners = this.handlers.get(eventName) ?? [];
        listeners.push(handler);
        this.handlers.set(eventName, listeners);
      },
      registerCommand: (name: string, definition: CommandDefinition) => {
        this.commandRegistrationCounts.set(name, (this.commandRegistrationCounts.get(name) ?? 0) + 1);
        this.commands.set(name, definition);
      },
      registerTool: (definition: { name?: string }) => {
        const name = definition?.name ?? "unknown";
        this.toolRegistrationCounts.set(name, (this.toolRegistrationCounts.get(name) ?? 0) + 1);
      },
      appendEntry: (customType: string, data: unknown) => {
        this.entries.push({ type: "custom", customType, data });
      },
    };
    // This test double intentionally implements only the ExtensionAPI surface telemetry uses.
    this.api = apiDouble as unknown as ExtensionAPI;
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
    if (!definition) throw new Error(`Unknown command: ${name}`);
    await definition.handler(args, this.context);
  }

  commandCompletions(name: string, prefix: string): unknown {
    return this.commands.get(name)?.getArgumentCompletions?.(prefix) ?? null;
  }
}
