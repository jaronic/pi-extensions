import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface HarnessJournalEntry {
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
}

type RegisteredHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

export class HashlineHarness {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly notifications: Array<{ message: string; type: string | undefined }> = [];
  private branch: HarnessJournalEntry[] = [];
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly handlers = new Map<string, RegisteredHandler[]>();
  private nextAppendFailure: unknown;

  constructor(readonly cwd: string, hasUI = false) {
    const ui = {
      notify: (message: string, type?: string) => this.notifications.push({ message, type }),
      setStatus: () => undefined,
      setWidget: () => undefined,
      theme: { fg: (_color: string, value: string) => value },
    };
    const context = {
      cwd,
      hasUI,
      mode: hasUI ? "tui" : "print",
      model: { input: ["text"] },
      ui,
      sessionManager: {
        getSessionId: () => "hashline-test-session",
        getBranch: () => this.branch,
      },
      isProjectTrusted: () => true,
    };
    this.context = context as unknown as ExtensionContext;
    this.api = {
      registerTool: (tool: ToolDefinition) => this.tools.set(tool.name, tool),
      on: (eventName: string, handler: RegisteredHandler) => {
        const listeners = this.handlers.get(eventName) ?? [];
        listeners.push(handler);
        this.handlers.set(eventName, listeners);
      },
      appendEntry: (customType: string, data: unknown) => {
        const failure = this.nextAppendFailure;
        this.nextAppendFailure = undefined;
        if (failure !== undefined) throw failure;
        this.branch.push({ type: "custom", customType, data });
      },
      events: { on: () => () => undefined, emit: () => undefined },
    } as unknown as ExtensionAPI;
  }

  entries(): readonly HarnessJournalEntry[] {
    return this.branch;
  }

  setBranch(entries: readonly HarnessJournalEntry[]): void {
    this.branch = [...entries];
  }

  failNextAppend(error: unknown): void {
    this.nextAppendFailure = error;
  }

  toolDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async emit(eventName: string, event: unknown): Promise<void> {
    for (const handler of this.handlers.get(eventName) ?? []) await handler(event, this.context);
  }

  async tool(
    name: string,
    params: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AgentToolResult<unknown>> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool ${name} is not registered.`);
    return await tool.execute("hashline-test-call", params, signal, undefined, this.context);
  }
}
