/**
 * Pure authorization decision logic. Deliberately has NO imports of
 * "server-only", the database, or session retrieval -- it only decides,
 * given an already-resolved admin record (or null), whether a minimum
 * role requirement is met. This is what makes the decision logic
 * testable via a plain tsx script without touching any privileged,
 * server-only-guarded module.
 *
 * The actual I/O (resolving the session, querying admin_users) lives in
 * requireAdmin.ts, which IS server-only-guarded, and delegates the
 * decision itself to authorize() below.
 */

export type AdminRole = "owner" | "editor" | "reviewer" | "read_only_analyst";

export type AdminRecord = {
  id: number;
  displayName: string;
  email: string;
  role: AdminRole;
};

export const ROLE_RANK: Record<AdminRole, number> = {
  read_only_analyst: 0,
  reviewer: 1,
  editor: 2,
  owner: 3,
};

export class UnauthenticatedError extends Error {
  constructor() {
    super("No authenticated session, or no matching admin_users record.");
    this.name = "UnauthenticatedError";
  }
}

export class UnauthorizedError extends Error {
  constructor(required: AdminRole) {
    super(`Requires at least '${required}' role.`);
    this.name = "UnauthorizedError";
  }
}

export function isRoleSufficient(actual: AdminRole, minRole: AdminRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minRole];
}

/**
 * The actual authorization decision. Takes an already-resolved admin
 * record (null if there was no session, or no admin_users row matched
 * it) and the minimum role required, and either returns the record or
 * throws. No database access, no session lookup -- purely a decision
 * over data the caller already fetched.
 */
export function authorize(admin: AdminRecord | null, minRole: AdminRole): AdminRecord {
  if (!admin) throw new UnauthenticatedError();
  if (!isRoleSufficient(admin.role, minRole)) throw new UnauthorizedError(minRole);
  return admin;
}
