/**
 * Regression check for SSRF protection primitives
 * (src/lib/ingestion/urlSafety.ts).
 *
 * No live DNS or network access is used -- the DNS-layer checks below
 * inject a mock DnsResolver.
 *
 * Run with: npx tsx src/checks/ingestionUrlSafety.check.ts
 */
import { validatePublicHttpUrl, resolveAndValidatePublicHost, type DnsResolver } from "../lib/ingestion/urlSafety";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

function assertAllowed(url: string, label: string) {
  const result = validatePublicHttpUrl(url);
  assert(result.ok, `${label} (${url}) is allowed${result.ok ? "" : ` -- got error: ${result.error.code}`}`);
}

function assertBlocked(url: string, expectedCode: string, label: string) {
  const result = validatePublicHttpUrl(url);
  if (result.ok) {
    assert(false, `${label} (${url}) expected rejection with code "${expectedCode}", got success`);
    return;
  }
  assert(result.error.code === expectedCode, `${label} (${url}) -> rejected with "${result.error.code}" (expected "${expectedCode}")`);
}

// --- Scheme / malformed / credentials --------------------------------------
assertBlocked("ftp://example.com/", "unsupported_scheme", "ftp scheme is rejected");
assertBlocked("not a url", "malformed", "malformed input is rejected");
assertBlocked("https://user:pass@example.com/", "credentials_present", "embedded credentials are rejected");

// --- Hostname-level literal blocks -----------------------------------------
assertBlocked("http://localhost/", "blocked_hostname", "localhost is blocked");
assertBlocked("http://admin.localhost/", "blocked_hostname", "localhost subdomain is blocked");

// --- IPv4 blocked ranges -----------------------------------------------------
assertBlocked("http://127.0.0.1/", "blocked_ip", "127.0.0.1 (loopback) is blocked");
assertBlocked("http://127.5.5.5/", "blocked_ip", "another 127/8 address is blocked");
assertBlocked("http://0.0.0.0/", "blocked_ip", "0.0.0.0 is blocked");
assertBlocked("http://10.1.2.3/", "blocked_ip", "10.x (RFC1918) is blocked");
assertBlocked("http://172.16.0.1/", "blocked_ip", "172.16.x (RFC1918 lower bound) is blocked");
assertBlocked("http://172.31.255.255/", "blocked_ip", "172.31.x (RFC1918 upper bound) is blocked");
assertAllowed("http://172.32.0.1/", "172.32.x is just outside the RFC1918 172.16.0.0/12 range and is allowed (boundary check)");
assertBlocked("http://192.168.1.1/", "blocked_ip", "192.168.x (RFC1918) is blocked");
assertBlocked("http://169.254.169.254/", "blocked_ip", "169.254.169.254 (cloud metadata) is blocked");
assertBlocked("http://100.64.0.1/", "blocked_ip", "100.64.x (CGNAT) is blocked");
assertBlocked("http://192.0.2.1/", "blocked_ip", "192.0.2.x (TEST-NET-1, documentation) is blocked");
assertBlocked("http://198.51.100.1/", "blocked_ip", "198.51.100.x (TEST-NET-2, documentation) is blocked");
assertBlocked("http://203.0.113.1/", "blocked_ip", "203.0.113.x (TEST-NET-3, documentation) is blocked");
assertBlocked("http://224.0.0.1/", "blocked_ip", "224.x (multicast) is blocked");
assertBlocked("http://240.0.0.1/", "blocked_ip", "240.x (reserved) is blocked");

// --- IPv6 blocked ranges -----------------------------------------------------
assertBlocked("http://[::1]/", "blocked_ip", "::1 (loopback) is blocked");
assertBlocked("http://[fc00::1]/", "blocked_ip", "fc00:: (unique local) is blocked");
assertBlocked("http://[fe80::1]/", "blocked_ip", "fe80:: (link-local) is blocked");
assertBlocked("http://[::ffff:127.0.0.1]/", "blocked_ip", "IPv4-mapped loopback (::ffff:127.0.0.1) is blocked via unwrap");
assertBlocked("http://[::ffff:192.168.1.1]/", "blocked_ip", "IPv4-mapped private address is blocked via unwrap");

