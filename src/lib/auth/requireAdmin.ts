import "server-only";
import { eq } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { adminUsers } from "@/db/schema";
import { getSession } from "./session";
import { authorize, type AdminRole, type AdminRecord } from "./authorization";

export type { AdminRole, AdminRecord as AuthorizedAdmin } from "./authorization";
export { UnauthenticatedError, UnauthorizedError } from "./authorization";

/**
 * The single authorization enforcement point for I/O. Called
 * independently in TWO places for every admin capability: once in the
 * /admin route layout (so an unauthenticated visitor sees a login
 * redirect, not a crash), and again inside every individual mutation
 * function (so a known admin URL or a directly-invoked server action can
 * never execute without this check re-running server-side -- the layout
 * check is a UX convenience, not the security boundary).
 *
 * Never trust a client-supplied admin id. Identity is always re-derived
 * from the verified session. The actual pass/fail decision is delegated
 * to authorize() in authorization.ts, which contains no I/O and is
 * independently unit-tested.
 */
export async function requireAdmin(minRole: AdminRole = "read_only_analyst"): Promise<AdminRecord> {
  const session = await getSession();

  let admin: AdminRecord | null = null;
  if (session) {
    const rows = await adminDb
      .select({
        id: adminUsers.id,
        displayName: adminUsers.displayName,
        email: adminUsers.email,
        role: adminUsers.role,
      })
      .from(adminUsers)
      .where(eq(adminUsers.authUserId, session.authUserId))
      .limit(1);
    admin = rows[0] ?? null;
  }

  return authorize(admin, minRole);
}
