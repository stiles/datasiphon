import Database from "better-sqlite3";
import { rmSync, existsSync } from "node:fs";
import type { FlatRow } from "../flatten.js";

export type ColumnType = "INTEGER" | "REAL" | "TEXT";

/** Quote an identifier for safe use as a column/table name. */
function ident(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

type ValueClass = "int" | "real" | "bool" | "text" | "empty";

// SQLite INTEGER is 64-bit; beyond this many digits we keep the value as text
// to avoid overflow and to preserve IDs/phone numbers that only look numeric.
const MAX_INT_DIGITS = 15;

function classify(value: unknown): ValueClass {
  if (value === null || value === undefined) return "empty";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "text";
    return Number.isInteger(value) ? "int" : "real";
  }
  const s = String(value).trim();
  if (s === "") return "empty";
  // A leading zero (007, 01234) is almost always a code to preserve, not a number.
  if (/^[+-]?0\d/.test(s)) return "text";
  if (/^[+-]?\d+$/.test(s)) {
    return s.replace(/^[+-]/, "").length > MAX_INT_DIGITS ? "text" : "int";
  }
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) || /^[+-]?\d+[eE][+-]?\d+$/.test(s)) {
    return "real";
  }
  return "text";
}

/** Infer the best SQLite affinity for a single column from its values. */
export function inferColumnType(values: unknown[]): ColumnType {
  let hasInt = false;
  let hasReal = false;
  let hasBool = false;
  let hasValue = false;

  for (const v of values) {
    const c = classify(v);
    if (c === "empty") continue;
    hasValue = true;
    if (c === "text") return "TEXT";
    if (c === "int") hasInt = true;
    else if (c === "real") hasReal = true;
    else if (c === "bool") hasBool = true;
  }

  if (!hasValue) return "TEXT";
  // Mixing booleans with numbers is ambiguous; keep it as text to be safe.
  if (hasBool && (hasInt || hasReal)) return "TEXT";
  if (hasReal) return "REAL";
  if (hasInt) return "INTEGER";
  if (hasBool) return "INTEGER"; // stored as 0/1
  return "TEXT";
}

export function inferColumnTypes(columns: string[], rows: FlatRow[]): Record<string, ColumnType> {
  const types: Record<string, ColumnType> = {};
  for (const col of columns) {
    types[col] = inferColumnType(rows.map((r) => r[col]));
  }
  return types;
}

/** Coerce a cell value to what better-sqlite3 can bind for the column's type. */
function bindValue(value: unknown, type: ColumnType): string | number | null {
  if (value === null || value === undefined) return null;
  if (type === "TEXT") return typeof value === "string" ? value : String(value);

  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

export function writeSqlite(
  path: string,
  table: string,
  columns: string[],
  rows: FlatRow[],
): Record<string, ColumnType> {
  // Rebuild from scratch so re-runs are deterministic.
  if (existsSync(path)) rmSync(path);
  const types = inferColumnTypes(columns, rows);
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    const colDefs = columns.map((c) => `${ident(c)} ${types[c]}`).join(", ");
    db.exec(`CREATE TABLE ${ident(table)} (${colDefs || '"_empty" TEXT'})`);

    if (columns.length && rows.length) {
      const placeholders = columns.map(() => "?").join(", ");
      const insert = db.prepare(
        `INSERT INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES (${placeholders})`,
      );
      const insertMany = db.transaction((batch: FlatRow[]) => {
        for (const row of batch) {
          insert.run(columns.map((c) => bindValue(row[c], types[c])));
        }
      });
      insertMany(rows);
    }
  } finally {
    db.close();
  }
  return types;
}
