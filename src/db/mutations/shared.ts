import "server-only";
import { adminDb } from "@/db/adminClient";
import { adminAuditLog } from "@/db/schema";
import type { AuthorizedAdmin } from "@/lib/auth/requireAdmin";

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * Phase 5 PR 6: the shared executor type for helpers that must run both
 * outside a transaction (a plain adminDb call) and inside one (composed
 * as part of a larger atomic write, e.g. resolveProposalAsExistingClaim
 * in claimProposalReviews.ts). Derived directly from adminDb.transaction's
 * own callback parameter type -- the same derivation logAdminAction below
 * already uses for its own `tx` parameter -- rather than importing
 * Drizzle's internal transaction types directly or reaching for `any`.
 *
 * DbTransaction is deliberately exported separately (not folded only into
 * DbExecutor) for primitives that must NEVER be callable outside an
 * existing transaction -- see insertClaimSourceLinkTx in claimSources.ts,
 * which exists specifically so a source-link insert participates in its
 * caller's atomic transaction, and which the type system should refuse
 * to let anyone call with a bare adminDb.
 */
export type DbTransaction = Parameters<Parameters<typeof adminDb.transaction>[0]>[0];
export type DbExecutor = typeof adminDb | DbTransaction;

/**
 * Detects a Postgres unique-violation regardless of how this Drizzle
 * version happens to expose it. Confirmed by direct probe: node-postgres
 * itself puts the code at err.code, but this Drizzle version wraps query
 * errors in a DrizzleQueryError with the original pg error at err.cause,
 * so the code shows up at err.cause.code instead. Checking both means
 * this keeps working whichever shape a given error arrives in, without
 * depending on which layer threw it.
 *
 * Every mutation with a uniqueness constraint (claim_relationships,
 * source_relationships, claim_sources, claim_evidence, topics.slug)
 * shares this one helper rather than five near-identical copies. The
 * user-facing error text is never derived from this raw error -- callers
 * catch the boolean and throw their own domain-specific error class
 * instead, so no raw Postgres/driver string ever reaches the browser.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === POSTGRES_UNIQUE_VIOLATION) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    return (cause as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION;
  }
  return false;
}

export type AdminAuditAction = "create" | "update" | "link" | "unlink" | "transition" | "delete";
export type AdminAuditEntityType =
  | "claim"
  | "source"
  | "source_item"
  | "evidence"
  | "topic"
  | "claim_source"
  | "claim_evidence"
  | "claim_topic"
  | "claim_relationship"
  | "source_relationship"
  | "investigation_status_history"
  | "development_outcome_history"
  // Added in migration 0008 (Phase 4 PR 6) -- kept in sync with
  // adminAuditEntityTypeEnum in src/db/schema.ts by hand, since this type
  // is a manual mirror rather than derived from the Drizzle enum.
  | "ingestion_job"
  // Added in migration 0010 (Phase 4 PR 8).
  | "discovery_feed"
  // Added in migration 0016 (Phase 5 PR 5).
  | "claim_proposal_review"
  // Added in migration 0020 (Phase 5 PR 7).
  | "claim_comparison_review";

/**
 * Writes one admin_audit_log row. Metadata must be structured context
 * only (e.g. changed fields) -- NEVER session tokens, cookies, or other
 * auth material. Must be called with the same transaction handle (`tx`)
 * as the mutation it's logging, so the write and the log are atomic.
 */
export async function logAdminAction(
  tx: DbTransaction,
  admin: AuthorizedAdmin,
  entry: {
    action: AdminAuditAction;
    entityType: AdminAuditEntityType;
    entityId?: number;
    summary: string;
    metadata?: Record<string, unknown>;
  }
) {
  await tx.insert(adminAuditLog).values({
    adminUserId: admin.id,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    summary: entry.summary,
    metadata: entry.metadata,
  });
}

/**
 * Thin wrapper naming the pattern every multi-step mutation uses: do the
 * writes and the audit log entry inside one transaction, so a failure
 * partway through never leaves a partially-written record (Section 17).
 */
export async function withAuditedTransaction<T>(
  fn: (tx: DbTransaction) => Promise<T>
): Promise<T> {
  return adminDb.transaction(fn);
}
