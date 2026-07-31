import type { EvidenceSource, EvidenceView } from "./types.ts";

export interface DiffReportCallRecord {
  source: EvidenceSource;
  view: EvidenceView;
  at: number;
}

// Records diff_report tool executions so the command layer can verify the
// exploration actually ran the mandated evidence passes instead of drafting
// the report from the kickoff brief alone.
export class DiffReportCallLedger {
  private readonly records: DiffReportCallRecord[] = [];
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  record(source: EvidenceSource, view: EvidenceView): void {
    this.records.push({ source, view, at: this.clock() });
  }

  since(timestamp: number): readonly DiffReportCallRecord[] {
    return this.records.filter((record) => record.at >= timestamp);
  }
}
