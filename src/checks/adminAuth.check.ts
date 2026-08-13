/**
 * Auth/authorization regression checks, in two clearly separate parts:
 *
 * PART 1 -- pure decision logic (authorize/isRoleSufficient from
 * authorization.ts). Zero I/O, zero "server-only" dependency, so this is
 * a genuine unit test of the actual code the app runs, not a
 * reimplementation of it. This is what actually enforces role checking.
 *
 * PART 2 -- database fixture verification. Confirms the seeded
 * admin_users rows exist with the expected auth_user_id/role mapping,
 * using a plain, standalone drizzle connection created inline in this
 * file -- deliberately NOT importing src/db/adminClient.ts or
 * src/lib/auth/requireAdmin.ts, both of which are "server-only"-guarded
 * in the real app and correctly cannot be imported from a plain tsx
 * script (see Phase 3 notes). This keeps that production separation
 * intact rather than weakening it to make this script easier to run.
 *
 * NEITHER part exercises real Supabase Auth (session cookie verification,
 * OAuth/password login). That requires a real Supabase project and
 * cannot be done from this sandbox -- see the note at the end.
 *
 * Run with: npx tsx src/checks/adminAuth.check.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { adminUsers } from "../db/schema";
import {
  authorize,
  isRoleSufficient,
  UnauthenticatedError,
  UnauthorizedError,
  type AdminRecord,
} from "../lib/auth/authorization";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

function assertThrows(fn: () => unknown, errorType: Function, message: string) {
  try {
    fn();
    console.error(`FAIL: ${message} (did not throw)`);
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof errorType) {
      console.log(`PASS: ${message}`);
    } else {
      console.error(`FAIL: ${message} (threw wrong error type: ${(err as Error).constructor.name})`);
      process.exitCode = 1;
    }
  }
}

function owner(): AdminRecord {
  return { id: 1, displayName: "Test Owner", email: "owner@example.test", role: "owner" };
}
function editor(): AdminRecord {
  return { id: 2, displayName: "Test Editor", email: "editor@example.test", role: "editor" };
}
function analyst(): AdminRecord {
  return { id: 3, displayName: "Test Analyst", email: "analyst@example.test", role: "read_only_analyst" };
}

async function main() {
  console.log("=== PART 1: pure authorization decision logic (unit tests, no I/O) ===\n");

  assertThrows(() => authorize(null, "read_only_analyst"), UnauthenticatedError, "null admin (no session/no match) is rejected");
  assert(authorize(owner(), "owner").role === "owner", "owner passes at 'owner' threshold");
  assert(authorize(owner(), "read_only_analyst").role === "owner", "owner passes at the lowest threshold too");
  assert(authorize(editor(), "editor").role === "editor", "editor passes at its own threshold");
  assertThrows(() => authorize(editor(), "owner"), UnauthorizedError, "editor rejected when 'owner' is required");
  assert(authorize(analyst(), "read_only_analyst").role === "read_only_analyst", "analyst passes at its own threshold");
  assertThrows(() => authorize(analyst(), "reviewer"), UnauthorizedError, "analyst rejected when 'reviewer' is required");
  assertThrows(() => authorize(analyst(), "editor"), UnauthorizedError, "analyst rejected when 'editor' is required");
  assertThrows(() => authorize(analyst(), "owner"), UnauthorizedError, "analyst rejected when 'owner' is required");

  assert(isRoleSufficient("owner", "read_only_analyst"), "isRoleSufficient: owner >= read_only_analyst");
  assert(!isRoleSufficient("read_only_analyst", "owner"), "isRoleSufficient: read_only_analyst < owner");
  assert(isRoleSufficient("editor", "editor"), "isRoleSufficient: equal ranks are sufficient");

  assert(authorize.length === 2, "authorize() takes exactly (admin, minRole) -- no separate identity-override parameter");

  console.log("\n=== PART 2: seeded admin_users fixture content (standalone DB connection) ===\n");

  const pool = new Pool({
    connectionString:
      process.env.CHECK_DATABASE_URL ||
      "postgresql://migrator_role:migrator_dev_password@localhost:5432/gta6_intel",
  });
  const db = drizzle(pool);

  const rows = await db
    .select({ authUserId: adminUsers.authUserId, role: adminUsers.role, email: adminUsers.email })
    .from(adminUsers);

  const bySlug = new Map(rows.map((r) => [r.authUserId, r]));
  assert(
    bySlug.get("test-owner-0000-0000-0000-000000000001")?.role === "owner",
    "seeded fixture: owner auth_user_id maps to role='owner'"
  );
  assert(
    bySlug.get("test-editor-0000-0000-0000-000000000002")?.role === "editor",
    "seeded fixture: editor auth_user_id maps to role='editor'"
  );
  assert(
    bySlug.get("test-analyst-0000-0000-0000-000000000003")?.role === "read_only_analyst",
    "seeded fixture: analyst auth_user_id maps to role='read_only_analyst'"
  );

  await pool.end();

  if (process.exitCode === 1) {
    console.error("\nOne or more auth checks FAILED.");
  } else {
    console.log("\nAll auth/authorization checks passed.");
  }
  console.log(
    "\nNOTE: this verifies (a) the role-decision logic itself, unit-tested directly, and " +
      "(b) that the seed data matches what requireAdmin()'s DB lookup expects to find. " +
      "It does NOT verify requireAdmin()'s own DB query, session retrieval, or real Supabase " +
      "Auth (cookie/JWT verification, OAuth/password login) -- those live in server-only-guarded " +
      "modules by design. Those are instead exercised via the running Next.js server using the " +
      "LOCAL_FAKE_ADMIN_AUTH_USER_ID injected-session path (see the route-exercise checks), which " +
      "is explicitly NOT the same thing as a verified real Supabase Auth login. Live login must " +
      "be verified against a real Supabase project before deployment."
  );
}

main();
