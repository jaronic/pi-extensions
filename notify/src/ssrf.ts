import { isIPv4, isIPv6 } from "node:net";

export interface LookupAddress {
  address: string;
  family: number;
}

export type DnsLookup = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

export interface LookupOptions {
  /** Abort the in-flight lookup when the signal aborts. */
  signal?: AbortSignal;
  /** Bound the lookup duration; throws when exceeded. */
  timeoutMs?: number;
}

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

/** Expand an IPv6 literal into its 8 16-bit groups; null when malformed. */
function ipv6Groups(address: string): number[] | null {
  const parts = address.toLowerCase().split("::");
  if (parts.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":").flatMap((chunk) => {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(chunk)) {
        // trailing dotted-quad: ::ffff:127.0.0.1 carries the last two groups as an IPv4
        const [a, b, c, d] = chunk.split(".").map((octet) => Number.parseInt(octet, 10));
        if (a > 255 || b > 255 || c > 255 || d > 255) return [NaN];
        return [(a << 8) | b, (c << 8) | d];
      }
      return /^[0-9a-f]{1,4}$/.test(chunk) ? [Number.parseInt(chunk, 16)] : [NaN];
    });
    return groups.some(Number.isNaN) ? null : groups;
  };
  if (parts.length === 1) {
    const groups = parse(parts[0]);
    return groups !== null && groups.length === 8 ? groups : null;
  }
  const head = parse(parts[0]);
  const tail = parse(parts[1]);
  if (head === null || tail === null || head.length + tail.length > 7) return null;
  return [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
}

/** The embedded IPv4 of a ::ffff:0:0/96 address (dotted or hexadecimal form), or null. */
function ipv4Mapped(groups: number[]): string | null {
  if (groups[0] !== 0 || groups[1] !== 0 || groups[2] !== 0 || groups[3] !== 0 || groups[4] !== 0 || groups[5] !== 0xffff) {
    return null;
  }
  return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
}

/** Whether an IP literal is loopback, private, link-local, or otherwise reserved. */
export function isPrivateIp(address: string): boolean {
  if (isIPv4(address)) return isPrivateIpv4(address);
  if (isIPv6(address)) {
    const groups = ipv6Groups(address);
    if (groups === null) return false;
    if (groups.every((group) => group === 0)) return true; // :: unspecified
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1 loopback
    const mapped = ipv4Mapped(groups);
    if (mapped !== null) return isPrivateIpv4(mapped); // ::ffff:a.b in dotted or hexadecimal form
    if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
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

/** Race a lookup against an optional timeout and abort signal so a hanging resolver cannot stall a dispatch. */
function lookupWithDeadline(lookup: DnsLookup, hostname: string, options: LookupOptions): Promise<LookupAddress[]> {
  const { signal, timeoutMs } = options;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    if (signal) {
      if (signal.aborted) {
        reject(new Error("DNS resolution aborted"));
        return;
      }
      onAbort = () => reject(new Error("DNS resolution aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => reject(new Error(`DNS resolution timed out after ${timeoutMs}ms`)), timeoutMs);
    }
  });
  return Promise.race([lookup(hostname, { all: true }), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Resolve the hostname and reject the URL when any resolved address is private.
 * Literal IPs are checked directly without a lookup.
 */
export async function assertPublicHostname(
  url: URL,
  lookup: DnsLookup,
  options: LookupOptions = {},
): Promise<void> {
  const literal = unbracket(url.hostname.toLowerCase());
  if (isIPv4(literal) || isIPv6(literal)) {
    if (isPrivateIp(literal)) throw new Error(`refused private/reserved address ${literal}`);
    return;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookupWithDeadline(lookup, literal, options);
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
