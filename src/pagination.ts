import type { CapturedRequest } from "./types.js";
import type { Recipe } from "./recipe.js";
import { resolvePath } from "./jsonpath.js";

const OFFSET_PARAMS = ["offset", "$offset", "skip", "$skip", "start", "from", "resultoffset"];
const PAGE_PARAMS = ["page", "page_number", "pagenum", "pageno", "p", "$page"];
const SIZE_PARAMS = [
  "per_page",
  "perpage",
  "limit",
  "$limit",
  "page_size",
  "pagesize",
  "size",
  "count",
  "$top",
  "rows",
  "resultrecordcount",
];
const CURSOR_PARAMS = ["cursor", "after", "next_cursor", "page_token", "pagetoken", "continuation"];

/** Common places a "next" token or URL hides in a JSON response. */
const NEXT_FIELD_CANDIDATES = [
  "$.next",
  "$.next_cursor",
  "$.nextCursor",
  "$.next_page",
  "$.nextPage",
  "$.next_page_token",
  "$.nextPageToken",
  "$.paging.next",
  "$.pagination.next",
  "$.meta.next",
  "$.links.next",
  "$.cursor.next",
];

function findKey(params: Record<string, string>, candidates: string[]): string | undefined {
  const lowerMap = new Map(Object.keys(params).map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const hit = lowerMap.get(c);
    if (hit) return hit;
  }
  return undefined;
}

export interface PaginationGuess {
  pagination: Recipe["pagination"];
  note: string;
}

/**
 * Infer a pagination strategy from a single captured request and its response.
 * Returns a best guess plus a human note; the user can correct it in the recipe.
 */
/** Parse an HTTP Link header and return the URL with rel="next", if any. */
export function parseLinkNext(linkHeader: string): string | undefined {
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*(.*)/);
    if (!m) continue;
    if (/rel\s*=\s*"?next"?/i.test(m[2])) return m[1].trim();
  }
  return undefined;
}

export function detectPagination(request: CapturedRequest): PaginationGuess {
  const params = request.queryParams;
  const sizeKey = findKey(params, SIZE_PARAMS);
  const size = sizeKey ? Number(params[sizeKey]) || 100 : 100;

  const linkHeader = request.response?.headers?.["link"];
  if (linkHeader && parseLinkNext(linkHeader)) {
    return {
      pagination: { type: "link-header", size, sizeParam: sizeKey, maxPages: 1000 },
      note: 'Link header with rel="next" found; following it',
    };
  }

  const offsetKey = findKey(params, OFFSET_PARAMS);
  if (offsetKey) {
    return {
      pagination: {
        type: "offset",
        param: offsetKey,
        size,
        sizeParam: sizeKey,
        start: Number(params[offsetKey]) || 0,
        maxPages: 1000,
      },
      note: `offset pagination via "${offsetKey}" (step ${size})`,
    };
  }

  const pageKey = findKey(params, PAGE_PARAMS);
  if (pageKey) {
    return {
      pagination: {
        type: "page",
        param: pageKey,
        size,
        sizeParam: sizeKey,
        start: Number(params[pageKey]) || 1,
        maxPages: 1000,
      },
      note: `page-number pagination via "${pageKey}" (start ${Number(params[pageKey]) || 1})`,
    };
  }

  const cursorKey = findKey(params, CURSOR_PARAMS);
  const nextField = request.response?.bodyText ? findNextField(request.response.bodyText) : undefined;

  if (cursorKey) {
    return {
      pagination: {
        type: "cursor",
        param: cursorKey,
        size,
        sizeParam: sizeKey,
        nextField: nextField?.path,
        nextIsUrl: nextField?.isUrl,
        maxPages: 1000,
      },
      note: nextField
        ? `cursor pagination via "${cursorKey}", next token at ${nextField.path}`
        : `cursor pagination via "${cursorKey}" (set nextField manually: could not find the next token)`,
    };
  }

  if (nextField) {
    return {
      pagination: {
        type: "next-field",
        nextField: nextField.path,
        nextIsUrl: nextField.isUrl,
        size,
        sizeParam: sizeKey,
        maxPages: 1000,
      },
      note: nextField.isUrl
        ? `follow the "next" URL at ${nextField.path}`
        : `follow the next token at ${nextField.path}`,
    };
  }

  return {
    pagination: { type: "none", maxPages: 1 },
    note: "no pagination detected; will fetch a single page (edit the recipe if it actually paginates)",
  };
}

function findNextField(bodyText: string): { path: string; isUrl: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  for (const path of NEXT_FIELD_CANDIDATES) {
    const value = resolvePath(parsed, path);
    if (typeof value === "string" && value.length > 0) {
      return { path, isUrl: /^https?:\/\//.test(value) };
    }
  }
  return undefined;
}
