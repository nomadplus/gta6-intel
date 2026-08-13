import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.ADMIN_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "ADMIN_DATABASE_URL is not set. Admin mutations must connect as admin_role, never as app_role or migrator_role."
  );
}

const globalForDb = globalThis as unknown as { pgAdminPool?: Pool };

const pool =
  globalForDb.pgAdminPool ??
  new Pool({
    connectionString,
    max: 5,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pgAdminPool = pool;
}

export const adminDb = drizzle(pool, { schema });
