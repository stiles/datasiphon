import { parseXml } from "./parse/xml.js";

export type BodyFormat = "json" | "xml" | "html";

interface ArrayFind {
  path: string;
  length: number;
  /** How object-like the array elements are (0..1); favors record arrays. */
  recordiness: number;
}

/** Walk a parsed value and find the largest array of object-like records. */
export function findRecordArray(value: unknown, path = "$", depth = 0): ArrayFind | null {
  if (depth > 8 || value === null || typeof value !== "object") return null;

  let best: ArrayFind | null = null;

  if (Array.isArray(value)) {
    const objects = value.filter((v) => v && typeof v === "object" && !Array.isArray(v));
    const recordiness = value.length ? objects.length / value.length : 0;
    best = { path, length: value.length, recordiness };
    for (let i = 0; i < Math.min(value.length, 3); i++) {
      const child = findRecordArray(value[i], `${path}[${i}]`, depth + 1);
      if (child && betterThan(child, best)) best = child;
    }
    return best;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const found = findRecordArray(child, `${path}.${key}`, depth + 1);
    if (found && (!best || betterThan(found, best))) best = found;
  }
  return best;
}

// Keys that usually hold the actual records, vs keys that hold metadata. This
// keeps us from picking an API's column-definition array (e.g. ArcGIS "fields")
// over the real data ("features").
const DATA_KEYS = /^(features|results|data|records|items|rows|value|elements|entries|edges|nodes)$/i;
const META_KEYS = /^(fields|columns|headers|meta|metadata|links|annotations|palette|backups|exclusions|series|filters|legend)$/i;

function lastKey(path: string): string {
  const m = path.match(/\.([^.[\]]+)$/);
  return m ? m[1] : "";
}

function keyWeight(path: string): number {
  const key = lastKey(path);
  if (DATA_KEYS.test(key)) return 2;
  if (META_KEYS.test(key)) return 0.15;
  return 1;
}

function score(find: ArrayFind): number {
  return find.length * (0.3 + 0.7 * find.recordiness) * keyWeight(find.path);
}

function betterThan(a: ArrayFind, b: ArrayFind): boolean {
  return score(a) > score(b);
}

export interface BodyAnalysis {
  format: BodyFormat;
  rowsPath?: string;
  estimatedRows: number;
  recordiness: number;
}

function looksLikeXml(text: string, contentType: string): boolean {
  if (/xml/.test(contentType)) return true;
  const head = text.trimStart().slice(0, 200);
  return head.startsWith("<?xml") || (/^<[a-zA-Z]/.test(head) && !/^<!doctype html/i.test(head));
}

/** Inspect a response body to classify its format and locate a record array. */
export function analyzeBody(text: string, contentType = ""): BodyAnalysis | null {
  const trimmed = text.trimStart();

  if (/json/.test(contentType) || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const found = findRecordArray(parsed);
      return {
        format: "json",
        rowsPath: found?.path,
        estimatedRows: found?.length ?? 0,
        recordiness: found?.recordiness ?? 0,
      };
    } catch {
      /* fall through */
    }
  }

  if (looksLikeXml(text, contentType)) {
    try {
      const parsed = parseXml(text);
      const found = findRecordArray(parsed);
      return {
        format: "xml",
        rowsPath: found?.path,
        estimatedRows: found?.length ?? 0,
        recordiness: found?.recordiness ?? 0,
      };
    } catch {
      /* fall through */
    }
  }

  if (/html/.test(contentType) || /^<!doctype html/i.test(trimmed) || /<html/i.test(trimmed.slice(0, 200))) {
    return { format: "html", estimatedRows: 0, recordiness: 0 };
  }

  return null;
}
