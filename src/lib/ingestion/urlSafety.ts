/**
 * SSRF protection primitives.
 *
 * Deliberately separate from urlNormalization.ts (see that file's header):
 * normalization decides identity, this module decides "is it safe to
 * ever let server-side code make an outbound request to this". Neither
 * module knows about the other's concern. A URL can be validly
 * normalized and still be blocked here (e.g. `http://127.0.0.1/`), and a
 * URL can pass every check in this module while still being changed by
 * normalization for storage purposes.
 *
 * Nothing in this file performs an HTTP fetch, follows a redirect, or
 * implements retry/rate-limit logic -- those are later Phase 4 PRs. This
 * module only decides, for one URL/hostname at a time, whether it is an
 * allowed outbound target.
 *
 * ---------------------------------------------------------------------
 * DNS-rebinding limitation (read before wiring this into a fetch path):
 *
 * `resolveAndValidatePublicHost` resolves and validates a hostname's
 * current DNS answer. It does NOT -- and cannot, at this layer --
 * guarantee that the TCP connection a subsequent `fetch()` call opens
 * will land on the same IP address that was just validated. Between
 * validation and connection, an attacker-controlled DNS server could
 * change its answer (a "DNS rebinding" attack), and Node's `fetch`
 * performs its own independent resolution when it actually connects.
 *
 * Closing this gap for real requires connection-level pinning -- e.g. a
 * custom `dns.lookup` override or a low-level HTTP agent/dispatcher that
 * connects directly to the address this module already validated,
 * instead of letting the HTTP client re-resolve. That is a fetch-layer
 * architecture decision that belongs to the PR that actually implements
 * fetching (redirect-following, timeouts, response handling), not this
 * one. This module is the validation primitive that layer will need to
 * call before the initial request and again before every redirect hop;
 * it does not by itself close the rebinding window.
 * ---------------------------------------------------------------------
 */
import * as net from "node:net";
import { resolve4 as dnsResolve4, resolve6 as dnsResolve6 } from "node:dns/promises";

export type UrlSafetyErrorCode =
  | "malformed"
  | "unsupported_scheme"
  | "credentials_present"
  | "blocked_hostname"
  | "blocked_ip"
  | "dns_resolution_failed"
  | "dns_blocked";

export interface UrlSafetyError {
  code: UrlSafetyErrorCode;
  /** Safe, generic message -- never echoes the raw input/hostname back. */
  message: string;
}

/**
 * "ip_literal" means the URL's host was already an IP address, so
 * `validatePublicHttpUrl` has already fully validated it -- no DNS step
 * is needed. "hostname" means it's a name that must still be resolved
 * and validated via `resolveAndValidatePublicHost` before it is safe to
 * connect to (and again before every redirect hop later).
 */
export type HostnameKind = "ip_literal" | "hostname";

export type PublicHttpUrlCheckResult =
  | { ok: true; url: URL; hostnameKind: HostnameKind }
  | { ok: false; error: UrlSafetyError };

export type ResolveHostResult =
  | { ok: true; addresses: string[] }
  | { ok: false; error: UrlSafetyError };

/**
 * Only `resolve4`/`resolve6` are required -- deliberately the minimal
 * shape needed for validation, not the full `node:dns` surface, so tests
 * can supply a trivial mock without depending on real DNS or the network.
 */
export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

const defaultDnsResolver: DnsResolver = {
  resolve4: (hostname) => dnsResolve4(hostname),
  resolve6: (hostname) => dnsResolve6(hostname),
};

// ---------------------------------------------------------------------------
// Hostname-literal blocks (non-IP)
// ---------------------------------------------------------------------------

function isBlockedHostnameLiteral(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
}

// ---------------------------------------------------------------------------
// IPv4 range blocks
// ---------------------------------------------------------------------------

/**
 * [network, prefix length]. Kept as plain dotted strings + prefix
 * lengths (rather than pre-computed integers) so the list itself stays
 * readable and auditable -- this is a security allow/deny list, so
 * legibility here matters more than micro-optimizing parse cost that
 * only happens per-request, not per-row.
 */
const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network" / unspecified
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // CGNAT (RFC6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local -- also covers the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 (documentation)
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking (RFC2544)
  ["198.51.100.0", 24], // TEST-NET-2 (documentation)
  ["203.0.113.0", 24], // TEST-NET-3 (documentation)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved for future use (includes 255.255.255.255)
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function ipv4Mask(prefixLen: number): number {
  return prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
}

