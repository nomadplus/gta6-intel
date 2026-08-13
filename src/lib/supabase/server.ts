import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Creates a Supabase server client bound to the current request's cookies.
 * This is the real, production-correct integration -- it just has nothing
 * reachable to talk to inside this sandbox (no egress to supabase.co).
 * Replace NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY with a
 * real project's values to use it for an actual login.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component with no request context to
            // write to -- safe to ignore as long as middleware also
            // refreshes the session (standard @supabase/ssr guidance).
          }
        },
      },
    }
  );
}
