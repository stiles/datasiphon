export type FlatRow = Record<string, string | number | boolean | null>;

/**
 * ArcGIS feature records nest their data under `attributes` (alongside an
 * optional `geometry`). Hoist those attributes to the top level so columns are
 * `OBJECTID` instead of `attributes.OBJECTID`. Non-ArcGIS records pass through
 * unchanged.
 */
export function unwrapArcgisFeature(record: unknown): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const obj = record as Record<string, unknown>;
  const attrs = obj.attributes;
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return record;
  const { attributes, ...rest } = obj;
  return { ...rest, ...(attributes as Record<string, unknown>) };
}

/**
 * Flatten a record into a single level of dotted keys.
 * - nested objects become `parent.child`
 * - arrays of scalars are joined with " | "
 * - arrays of objects are stored as compact JSON (rare; keeps the cell honest)
 */
export function flattenRecord(record: unknown): FlatRow {
  const out: FlatRow = {};
  walk(record, "", out);
  return out;
}

function walk(value: unknown, prefix: string, out: FlatRow): void {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = null;
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) {
      out[prefix] = value.map((v) => (v === null ? "" : String(v))).join(" | ");
    } else {
      out[prefix] = JSON.stringify(value);
    }
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix) {
      out[prefix] = "";
      return;
    }
    for (const [key, child] of entries) {
      walk(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out[prefix] = value as string | number | boolean;
}

/** Stable union of all keys across rows, preserving first-seen order. */
export function unionColumns(rows: FlatRow[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols;
}