function isIPv4IntBlocked(ipInt: number): boolean {
  return IPV4_BLOCKED_RANGES.some(([network, prefixLen]) => {
    const mask = ipv4Mask(prefixLen);
    return (ipInt & mask) >>> 0 === (ipv4ToInt(network) & mask) >>> 0;
  });
}

function isIPv4Blocked(ip: string): boolean {
  return isIPv4IntBlocked(ipv4ToInt(ip));
}

// ---------------------------------------------------------------------------
// IPv6 range blocks
// ---------------------------------------------------------------------------

const IPV6_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["::", 128], // unspecified address
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local (private)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation (RFC3849)
  // Found during the PR 2 SSRF coverage audit, not in the original "at
  // minimum" list: IPv6 transition mechanisms that embed an IPv4
  // address using a DIFFERENT encoding than the ::ffff:a.b.c.d
  // (IPv4-mapped) form this module already unwraps. Without these two
  // entries, a 6to4- or Teredo-encoded address carrying a private or
  // loopback IPv4 target (e.g. "2002:7f00:1::" encodes 127.0.0.1) would
  // match none of the ranges above and be classified as an ordinary
  // public IPv6 address -- a real SSRF bypass, verified during review.
  // Blocked outright rather than unwrapped-and-rechecked (unlike
  // ::ffff:0:0/96 above): unwrapping 6to4 is straightforward but
  // unwrapping Teredo requires reversing an XOR obfuscation, and
  // neither encoding has a legitimate reason to appear as a source
  // publisher's address, so the added complexity of unwrapping either
  // one buys nothing here.
  ["2002::", 16], // 6to4 (RFC3056) -- embeds an IPv4 address in bits 16-47
  ["2001::", 32], // Teredo (RFC4380) -- tunnels an obfuscated IPv4 address
  // NOTE: ::ffff:0:0/96 (the IPv4-mapped prefix) is deliberately NOT
  // listed as a blanket block here -- an IPv4-mapped address embeds a
  // real IPv4 address (e.g. ::ffff:8.8.8.8 embeds the public 8.8.8.8),
  // so the correct policy is "unwrap it and apply the IPv4 rules",
  // which isIPv6Blocked does below, not "block the whole prefix".
];

/**
 * Expands a syntactically valid (caller-verified via `net.isIP`) IPv6
 * address string -- including the "::" compressed form and an embedded
 * dotted-quad tail (e.g. "::ffff:127.0.0.1") -- into its 128-bit integer
 * value. No external dependency: Node has no built-in IPv6 expansion
 * utility, and hand-rolling this is a small, fully deterministic,
 * easily-tested piece of arithmetic, which is why it's implemented here
 * rather than pulling in a package for it (see PR notes on dependency
 * justification).
 */
function ipv6ToBigInt(ip: string): bigint {
  const halves = ip.split("::");
  let head = halves[0] ? halves[0].split(":") : [];
  let tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1) {
    head = ip.split(":");
    tail = [];
  }

  const expandIPv4Tail = (groups: string[]): string[] => {
    const last = groups[groups.length - 1];
    if (last && last.includes(".")) {
      const octets = last.split(".").map(Number);
      const hi = ((octets[0] << 8) | octets[1]).toString(16);
      const lo = ((octets[2] << 8) | octets[3]).toString(16);
      return [...groups.slice(0, -1), hi, lo];
    }
    return groups;
  };

  head = expandIPv4Tail(head);
  tail = expandIPv4Tail(tail);

  const missing = 8 - head.length - tail.length;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...tail];

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(parseInt(group === "" ? "0" : group, 16));
  }
  return value;
}

function ipv6Mask(prefixLen: number): bigint {
  if (prefixLen <= 0) return 0n;
  if (prefixLen >= 128) return (1n << 128n) - 1n;
  const hostBits = BigInt(128 - prefixLen);
  return ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
}

