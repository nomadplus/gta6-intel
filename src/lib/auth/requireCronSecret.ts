import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authorization boundary for the automated ingestion processor route
 * (Phase 4 PR 9) -- there is no human session to check here (see
 * requireAdmin.ts for that boundary), so this compares a static shared
 * secret instead. Deliberately its own small module, mirroring
 * requireAdmin.ts's shape, so the route handler's auth check reads the
 * same way admin mutations do: one call, throws on failure.
 *
 * `CRON_SECRET` is the name Vercel's own cron feature auto-populates as
 * an environment variable and sends as a bearer token on every
 * cron-triggered request -- reusing that name (rather than inventing a
 * new one) means Vercel's native cron works with zero extra
 * configuration, while the route remains equally callable by any other
 * bearer-token-aware scheduler pointed at the same secret (Section 15:
 * trigger mechanism stays decoupled from what the route does).
 */
export class MissingCronSecretConfigError extends Error {
  constructor() {
    super("CRON_SECRET is not configured -- the ingestion processor route cannot authenticate any request.");
    this.name = "MissingCronSecretConfigError";
  }
}

export class UnauthorizedCronRequestError extends Error {
  constructor() {
    super("The request's bearer token did not match CRON_SECRET.");
    this.name = "UnauthorizedCronRequestError";
  }
}

/**
 * Constant-time comparison of two strings. Plain `===` short-circuits on
 * the first differing character, which leaks (in principle) how many
 * leading characters of a guess were correct via response timing --
 * immaterial for most equality checks in this codebase, but this one
 * guards the one route that can act on the database with no admin
 * session at all, so it gets the stricter treatment. Both inputs are
 * hashed to a fixed-length digest first specifically so
 * `timingSafeEqual` (which otherwise throws on a length mismatch,
 * itself a timing signal) always compares equal-length buffers
 * regardless of the submitted token's length.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Throws if the request isn't authorized to trigger the processor.
 * Fails closed: a missing/unset CRON_SECRET is treated as "nothing is
 * authorized," never as "skip the check."
 */
export function requireCronSecret(authorizationHeader: string | null): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    throw new MissingCronSecretConfigError();
  }

  const expectedHeader = `Bearer ${expected}`;
  if (!authorizationHeader || !constantTimeEquals(authorizationHeader, expectedHeader)) {
    throw new UnauthorizedCronRequestError();
  }
}
