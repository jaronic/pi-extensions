export class PlanToolLease {
  private readonly ownedTools: Set<string>;
  private baseline: Set<string> | undefined;
  private lastApplied = new Set<string>();
  private readonly externalAdditions = new Set<string>();
  private readonly externalRemovals = new Set<string>();

  constructor(ownedTools: readonly string[]) {
    this.ownedTools = new Set(ownedTools);
  }

  get active(): boolean {
    return this.baseline !== undefined;
  }

  begin(tools: readonly string[]): void {
    const baseline = tools.filter((tool) => !this.ownedTools.has(tool));
    this.baseline = new Set(baseline);
    this.lastApplied = new Set(baseline);
    this.externalAdditions.clear();
    this.externalRemovals.clear();
  }

  /**
   * Re-baselines the lease after an internal tool-set switch (branch restore)
   * without observing the switch: the current host tools are recorded as the
   * lease's own last application, so the next reconcile does not treat the
   * still-applied Plan tool set as external additions or removals.
   */
  rebase(tools: readonly string[], currentTools: readonly string[]): void {
    this.begin(tools);
    this.lastApplied = new Set(currentTools);
  }

  reconcile(currentTools: readonly string[]): string[] {
    this.observe(currentTools);
    return this.effectiveTools();
  }

  isExternallyRemoved(tool: string): boolean {
    return this.externalRemovals.has(tool);
  }

  applied(tools: readonly string[]): void {
    if (!this.baseline) return;
    this.lastApplied = new Set(tools);
  }

  finish(currentTools: readonly string[]): string[] {
    this.observe(currentTools);
    const restored = this.effectiveTools();
    this.clear();
    return restored;
  }

  clear(): void {
    this.baseline = undefined;
    this.lastApplied.clear();
    this.externalAdditions.clear();
    this.externalRemovals.clear();
  }

  private observe(currentTools: readonly string[]): void {
    if (!this.baseline) return;
    const current = new Set(currentTools);
    for (const tool of current) {
      if (this.ownedTools.has(tool) || this.lastApplied.has(tool)) continue;
      this.externalAdditions.add(tool);
      this.externalRemovals.delete(tool);
    }
    for (const tool of this.lastApplied) {
      if (this.ownedTools.has(tool) || current.has(tool)) continue;
      this.externalRemovals.add(tool);
      this.externalAdditions.delete(tool);
    }
  }

  private effectiveTools(): string[] {
    if (!this.baseline) return [];
    const tools = new Set([...this.baseline, ...this.externalAdditions]);
    for (const tool of this.externalRemovals) tools.delete(tool);
    for (const tool of this.ownedTools) tools.delete(tool);
    return [...tools];
  }
}
