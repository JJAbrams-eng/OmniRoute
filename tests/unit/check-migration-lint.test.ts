import { test } from "node:test";
import assert from "node:assert";
import { findDestructive } from "../../scripts/check/check-migration-lint.mjs";

type Finding = { line: number; pattern: string; snippet: string };

test("clean CREATE TABLE has no findings", () => {
  const sql = `-- 200_new_table.sql
CREATE TABLE IF NOT EXISTS new_table (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_new_table_name ON new_table(name);
`;
  const findings = findDestructive(sql) as Finding[];
  assert.deepEqual(findings, []);
});

test("flags DROP TABLE", () => {
  const sql = `DROP TABLE old_table;\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "drop-table");
  assert.equal(findings[0].line, 1);
});

test("flags DROP COLUMN", () => {
  const sql = `ALTER TABLE users DROP COLUMN legacy_field;\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "drop-column");
});

test("flags RENAME COLUMN", () => {
  const sql = `ALTER TABLE users RENAME COLUMN old_name TO new_name;\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "rename-column");
});

test("flags DROP INDEX", () => {
  const sql = `DROP INDEX idx_users_email;\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "drop-index");
});

test("ignores destructive keyword inside a pure comment line", () => {
  const sql = `-- previously we would DROP TABLE old_table here\nCREATE TABLE IF NOT EXISTS x (id TEXT);\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.deepEqual(findings, []);
});

test("respects the -- allow-destructive: marker within 5 lines above", () => {
  const sql = `-- allow-destructive: intentional cleanup of dead table (#12345)\nDROP TABLE dead_table;\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.deepEqual(findings, []);
});

test("ignores allow-destructive marker further than 5 lines away", () => {
  const sql = `-- allow-destructive: was meant for something else (#12345)
CREATE TABLE IF NOT EXISTS a (id TEXT);
CREATE TABLE IF NOT EXISTS b (id TEXT);
CREATE TABLE IF NOT EXISTS c (id TEXT);
CREATE TABLE IF NOT EXISTS d (id TEXT);
CREATE TABLE IF NOT EXISTS e (id TEXT);
CREATE TABLE IF NOT EXISTS f (id TEXT);
DROP TABLE far_away;
`;
  const findings = findDestructive(sql) as Finding[];
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "drop-table");
});

test("catches multiple destructive statements in one file", () => {
  const sql = `DROP TABLE t1;\nDROP INDEX i1;\nALTER TABLE t2 DROP COLUMN c1;\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.equal(findings.length, 3);
  const patterns = findings.map((f) => f.pattern).sort();
  assert.deepEqual(patterns, ["drop-column", "drop-index", "drop-table"]);
});

test("does not flag ALTER TABLE ADD COLUMN (safe additive)", () => {
  const sql = `ALTER TABLE users ADD COLUMN new_col TEXT DEFAULT NULL;\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.deepEqual(findings, []);
});

test("is case-insensitive for destructive keywords", () => {
  const sql = `drop table lower_case_test;\n`;
  const findings = findDestructive(sql) as Finding[];
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "drop-table");
});
