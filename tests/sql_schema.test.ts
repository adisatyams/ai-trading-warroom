// Regression guard: every SQL statement in src/ must compile against the schema
// produced by migrations/*.sql. This catches column/table drift between the
// TypeScript code and the migrations (the class of bug fixed in the schema
// reconciliation). Uses node:sqlite (Node 22.5+); skipped where unavailable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

let DatabaseSync: any = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // node:sqlite not available on this Node version
}

function extractSql(source: string): string[] {
  const out: string[] = [];
  const re = /\.prepare\(\s*(`[\s\S]*?`|"[^"]*")\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let sql = m[1].slice(1, -1);
    sql = sql.replace(/\$\{[^}]*\}/g, ""); // drop template interpolations
    out.push(sql.trim());
  }
  return out;
}

test(
  "all SQL in src/*.ts compiles against migrations",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  () => {
    const db = new DatabaseSync(":memory:");
    const migrations = readdirSync(join(root, "migrations"))
      .filter(f => f.endsWith(".sql"))
      .sort();
    assert.ok(migrations.length >= 1);
    for (const f of migrations) {
      db.exec(readFileSync(join(root, "migrations", f), "utf8"));
    }

    const files = readdirSync(join(root, "src")).filter(f => f.endsWith(".ts"));
    let checked = 0;
    const failures: string[] = [];

    for (const f of files) {
      const statements = extractSql(readFileSync(join(root, "src", f), "utf8"));
      for (const sql of statements) {
        checked++;
        try {
          db.prepare(sql);
        } catch (e) {
          failures.push(
            `${f}: ${(e as Error).message}\n    ${sql.replace(/\s+/g, " ").slice(0, 140)}`
          );
        }
      }
    }

    assert.ok(checked >= 10, `expected to find SQL statements, found ${checked}`);
    assert.deepEqual(failures, [], "SQL not matching schema:\n" + failures.join("\n"));
  }
);
