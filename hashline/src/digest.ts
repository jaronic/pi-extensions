import { createHash } from "node:crypto";

export const SNAPSHOT_TOKEN_PATTERN = /^h1_([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
export type SnapshotToken = `h1_${string}`;

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

export function snapshotTokenForBytes(bytes: Uint8Array): SnapshotToken {
  return `h1_${digestBytes(bytes)}`;
}

export function parseSnapshotToken(value: unknown): { token: SnapshotToken; digest: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = SNAPSHOT_TOKEN_PATTERN.exec(value);
  if (!match) return undefined;
  return { token: value as SnapshotToken, digest: match[1] };
}
