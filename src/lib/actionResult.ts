import { ZodError } from "zod";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Maps a subset of common Postgres SQLSTATE codes to safe, generic
 * admin-facing messages. Anything not listed falls through to a single
 * generic message -- the goal isn't a perfect message per constraint, just
 * never surfacing raw driver detail (constraint/table/column names,
 * connection info, or -- critically -- raw SQL query text, see below) to
 * the admin UI. Full detail always still goes to the server log in
 * safeAction below.
 */
const PG_ERROR_MESSAGES: Record<string, string> = {
  "23505": "This record conflicts with an existing one (a value that must be unique is already in use).",
  "23503": "This action references something that doesn't exist, or would break a link to existing data.",
  "23502": "A required field was missing.",
  "23514": "This value doesn't satisfy a required constraint.",
  "42501": "You don't have permission to perform this action.",
};

/** A Postgres error code, wherever it actually lives (see findPgError below). */
function isRawDatabaseErrorCode(code: unknown): code is string {
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && code !== "P0001";
}

/**
 * Drizzle wraps every query failure in its own `DrizzleQueryError`. That
 * wrapper's own `.message` is the raw SQL query text plus parameter values
 * (confirmed by direct testing -- this is worse than a leaked constraint
 * name, since it can include submitted field content verbatim), and its
 * `.code` is undefined. The real Postgres error -- with the actual
 * SQLSTATE `.code`, `.message`, `.detail`, `.table`, `.constraint` -- is
 * one level down on `.cause`. A plain, non-Drizzle Error (our own
 * hand-thrown business messages, or a P0001 RAISE EXCEPTION from our own
 * PL/pgSQL trigger functions) has no such wrapping and is returned as-is.
 */
function findPgError(err: Error): { code?: unknown; message: string; detail?: unknown; table?: unknown; constraint?: unknown } {
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    return cause as { code?: unknown; message: string; detail?: unknown; table?: unknown; constraint?: unknown };
  }
  return err;
}

export async function safeAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, error: err.issues.map((e) => e.message).join("; ") };
    }
    if (err instanceof Error) {
      const pgError = findPgError(err);
      if (isRawDatabaseErrorCode(pgError.code)) {
        // Raw database error (possibly Drizzle-wrapped): log full detail
        // server-side, never surface it -- see findPgError's comment on
        // why err.message alone is unsafe to return here.
        console.error("[admin mutation] database error", {
          code: pgError.code,
          message: pgError.message,
          detail: pgError.detail,
          table: pgError.table,
          constraint: pgError.constraint,
        });
        const code = pgError.code as string;
        return { ok: false, error: PG_ERROR_MESSAGES[code] ?? "Something went wrong while saving. This has been logged for review." };
      }
      // Our own thrown Error (business-rule messages like "Claim #5 not
      // found") or a P0001 RAISE EXCEPTION from our own trigger functions
      // -- both deliberately authored and safe to show as-is. Use
      // pgError.message, not err.message: for a plain hand-thrown Error
      // they're the same thing, but for a P0001 trigger exception (which
      // Drizzle still wraps) err.message would be the raw SQL query text
      // again -- pgError.message is the trigger's actual RAISE EXCEPTION
      // text.
      return { ok: false, error: pgError.message };
    }
    return { ok: false, error: "Unknown error" };
  }
}

/** Converts FormData into a plain object; listed fields are collected as arrays (e.g. multi-select). */
export function formDataToObject(formData: FormData, arrayFields: string[] = []): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    if (arrayFields.includes(key)) {
      obj[key] = formData.getAll(key).filter((v) => v !== "");
    } else {
      const v = formData.get(key);
      obj[key] = v === "" ? undefined : v;
    }
  }
  return obj;
}
