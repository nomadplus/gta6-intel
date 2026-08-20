/**
 * Regression check for src/lib/auth/requireCronSecret.ts -- the
 * authorization boundary for the automated ingestion processor route
 * (Phase 4 PR 9, src/app/api/ingestion/process/route.ts).
 *
 * Pure function, no database, no server-only dependency other than the
 * "server-only" import guard itself -- run with --conditions=react-server
 * for the same reason as every other server-only-guarded check in this
 * project (see ingestionAuditLogging.check.ts's header).
 *
 * This exercises requireCronSecret() directly rather than the route
 * handler itself, consistent with this project's check conventions
 * (plain tsx scripts, no HTTP server spun up) -- the route's own logic
 * beyond this call is a thin, already-typechecked wrapper (parse the
 * header, call this function, map its thrown error types to a status
 * code), so this is where the actual security-relevant behavior lives.
 *
 * Run with: npx tsx --conditions=react-server src/checks/requireCronSecret.check.ts
 */
import {
  requireCronSecret,
  MissingCronSecretConfigError,
  UnauthorizedCronRequestError,
} from "../lib/auth/requireCronSecret";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

function assertThrows(fn: () => void, expectedErrorClass: new (...args: never[]) => Error, message: string) {
  try {
    fn();
    console.error(`FAIL: ${message} (did not throw)`);
    failures++;
  } catch (err) {
    if (err instanceof expectedErrorClass) {
      console.log(`PASS: ${message}`);
    } else {
      console.error(`FAIL: ${message} (threw ${(err as Error).constructor.name}, expected ${expectedErrorClass.name})`);
      failures++;
    }
  }
}

const REAL_SECRET = "test-cron-secret-0123456789abcdef";

console.log("=== requireCronSecret (Phase 4 PR 9 route auth) ===\n");

// --- Missing CRON_SECRET env var: fails closed, regardless of header ------
{
  delete process.env.CRON_SECRET;
  assertThrows(
    () => requireCronSecret(`Bearer ${REAL_SECRET}`),
    MissingCronSecretConfigError,
    "an unset CRON_SECRET fails closed even with a plausible-looking header"
  );
  assertThrows(
    () => requireCronSecret(null),
    MissingCronSecretConfigError,
    "an unset CRON_SECRET fails closed with no header at all"
  );
}

// --- CRON_SECRET configured from here on -----------------------------------
process.env.CRON_SECRET = REAL_SECRET;

// --- Missing Authorization header -------------------------------------------
{
  assertThrows(() => requireCronSecret(null), UnauthorizedCronRequestError, "a missing Authorization header is rejected");
  assertThrows(() => requireCronSecret(""), UnauthorizedCronRequestError, "an empty Authorization header is rejected");
}

// --- Wrong bearer token ------------------------------------------------------
{
  assertThrows(
    () => requireCronSecret(`Bearer wrong-secret-entirely`),
    UnauthorizedCronRequestError,
    "an incorrect bearer token is rejected"
  );
  assertThrows(
    () => requireCronSecret(`Bearer ${REAL_SECRET}x`),
    UnauthorizedCronRequestError,
    "a bearer token that is the real secret plus one extra character is rejected"
  );
  assertThrows(
    () => requireCronSecret(`Bearer ${REAL_SECRET.slice(0, -1)}`),
    UnauthorizedCronRequestError,
    "a bearer token that is the real secret minus one character is rejected"
  );
}

// --- Malformed bearer (right secret, wrong shape) ---------------------------
{
  assertThrows(
    () => requireCronSecret(REAL_SECRET),
    UnauthorizedCronRequestError,
    "the raw secret with no 'Bearer ' prefix at all is rejected"
  );
  assertThrows(
    () => requireCronSecret(`bearer ${REAL_SECRET}`),
    UnauthorizedCronRequestError,
    "a lowercase 'bearer' prefix is rejected (case-sensitive scheme, matches the header this route actually sends/expects)"
  );
  assertThrows(
    () => requireCronSecret(`Bearer  ${REAL_SECRET}`),
    UnauthorizedCronRequestError,
    "an extra space between 'Bearer' and the token is rejected"
  );
  assertThrows(
    () => requireCronSecret(`Basic ${REAL_SECRET}`),
    UnauthorizedCronRequestError,
    "a different auth scheme entirely (Basic) is rejected"
  );
}

// --- Correct secret is accepted ---------------------------------------------
{
  let threw = false;
  try {
    requireCronSecret(`Bearer ${REAL_SECRET}`);
  } catch {
    threw = true;
  }
  assert(!threw, "the correct 'Bearer <secret>' header is accepted (does not throw)");
}

if (failures > 0) {
  console.error(`\n${failures} requireCronSecret check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll requireCronSecret checks passed.");
}
