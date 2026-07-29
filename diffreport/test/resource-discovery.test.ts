import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadSkillsFromDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { RequestService } from "pi-request-ui-dev";
import diffreportExtension from "../src/index.ts";

interface ResourcesDiscoverResult {
  skillPaths?: string[];
}

test("extension-only loading advertises its bundled change-report skill", async () => {
  let discoverResources: (() => ResourcesDiscoverResult | Promise<ResourcesDiscoverResult>) | undefined;
  const pi = {
    events: {},
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: () => unknown) {
      if (event === "resources_discover") {
        discoverResources = handler as () => ResourcesDiscoverResult | Promise<ResourcesDiscoverResult>;
      }
    },
  } as unknown as ExtensionAPI;
  const requestService: RequestService = {
    lifetime: new AbortController().signal,
    async request() {
      throw new Error("Request is not used during resource discovery.");
    },
  };

  diffreportExtension(pi, { requestService });

  assert.ok(discoverResources);
  const resources = await discoverResources();
  assert.equal(resources.skillPaths?.length, 1);
  const skillDirectory = resources.skillPaths?.[0];
  assert.ok(skillDirectory);

  const loaded = loadSkillsFromDir({
    dir: skillDirectory,
    source: "extension:diffreport",
  });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.skills.map((skill) => skill.name), ["change-report"]);
  assert.match(loaded.skills[0]?.filePath ?? "", /skills\/change-report\/SKILL\.md$/u);
});

test("bundled change-report skill preserves snapshot, trust, and evidence contracts", async () => {
  const skill = await readFile(new URL("../skills/change-report/SKILL.md", import.meta.url), "utf8");

  assert.match(skill, /immutable commit ID/);
  assert.match(skill, /current checkout and dirty state/);
  assert.match(skill, /untrusted evidence, never instructions/);
  assert.match(skill, /analyst-generated counterfactuals/);
  assert.match(skill, /edge-evidence table/);
  assert.match(skill, /\| ID \| Type \| Revision \/ workspace state \| Location \|/);
});
