import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SentMessage {
  message: unknown;
  options: unknown;
}

type RegisteredHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

export interface EnforceHarnessOptions {
  cwd?: string;
  trusted?: boolean;
}

/** Minimal test double for the ExtensionAPI/ExtensionContext surface enforce uses. */
export class EnforceHarness {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly notifications: Array<{ message: string; type: string | undefined }> = [];
  readonly sentMessages: SentMessage[] = [];
  readonly commandRegistrationCounts = new Map<string, number>();
  readonly toolRegistrationCounts = new Map<string, number>();
  readonly lifecycleRegistrationCounts = new Map<string, number>();
  private readonly commands = new Map<string, unknown>();
  private readonly handlers = new Map<string, RegisteredHandler[]>();
  private activeTools: string[];
  private readonly trusted: boolean;
  failNextSendMessage: unknown;

  constructor(initialTools: string[] = ["read", "grep", "bash", "lsp"], hasUI = true, options: EnforceHarnessOptions = {}) {
    this.activeTools = [...initialTools];
    this.trusted = options.trusted ?? true;
    const ui = {
      notify: (message: string, type?: string) => this.notifications.push({ message, type }),
    };
    const contextDouble = {
      ui,
      mode: hasUI ? "tui" : "print",
      hasUI,
      cwd: options.cwd ?? process.cwd(),
      isProjectTrusted: () => this.trusted,
      isIdle: () => false,
    };
    // This test double intentionally implements only the ExtensionContext surface enforce exercises.
    this.context = contextDouble as unknown as ExtensionContext;

    const apiDouble = {
      on: (eventName: string, handler: RegisteredHandler) => {
        this.lifecycleRegistrationCounts.set(eventName, (this.lifecycleRegistrationCounts.get(eventName) ?? 0) + 1);
        const listeners = this.handlers.get(eventName) ?? [];
        listeners.push(handler);
        this.handlers.set(eventName, listeners);
      },
      registerCommand: (name: string, definition: unknown) => {
        this.commandRegistrationCounts.set(name, (this.commandRegistrationCounts.get(name) ?? 0) + 1);
        this.commands.set(name, definition);
      },
      registerTool: (definition: unknown) => {
        if (!definition || typeof definition !== "object" || !("name" in definition) || typeof definition.name !== "string") {
          throw new Error("Invalid tool definition in test harness.");
        }
        this.toolRegistrationCounts.set(definition.name, (this.toolRegistrationCounts.get(definition.name) ?? 0) + 1);
      },
      getActiveTools: () => [...this.activeTools],
      setActiveTools: (names: string[]) => {
        this.activeTools = [...names];
      },
      sendMessage: (message: unknown, options: unknown) => {
        const failure = this.failNextSendMessage;
        this.failNextSendMessage = undefined;
        if (failure !== undefined) throw failure;
        this.sentMessages.push({ message, options });
      },
    };
    // This test double intentionally implements only the ExtensionAPI surface enforce exercises.
    this.api = apiDouble as unknown as ExtensionAPI;
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  async emit(eventName: string, event: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(eventName) ?? []) {
      results.push(await handler(event, this.context));
    }
    return results;
  }

  async emitToolCall(toolName: string, input: Record<string, unknown>): Promise<unknown[]> {
    return await this.emit("tool_call", { type: "tool_call", toolName, toolCallId: `call-${toolName}`, input });
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
}

export function blockedDecision(results: unknown[]): { block: true; reason: string } | undefined {
  for (const result of results) {
    if (!result || typeof result !== "object" || !("block" in result) || result.block !== true) continue;
    const reason = "reason" in result && typeof result.reason === "string" ? result.reason : "blocked";
    return { block: true, reason };
  }
  return undefined;
}
