import Database from "better-sqlite3";
import { rmSync, existsSync } from "node:fs";
import type { FlatRow } from "../flatten.js";

/** Quote an identifier for safe use as a column/table name. */
function ident(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function writeSqlite(
  path: string,
  table: string,
  columns: string[],
  rows: FlatRow[],
): void {
  // Rebuild from scratch so re-runs are deterministic.
  if (existsSync(path)) rmSync(path);
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    const colDefs = columns.map((c) => `${ident(c)} TEXT`).join(", ");
    db.exec(`CREATE TABLE ${ident(table)} (${colDefs || '"_empty" TEXT'})`);

    if (columns.length && rows.length) {
      const placeholders = columns.map(() => "?").join(", ");
      const insert = db.prepare(
        `INSERT INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES (${placeholders})`,
      );
      const insertMany = db.transaction((batch: FlatRow[]) => {
        for (const row of batch) {
          insert.run(
            columns.map((c) => {
              const v = row[c];
              return v === null || v === undefined ? null : String(v);
            }),
          );
        }
      });
      insertMany(rows);
    }
  } finally {
    db.close();
  }
}
