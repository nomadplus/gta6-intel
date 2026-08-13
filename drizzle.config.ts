import type { Config } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. For local development, set it in .env.local to your " +
      "migrator_role connection string -- see scripts/setup-db-roles.sql and README.md " +
      "(\"Local development\") for how that role's password is provisioned."
  );
}

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
} satisfies Config;
