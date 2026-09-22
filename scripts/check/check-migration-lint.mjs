#!/usr/bin/env node
// scripts/check/check-migration-lint.mjs
// Gate de segurança para migrations NOVAS: bloqueia padrões destrutivos
// (DROP TABLE / DROP COLUMN / RENAME COLUMN / ALTER-que-restrinja tipo) em
// arquivos ADICIONADOS em src/lib/db/migrations/ desde a base branch do PR.
//
// WHY: OmniRoute usa raw SQL migrations idempotentes (NNN_description.sql) +
// migrationRunner.ts. Nada valida hoje que uma nova migration não drope uma
// coluna em produção (perda de dados irreversível em bancos de operadores).
// Atlas migrate lint faria isso semanticamente, mas: (a) `atlas migrate lint`
// virou Pro-only em v0.38; (b) a community build (brew) faz replay de toda a
// história e quebra em duplicatas legítimas já toleradas pelo runner (ex.:
// 001 e 007 ambos declaram request_type em call_logs). Esta gate é o
// substituto honesto: grep escopado apenas nos arquivos NOVOS do PR, zero
// dependências externas, zero replay da história.
//
// Escopo: apenas ARQUIVOS ADICIONADOS (git diff --diff-filter=A) desde a
// base (PR_BASE_SHA env var → GITHUB_BASE_REF → HEAD~1). Migrations históricas
// nunca são re-linteadas — o que já mergeou está congelado.
//
// Padrões flaggados como destrutivos (ver DESTRUCTIVE_PATTERNS abaixo). Se um
// caso legítimo precisar de exceção, adicione uma linha com `-- allow-destructive:
// <razão + issue>` no próprio arquivo de migration ANTES da statement destrutiva.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const cwd = process.cwd();
const MIGRATIONS_REL = "src/lib/db/migrations/";
const MIGRATIONS_DIR = path.join(cwd, MIGRATIONS_REL);

// Padrões destrutivos. Cada regex é aplicada linha-a-linha, case-insensitive.
// Convenção: cada nome de padrão vira o slug reportado no erro para o dev.
const DESTRUCTIVE_PATTERNS = [
  { name: "drop-table", re: /\bDROP\s+TABLE\b/i },
  { name: "drop-column", re: /\bDROP\s+COLUMN\b/i },
  { name: "rename-column", re: /\bRENAME\s+COLUMN\b/i },
  { name: "rename-table", re: /\bRENAME\s+TO\b/i },
  { name: "drop-index", re: /\bDROP\s+INDEX\b/i },
];

// Marker inline que autoriza destrutivo pontual (com justificativa + issue).
// Deve aparecer em uma linha de comentário ANTES da statement destrutiva.
const ALLOW_MARKER_RE = /--\s*allow-destructive\s*:/i;

function resolveBase() {
  if (process.env.PR_BASE_SHA) return process.env.PR_BASE_SHA;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return "HEAD~1";
}

function addedMigrations(base) {
  try {
    const out = execSync(
      `git diff --name-only --diff-filter=A ${base}...HEAD -- ${MIGRATIONS_REL}`,
      { cwd, encoding: "utf-8" }
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.endsWith(".sql"));
  } catch (err) {
    // Base ausente (ex.: shallow clone, primeira execução em branch novo).
    // Modo degradado: verifica arquivos untracked + modificados como "novos".
    console.warn(
      `[check-migration-lint] warn: base ref '${base}' inacessível (${err.message.split("\n")[0]}). ` +
        `Verificando apenas arquivos com mudanças locais.`
    );
    const status = execSync(`git status --porcelain -- ${MIGRATIONS_REL}`, {
      cwd,
      encoding: "utf-8",
    });
    return status
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /^(A|\?\?)\s/.test(s))
      .map((s) => s.replace(/^[A?]{1,2}\s+/, ""))
      .filter((s) => s.endsWith(".sql"));
  }
}

/**
 * Função pura — encontra padrões destrutivos em conteúdo SQL, respeitando
 * o marker `-- allow-destructive:` na linha imediatamente anterior.
 *
 * @param {string} content  conteúdo do .sql
 * @returns {Array<{line:number, pattern:string, snippet:string}>}
 */
export function findDestructive(content) {
  const lines = content.split("\n");
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("--")) continue; // comentário puro
    for (const { name, re } of DESTRUCTIVE_PATTERNS) {
      if (!re.test(line)) continue;
      // Olha até 5 linhas para trás procurando o marker allow-destructive.
      let allowed = false;
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (ALLOW_MARKER_RE.test(lines[j])) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        findings.push({ line: i + 1, pattern: name, snippet: line.trim() });
      }
    }
  }
  return findings;
}

function main() {
  const base = resolveBase();
  const added = addedMigrations(base);

  if (added.length === 0) {
    console.log("[check-migration-lint] OK: nenhuma migration nova neste diff.");
    return 0;
  }

  const problems = [];
  for (const rel of added) {
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) continue; // arquivo removido depois de add
    const content = fs.readFileSync(abs, "utf-8");
    const findings = findDestructive(content);
    for (const f of findings) {
      problems.push({ file: rel, ...f });
    }
  }

  if (problems.length === 0) {
    console.log(
      `[check-migration-lint] OK: ${added.length} migration(s) nova(s), zero padrões destrutivos.`
    );
    return 0;
  }

  console.error(
    `[check-migration-lint] FALHOU: ${problems.length} padrão(ões) destrutivo(s) em migrations novas.`
  );
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}: ${p.pattern}`);
    console.error(`    → ${p.snippet}`);
  }
  console.error("");
  console.error(
    "Se a mudança destrutiva for intencional (ex.: migração + backfill), " +
      "adicione um comentário `-- allow-destructive: <razão + issue #NNNN>` " +
      "na linha ANTES da statement (dentro de 5 linhas)."
  );
  return 1;
}

// Executa se rodado diretamente (não durante testes).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  process.exit(main());
}
