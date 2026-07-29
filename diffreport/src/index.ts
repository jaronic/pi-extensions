import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRequest, type RequestService } from "pi-request-ui-dev";
import { registerDiffReportCommand } from "./command.ts";
import { DiffReportOutputStore } from "./output.ts";
import { registerDiffReportTool } from "./tool.ts";

const SKILLS_DIRECTORY = fileURLToPath(new URL("../skills", import.meta.url));

export interface DiffreportExtensionDependencies {
  requestService: RequestService;
  outputStore: DiffReportOutputStore;
  now(): Date;
}

export default function diffreportExtension(
  pi: ExtensionAPI,
  dependencies: Partial<DiffreportExtensionDependencies> = {},
): void {
  pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIRECTORY] }));

  const requestService = dependencies.requestService ?? installRequest(pi);
  const outputStore = dependencies.outputStore ?? new DiffReportOutputStore();
  const now = dependencies.now ?? (() => new Date());

  registerDiffReportTool(pi, outputStore);
  registerDiffReportCommand(pi, requestService, now);

  pi.on("session_shutdown", async () => {
    await outputStore.cleanup();
  });
}
