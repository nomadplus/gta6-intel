import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://migrator_role:migrator_dev_password@localhost:5432/gta6_intel",
  },
} satisfies Config;
