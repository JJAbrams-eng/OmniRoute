// drizzle.config.ts
// Dev-only tooling: drizzle-kit is used to `pull` (introspect) the CURRENT
// cumulative schema out of a throwaway, fully-migrated SQLite DB into a
// TypeScript schema.ts (src/lib/db/generated/), so future schema changes
// can optionally be authored/reviewed in TS and diffed into a new plain SQL
// migration file. That generated SQL is then MANUALLY reviewed, wrapped in
// idempotency guards (`CREATE TABLE IF NOT EXISTS` etc.) and copied into
// src/lib/db/migrations/NNN_description.sql — the ONLY authoritative source
// of migrations at runtime is still migrationRunner.ts + _omniroute_migrations.
//
// drizzle-orm is NOT loaded at runtime — no query-builder use anywhere; the
// 117 existing src/lib/db/*.ts domain modules keep using better-sqlite3
// directly. drizzle-orm is only a peer dep drizzle-kit needs for type defs.
//
// The generated directory (src/lib/db/generated/) is gitignored. Rebuild
// before use — the workflow expects fresh output, never a committed baseline.
//
// See src/lib/db/AGENTS.md → "Authoring a new migration (optional drizzle-kit
// aided workflow)" for the end-to-end steps.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./src/lib/db/generated",
  dbCredentials: {
    url: process.env.OMNIROUTE_DRIZZLE_DB_URL ?? "file:./_artifacts/drizzle-dev.sqlite",
  },
});
