import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ExtensionMode = ExtensionContext["mode"];
import type { ChannelAdapter, ChannelAvailability } from "../src/channels.ts";
import type { NotifyMessage } from "../src/state.ts";
import type { NotifyConfig } from "../src/config.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface RegisteredCommandOptions {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface RecordedNotification {
  message: string;
  type?: string;
}

export class NotifyHarness {
  mode: ExtensionMode = "tui";
  hasUI = true;
  trusted = true;
  cwd = "/test/project";
  idle = true;
  pendingMessages = false;
  execResult: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };
  readonly notifications: RecordedNotification[] = [];
  readonly execCalls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
  readonly toolNames: string[] = [];

  private readonly handlers = new Map<string, Handler[]>();
  private readonly commands = new Map<string, RegisteredCommandOptions>();

  readonly api = {
    on: (event: string, handler: Handler): void => {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    },
    registerCommand: (name: string, options: RegisteredCommandOptions): void => {
      this.commands.set(name, options);
    },
    registerTool: (tool: { name: string }): void => {
      this.toolNames.push(tool.name);
    },
    exec: async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
      this.execCalls.push({ command, args, options });
      return this.execResult;
    },
  } as unknown as ExtensionAPI;

  commandNames(): string[] {
    return [...this.commands.keys()];
  }

  registeredEvents(): string[] {
    return [...this.handlers.keys()];
  }

  private context(): ExtensionContext {
    const harness = this;
    return {
      mode: harness.mode,
      hasUI: harness.hasUI,
      cwd: harness.cwd,
      isProjectTrusted: () => harness.trusted,
      isIdle: () => harness.idle,
      hasPendingMessages: () => harness.pendingMessages,
      ui: {
        notify: (message: string, type?: string) => {
          harness.notifications.push({ message, type });
        },
      },
    } as unknown as ExtensionContext;
  }

  async emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    const ctx = this.context();
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({ type: event, ...payload }, ctx);
    }
  }

  async runCommand(name: string, args: string): Promise<void> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`command "${name}" is not registered`);
    await command.handler(args, this.context() as ExtensionCommandContext);
  }
}

export interface FakeChannelOptions {
  available?: boolean;
  reason?: string;
  error?: string;
  hang?: boolean;
}

export interface FakeChannel extends ChannelAdapter {
  sends: NotifyMessage[];
  signals: AbortSignal[];
}

/** Recording channel adapter for harness and notifier tests. */
export function fakeChannel(id: ChannelAdapter["id"], options: FakeChannelOptions = {}): FakeChannel {
  const sends: NotifyMessage[] = [];
  const signals: AbortSignal[] = [];
  return {
    id,
    sends,
    signals,
    availability(): ChannelAvailability {
      if (options.available === false) return { available: false, reason: options.reason ?? "unavailable" };
      return { available: true };
    },
    async send(message: NotifyMessage, _config: NotifyConfig, signal: AbortSignal) {
      sends.push(message);
      signals.push(signal);
      if (options.hang) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { channel: id, ok: false, error: "aborted" };
      }
      if (options.error) return { channel: id, ok: false, error: options.error };
      return { channel: id, ok: true };
    },
  };
}
