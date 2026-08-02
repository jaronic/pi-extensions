import { isIPv4, isIPv6 } from "node:net";

export interface LookupAddress {
  address: string;
  family: number;
}

export type DnsLookup = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 shared address space
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Whether an IP literal is loopback, private, link-local, or otherwise reserved. */
export function isPrivateIp(address: string): boolean {
  if (isIPv4(address)) return isPrivateIpv4(address);
  if (isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && isIPv4(mapped[1])) return isPrivateIpv4(mapped[1]);
    const firstGroup = Number.parseInt(normalized.split(":")[0] || "0", 16);
    if ((firstGroup & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((firstGroup & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

export type UrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Literal (no DNS) SSRF checks for an outbound push URL: https only, no embedded
 * credentials, no local hostnames, no private/reserved IP literals.
 */
export function validatePublicHttpsUrl(raw: string): UrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https:// URLs are allowed" };
  if (url.username || url.password) return { ok: false, reason: "credentials in the URL are not allowed" };
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "missing hostname" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: `refused local hostname "${host}"` };
  }
  const literal = unbracket(host);
  if ((isIPv4(literal) || isIPv6(literal)) && isPrivateIp(literal)) {
    return { ok: false, reason: `refused private/reserved address ${literal}` };
  }
  return { ok: true, url };
}

/**
 * Resolve the hostname and reject the URL when any resolved address is private.
 * Literal IPs are checked directly without a lookup.
 */
export async function assertPublicHostname(url: URL, lookup: DnsLookup): Promise<void> {
  const literal = unbracket(url.hostname.toLowerCase());
  if (isIPv4(literal) || isIPv6(literal)) {
    if (isPrivateIp(literal)) throw new Error(`refused private/reserved address ${literal}`);
    return;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(literal, { all: true });
  } catch (error) {
    throw new Error(`DNS resolution failed for "${literal}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (addresses.length === 0) throw new Error(`DNS resolution returned no addresses for "${literal}"`);
  for (const entry of addresses) {
    if (isPrivateIp(entry.address)) {
      throw new Error(`hostname "${literal}" resolves to private/reserved address ${entry.address}`);
    }
  }
}
