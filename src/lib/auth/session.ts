import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Session = {
  authUserId: string;
  email: string | null;
};

/**
 * Resolves the current request's authenticated identity, or null.
 *
 * Real path: verifies the Supabase Auth session from the request cookies
 * via @supabase/ssr. This is what runs in any real deployment.
 *
 * Fake-session path: this sandbox cannot reach supabase.co, so live login
 * can't be exercised here. When LOCAL_FAKE_ADMIN_AUTH_USER_ID is set AND
 * NODE_ENV is not "production", this returns a fixed fake session instead,
 * so the authorization logic downstream of session retrieval (route
 * gating, admin_users lookup, role checks) can still be tested for real.
 * The NODE_ENV guard is a second, independent safeguard against this ever
 * firing in a real deployment even if the env var were left set by
 * mistake.
 */
export async function getSession(): Promise<Session | null> {
  if (process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID && process.env.NODE_ENV !== "production") {
    return { authUserId: process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID, email: null };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;
  return { authUserId: user.id, email: user.email ?? null };
}
