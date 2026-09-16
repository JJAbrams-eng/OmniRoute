#!/usr/bin/env node
// scripts/dev/db-build-ephemeral.mjs
// Build a throwaway, fully-migrated SQLite DB in an isolated DATA_DIR — for
// drizzle-kit `pull` (schema introspection) and any other dev-tool that needs
// a real, current-schema DB file WITHOUT touching the operator's live
// ~/.omniroute/storage.sqlite.
//
// Reuses the exact test-isolation pattern proven in tests/unit/db/*:
//   mkdtempSync → set DATA_DIR → resetDbInstance() → getDbInstance()
// which fires migrationRunner.ts against a fresh file. Writes the resulting
// path to `_artifacts/drizzle-dev.sqlite` (gitignored) and prints it to stdout.
//
// Usage:
//   node scripts/dev/db-build-ephemeral.mjs
//   node scripts/dev/db-build-ephemeral.mjs --keep     # keep DATA_DIR (default)
//   OMNIROUTE_DRIZZLE_DB_URL=file:./_artifacts/drizzle-dev.sqlite npm run db:schema:pull
//
// The chained npm script `db:schema:pull` runs this first, then drizzle-kit.

import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT_DIR = resolve(process.cwd(), "_artifacts");
const OUT_FILE = join(OUT_DIR, "drizzle-dev.sqlite");

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const tmp = mkdtempSync(join(tmpdir(), "omniroute-drizzle-dev-"));
  process.env.DATA_DIR = tmp;

  // Dynamic import AFTER setting DATA_DIR so the module reads the override.
  const core = await import(resolve(process.cwd(), "src/lib/db/core.ts"));
  core.resetDbInstance?.();
  core.getDbInstance(); // triggers migrationRunner to apply all migrations

  const src = join(tmp, "storage.sqlite");
  if (!existsSync(src)) {
    console.error(
      `[db-build-ephemeral] FALHOU: expected ${src} after getDbInstance() but file missing.`
    );
    process.exit(1);
  }

  copyFileSync(src, OUT_FILE);
  core.resetDbInstance?.();

  console.log(`[db-build-ephemeral] OK: ${OUT_FILE}`);
  console.log(OUT_FILE);
}

main().catch((err) => {
  console.error(`[db-build-ephemeral] FALHOU: ${err.message}`);
  process.exit(1);
});
