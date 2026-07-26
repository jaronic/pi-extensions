export const READ_DESCRIPTION = "Read a file with exact numbered physical lines and a branch-local SHA-256 snapshot for safe follow-up edits. Images and non-editable files remain read-only.";
export const READ_PROMPT_SNIPPET = "Read files with numbered lines and a branch-local snapshot token for precise edits";
export const READ_PROMPT_GUIDELINES = [
  "Use read before edit to obtain the current snapshot and every target line; for insertion, read both existing sides of the gap.",
  "Copy the snapshot exactly; never guess it or reuse one from another file or branch.",
] as const;

export const EDIT_DESCRIPTION = "Edit previously read lines only when the branch-local file snapshot is still current. All operations use original-file line numbers and are validated together as one guarded file mutation.";
export const EDIT_PROMPT_SNIPPET = "Edit previously read lines only when the file snapshot is still current";
export const EDIT_PROMPT_GUIDELINES = [
  "All edit line numbers refer to the same original snapshot; do not shift later operations after earlier ones.",
  "For replace/delete, end is inclusive and defaults to start; insert_before/insert_after use start as the anchor and omit end.",
  "Put final logical line content in lines without read line-number prefixes or newline characters.",
  "After stale, unseen-line, or no-change errors, re-read and rebuild the edit instead of widening the range.",
  "Use write for new files or complete rewrites, and lsp for symbol renames or code actions.",
] as const;