// --- 6to4 / Teredo transition-mechanism encodings (SSRF audit finding) -----
// These embed an IPv4 address using a different encoding than the
// ::ffff:a.b.c.d (IPv4-mapped) form above, so they need their own
// coverage rather than falling out of the IPv4-mapped unwrap path. See
// the IPV6_BLOCKED_RANGES comment in urlSafety.ts for the full finding.
assertBlocked(
  "http://[2002:7f00:1::]/",
  "blocked_ip",
  "6to4 address encoding 127.0.0.1 (confirmed exploit case from the audit) is blocked"
);
assertBlocked(
  "http://[2002:0a01:0203::]/",
  "blocked_ip",
  "6to4 address encoding a 10.x private target is blocked"
);
assertBlocked(
  "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
  "blocked_ip",
  "a Teredo-prefix address is blocked outright (prefix-level block, not decoded)"
);
assertBlocked(
  "http://[2001::1]/",
  "blocked_ip",
  "the Teredo prefix itself (2001::/32) is blocked at its first address"
);

// --- Valid public addresses ---------------------------------------------------
assertAllowed("http://8.8.8.8/", "a valid public IPv4 address");
assertAllowed("http://[2001:4860:4860::8888]/", "a valid public IPv6 address (also starts with '2001:' but is well outside the narrow 2001:0000::/32 Teredo prefix, confirming the fix isn't over-broad)");
assertAllowed(
  "http://[2606:4700:4700::1111]/",
  "a second, unrelated ordinary public IPv6 address is still allowed"
);
assertAllowed("http://[::ffff:8.8.8.8]/", "an IPv4-mapped public address is allowed via unwrap");
assertAllowed("https://example.com/article", "an ordinary hostname reaches the hostnameKind='hostname' path (no DNS check here)");

// --- hostnameKind classification ---------------------------------------------
{
  const literalResult = validatePublicHttpUrl("http://8.8.8.8/");
  assert(
    literalResult.ok && literalResult.hostnameKind === "ip_literal",
    "an IP-literal URL is classified as hostnameKind='ip_literal' (no further DNS step needed)"
  );
  const hostnameResult = validatePublicHttpUrl("https://example.com/");
  assert(
    hostnameResult.ok && hostnameResult.hostnameKind === "hostname",
    "a named-host URL is classified as hostnameKind='hostname' (DNS validation still required)"
  );
}

// --- DNS layer: injectable resolver, no live network ---------------------------
function mockResolver(overrides: Partial<DnsResolver>): DnsResolver {
  return {
    resolve4: overrides.resolve4 ?? (async () => []),
    resolve6: overrides.resolve6 ?? (async () => []),
  };
}

async function runDnsChecks() {
  {
    const result = await resolveAndValidatePublicHost(
      "public.example",
      mockResolver({ resolve4: async () => ["93.184.216.34"] })
    );
    assert(result.ok, "hostname resolving to a single public address is allowed");
  }

  {
    const result = await resolveAndValidatePublicHost(
      "private.example",
      mockResolver({ resolve4: async () => ["10.0.0.5"] })
    );
    assert(
      !result.ok && result.error.code === "dns_blocked",
      "hostname resolving to a single private address is blocked (dns_blocked)"
    );
  }

  {
    const result = await resolveAndValidatePublicHost(
      "mixed.example",
      mockResolver({ resolve4: async () => ["93.184.216.34", "10.0.0.5"] })
    );
    assert(
      !result.ok && result.error.code === "dns_blocked",
      "hostname resolving to a mix of public and private addresses is blocked entirely"
    );
  }

  {
    const result = await resolveAndValidatePublicHost(
      "unresolvable.example",
      mockResolver({
        resolve4: async () => {
          throw new Error("ENOTFOUND");
        },
        resolve6: async () => {
          throw new Error("ENOTFOUND");
        },
      })
    );
    assert(
      !result.ok && result.error.code === "dns_resolution_failed",
      "DNS resolution failure produces a safe typed failure (dns_resolution_failed)"
    );
  }

  {
    // Both families "succeed" but return zero records -- also a
    // resolution failure, not a silent allow.
    const result = await resolveAndValidatePublicHost("empty.example", mockResolver({}));
    assert(
      !result.ok && result.error.code === "dns_resolution_failed",
      "zero resolved addresses from both families is treated as a resolution failure"
    );
  }
}

runDnsChecks().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} URL safety check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll URL safety checks passed.");
  }
});