function isIPv6Blocked(ip: string): boolean {
  const value = ipv6ToBigInt(ip);

  // IPv4-mapped IPv6 (::ffff:a.b.c.d): the upper 96 bits are exactly
  // 80 zero bits followed by 0xffff. Checking `value >> 32n === 0xffffn`
  // is sufficient to confirm the upper 80 bits are zero, since a BigInt
  // equality on the full shifted value would fail otherwise.
  if (value >> 32n === 0xffffn) {
    const ipv4Int = Number(value & 0xffffffffn);
    return isIPv4IntBlocked(ipv4Int);
  }

  return IPV6_BLOCKED_RANGES.some(([network, prefixLen]) => {
    const mask = ipv6Mask(prefixLen);
    return (value & mask) === (ipv6ToBigInt(network) & mask);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronous checks only: scheme, embedded credentials, and -- when the
 * host is a literal IP address -- the IP blocklists above. When the host
 * is a name rather than a literal IP, this cannot by itself confirm
 * safety; the caller must also call `resolveAndValidatePublicHost` on
 * `url.hostname` before connecting (see `hostnameKind` in the result).
 */
export function validatePublicHttpUrl(input: string): PublicHttpUrlCheckResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: { code: "malformed", message: "Not a syntactically valid absolute URL." } };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      error: { code: "unsupported_scheme", message: "Only http and https URLs are supported." },
    };
  }

  // Independently re-checked here (also checked in urlNormalization.ts)
  // so this module stays safe to call on its own -- e.g. on a
  // publisher-declared canonicalUrl that was never passed through
  // normalizeUrl.
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      error: { code: "credentials_present", message: "URLs with embedded credentials are not supported." },
    };
  }

  // `url.hostname` for an IPv6 literal is bracketed, e.g. "[::1]".
  const rawHost = url.hostname;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  if (host === "") {
    return { ok: false, error: { code: "malformed", message: "URL has no hostname." } };
  }

  const ipKind = net.isIP(host);
  if (ipKind === 4) {
    if (isIPv4Blocked(host)) {
      return { ok: false, error: { code: "blocked_ip", message: "This address is not a permitted fetch target." } };
    }
    return { ok: true, url, hostnameKind: "ip_literal" };
  }
  if (ipKind === 6) {
    if (isIPv6Blocked(host)) {
      return { ok: false, error: { code: "blocked_ip", message: "This address is not a permitted fetch target." } };
    }
    return { ok: true, url, hostnameKind: "ip_literal" };
  }

  // Not a literal IP -- a genuine hostname.
  if (isBlockedHostnameLiteral(host)) {
    return { ok: false, error: { code: "blocked_hostname", message: "This hostname is not a permitted fetch target." } };
  }

  return { ok: true, url, hostnameKind: "hostname" };
}

async function safeResolve(resolve: () => Promise<string[]>): Promise<string[]> {
  try {
    return await resolve();
  } catch {
    // A rejected lookup (NXDOMAIN, no records of that family, timeout,
    // etc.) is treated the same as "this family returned nothing" here.
    // It's only escalated to the typed `dns_resolution_failed` error
    // once BOTH families produce nothing at all -- see below.
    return [];
  }
}

/**
 * Resolves `hostname` (A and AAAA) and validates every returned address
 * against the IPv4/IPv6 blocklists. Rejects the target if ANY resolved
 * address is non-public -- a hostname that resolves to a mix of public
 * and private addresses is blocked entirely, not partially allowed.
 *
 * `resolver` is injectable so this can be tested deterministically
 * without live DNS or network access -- it defaults to real
 * `node:dns/promises` lookups.
 *
 * Must be called again for every redirect hop once redirect-following
 * is implemented (see the DNS-rebinding note at the top of this file) --
 * this function only validates the hostname passed to it, once.
 */
export async function resolveAndValidatePublicHost(
  hostname: string,
  resolver: DnsResolver = defaultDnsResolver
): Promise<ResolveHostResult> {
  const [v4Addresses, v6Addresses] = await Promise.all([
    safeResolve(() => resolver.resolve4(hostname)),
    safeResolve(() => resolver.resolve6(hostname)),
  ]);
  const addresses = [...v4Addresses, ...v6Addresses];

  if (addresses.length === 0) {
    return {
      ok: false,
      error: { code: "dns_resolution_failed", message: "Unable to resolve this hostname to any address." },
    };
  }

  for (const address of addresses) {
    const kind = net.isIP(address);
    if (kind === 4 && isIPv4Blocked(address)) {
      return {
        ok: false,
        error: { code: "dns_blocked", message: "This hostname resolves to a non-public address." },
      };
    }
    if (kind === 6 && isIPv6Blocked(address)) {
      return {
        ok: false,
        error: { code: "dns_blocked", message: "This hostname resolves to a non-public address." },
      };
    }
  }

  return { ok: true, addresses };
}
