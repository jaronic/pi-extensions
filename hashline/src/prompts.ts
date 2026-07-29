export const READ_DESCRIPTION = "Read a file with exact numbered physical lines and a branch-local SHA-256 snapshot for safe follow-up edits. Images and non-editable files remain read-only.";
export const READ_PROMPT_SNIPPET = "Read files with numbered lines and a branch-local snapshot token for precise edits";
export const READ_PROMPT_GUIDELINES = [
  "Use read before edit to obtain the current snapshot and every target line; for insertion, read both existing sides of the gap.",
  "Copy the snapshot exactly; never guess it or reuse one from another file or branch.",
] as const;

export const EDIT_DESCRIPTION = "Edit previously read lines when the branch-local snapshot is current, or when every targeted line and displayed context can be uniquely rebased by one unchanged offset. All operations are validated together as one guarded file mutation.";
export const EDIT_PROMPT_SNIPPET = "Edit previously read lines with current snapshots or verified unchanged-line rebasing";
export const EDIT_PROMPT_GUIDELINES = [
  "All edit line numbers refer to the submitted snapshot; do not shift later operations after earlier ones.",
  "For replace/delete, end is inclusive and defaults to start; insert_before/insert_after use start as the anchor and omit end.",
  "delete sends only op/start/end and must omit the lines key entirely (never null or an empty array); use replace when the range should become new content.",
  "Put final logical line content in lines without read line-number prefixes or newline characters.",
  "Stale edits rebase only when every target and displayed context line maps uniquely by one offset; multi-operation recovery also requires every line from the first through last target to have been shown. Otherwise use the failed result's refreshed snapshot and current rows to rebuild, reading any explicitly missing span first.",
  "After no-change errors, stop retrying the same payload; the refreshed snapshot shows the current state.",
  "Use write for new files or complete rewrites, and lsp for symbol renames or code actions.",
] as const;
