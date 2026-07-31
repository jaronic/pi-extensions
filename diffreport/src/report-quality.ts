// Mechanical contract checks for the generated report. These never block
// delivery: a report with issues is still written to disk, and the issues
// surface as a warning notification so the user can judge its reliability.
export function assessReportQuality(markdown: string): string[] {
  const issues: string[] = [];
  const fenceCount = (markdown.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) {
    issues.push("unbalanced code fences; the file may be truncated");
  }
  if (!/\[E\d+\]/.test(markdown)) {
    issues.push("no inline evidence IDs ([E1]...) found");
  }
  if (!/^#{1,6}[^\n]*(?:evidence index|证据索引)/im.test(markdown)) {
    issues.push("no evidence index section found");
  }
  return issues;
}
