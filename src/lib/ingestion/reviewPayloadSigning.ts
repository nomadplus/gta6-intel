/**
 * Signs and verifies the "review payload" that carries pipeline-derived
 * facts (the actual retrieved URL, its content hash, its canonical URL,
 * its excerpt) from a `ready_for_confirmation` pipeline result, across
 * the browser round-trip, back into `finalizeIngestionConfirmation`.
 *
 * WHY THIS EXISTS (PR 5 security condition): `ingestion_jobs` has no
 * columns for this data (a PR 4 design decision -- see
 * db/mutations/ingestion.ts's file-level comment), so it cannot be
 * re-read from the database at confirmation time, and re-fetching the
 * URL a second time would double the pipeline's external-request cost
 * and could silently swap in different content if the page changed
 * between review and confirm. The alternative PR 4 originally accepted
 * -- trusting whatever the browser sends back in hidden form fields --
 * is exactly what this module closes: `url`, `canonicalUrl`, and
 * `rawContentHash` specifically back the duplicate-detection integrity
 * guarantee, not just cosmetic metadata, so they must be provably the
 * same values the pipeline computed, not admin- or attacker-editable.
 *
 * This is deliberately NOT a general-purpose JWT: no header, no
 * algorithm negotiation, no library. A minimal `base64url(payload).
 * base64url(hmac)` compact token is sufficient because both signer and
 * verifier are this same server process, with one fixed algorithm.
 *
 * Bound to a specific `jobId` inside the signed payload, checked against
 * the `jobId` being confirmed -- this is what stops a signed token
 * issued for one job (necessarily a `ready_for_confirmation` job, since
 * only that pipeline branch signs one -- see pipeline.ts/actions.ts)
 * from being replayed against a *different* job, including a plain
 * `needs_review` job that never had a token issued for it at all. That
 * is the actual enforcement of "needs_review stays view-only", not just
 * the UI hiding the confirm form.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const rawSecret = process.env.INGESTION_REVIEW_SIGNING_SECRET;
if (!rawSecret) {
  throw new Error(
    "INGESTION_REVIEW_SIGNING_SECRET is not set. Required to sign and verify ingestion review payloads between fetch and confirmation."
  );
}
/** Re-bound to a plain `string` (not `string | undefined`) so the narrowing above survives into the closures below -- TypeScript does not otherwise carry a module-level `if (!x) throw` narrowing across a function-body boundary. */
const SECRET: string = rawSecret;

/** Signed tokens are only ever consumed shortly after issuance in normal use (review, then confirm, same admin session) -- this is a generous outer bound against an indefinitely-stale token being replayed, not a tight session timeout. The real replay defense is the jobId binding and `finalizeIngestionConfirmation`'s own job-status check. */
const MAX_TOKEN_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface ReviewPayload {
  jobId: number;
  url: string;
  canonicalUrl: string | null;
  excerpt: string | null;
  rawContentHash: string;
}

interface SignedPayloadBody extends ReviewPayload {
  issuedAt: number;
}

export class InvalidReviewTokenError extends Error {
  constructor(reason: string) {
    super(`Ingestion review token is invalid: ${reason}. Resubmit the URL to review it again.`);
    this.name = "InvalidReviewTokenError";
  }
}

export function signReviewPayload(payload: ReviewPayload): string {
  const body: SignedPayloadBody = { ...payload, issuedAt: Date.now() };
  const encodedBody = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(encodedBody).digest("base64url");
  return `${encodedBody}.${signature}`;
}

/**
 * Verifies the signature (constant-time comparison), then checks the
 * decoded payload's `jobId` against `expectedJobId` and its age against
 * `MAX_TOKEN_AGE_MS`. Throws `InvalidReviewTokenError` on any failure --
 * callers should surface this as an ordinary form-validation-style
 * error, not a crash, since an expired or already-confirmed job is an
 * expected admin-facing situation, not a bug.
 */
export function verifyReviewPayload(token: string, expectedJobId: number): ReviewPayload {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidReviewTokenError("malformed token");
  }
  const [encodedBody, signature] = parts;

  const expectedSignature = createHmac("sha256", SECRET).update(encodedBody).digest("base64url");
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    throw new InvalidReviewTokenError("signature does not match");
  }

  let body: SignedPayloadBody;
  try {
    body = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
  } catch {
    throw new InvalidReviewTokenError("payload is not valid JSON");
  }

  if (
    typeof body.jobId !== "number" ||
    typeof body.url !== "string" ||
    typeof body.rawContentHash !== "string" ||
    typeof body.issuedAt !== "number"
  ) {
    throw new InvalidReviewTokenError("payload is missing required fields");
  }
  if (body.jobId !== expectedJobId) {
    throw new InvalidReviewTokenError("token was not issued for this job");
  }
  if (Date.now() - body.issuedAt > MAX_TOKEN_AGE_MS) {
    throw new InvalidReviewTokenError("token has expired");
  }

  return {
    jobId: body.jobId,
    url: body.url,
    canonicalUrl: body.canonicalUrl ?? null,
    excerpt: body.excerpt ?? null,
    rawContentHash: body.rawContentHash,
  };
}
