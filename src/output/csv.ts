import { writeFile } from "node:fs/promises";
import type { FlatRow } from "../flatten.js";

function escapeCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export async function writeCsv(path: string, columns: string[], rows: FlatRow[]): Promise<void> {
  const lines: string[] = [];
  lines.push(columns.map(escapeCell).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c])).join(","));
  }
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}
