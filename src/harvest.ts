import { appendFile, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Recipe } from "./recipe.js";
import { resolveHeaderEnv } from "./recipe.js";
import { resolvePath } from "./jsonpath.js";
import { parseXml } from "./parse/xml.js";
import { extractHtmlRows } from "./parse/html.js";
import { parseLinkNext } from "./pagination.js";
import { flattenRecord, unionColumns, unwrapArcgisFeature, type FlatRow } from "./flatten.js";
import { writeCsv } from "./output/csv.js";
import { writeSqlite, inferColumnTypes } from "./output/sqlite.js";
import { writeManifest } from "./output/manifest.js";

interface PageState {
  offset?: number;
  page?: number;
  cursor?: string;
  nextUrl?: string | null;
  pagesFetched: number;
  /** Set once the harvest reaches the natural end, so --resume won't refetch. */
  done?: boolean;
}

export interface HarvestOptions {
  resume?: boolean;
  /** Override the max pages cap from the recipe (useful for a dry run). */
  maxPages?: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rowsFile(base: string) {
  return `${base}.rows.jsonl`;
}
function stateFile(base: string) {
  return `${base}.state.json`;
}

function buildUrl(recipe: Recipe, state: PageState): string {
  const p = recipe.pagination;
  if ((p.type === "next-field" || p.type === "link-header") && state.nextUrl) return state.nextUrl;

  const url = new URL(recipe.source.url);
  if (p.sizeParam && p.size) url.searchParams.set(p.sizeParam, String(p.size));

  if (p.type === "offset" && p.param) {
    url.searchParams.set(p.param, String(state.offset ?? p.start ?? 0));
  } else if (p.type === "page" && p.param) {
    url.searchParams.set(p.param, String(state.page ?? p.start ?? 1));
  } else if (p.type === "cursor" && p.param && state.cursor) {
    url.searchParams.set(p.param, state.cursor);
  }
  return url.toString();
}

async function fetchWithRetry(
  url: string,
  recipe: Recipe,
  headers: Record<string, string>,
  log: (m: string) => void,
): Promise<Response> {
  const { maxRetries, delayMs } = recipe.politeness;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: recipe.source.method,
        headers,
        body: recipe.source.method === "GET" || recipe.source.method === "HEAD" ? undefined : recipe.source.body,
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delayMs * 2 ** attempt;
        log(`  ${res.status} from server, backing off ${wait}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const wait = delayMs * 2 ** attempt;
      log(`  network error, retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(wait);
    }
  }
  throw new Error(`Request failed after ${maxRetries + 1} attempts: ${(lastErr as Error)?.message ?? "unknown"}`);
}

function initialState(recipe: Recipe): PageState {
  const p = recipe.pagination;
  return {
    offset: p.type === "offset" ? p.start ?? 0 : undefined,
    page: p.type === "page" ? p.start ?? 1 : undefined,
    cursor: undefined,
    nextUrl: null,
    pagesFetched: 0,
  };
}

interface PageResult {
  rows: unknown[];
  /** Parsed structure for json/xml (used by cursor/next-field). Null for html. */
  parsed: unknown;
  /** URL from the response Link header's rel="next", if present. */
  linkNext?: string;
}

/** Turn a raw response body into rows plus the bits pagination needs. */
function parseResponse(text: string, recipe: Recipe, linkNext: string | undefined): PageResult {
  const format = recipe.rows.format ?? "json";

  if (format === "html") {
    if (!recipe.rows.selector) throw new Error("rows.selector is required for html");
    const rows = extractHtmlRows(text, { selector: recipe.rows.selector, fields: recipe.rows.fields });
    return { rows, parsed: null, linkNext };
  }

  const parsed = format === "xml" ? parseXml(text) : JSON.parse(text);
  const rowsValue = resolvePath(parsed, recipe.rows.path ?? "$");
  const rows = (Array.isArray(rowsValue) ? rowsValue : []).map(unwrapArcgisFeature);
  return { rows, parsed, linkNext };
}

/** Decide the next page's state, or return null to stop. */
function advance(
  recipe: Recipe,
  state: PageState,
  rowsThisPage: number,
  page: PageResult,
): PageState | null {
  const p = recipe.pagination;
  const next: PageState = { ...state, pagesFetched: state.pagesFetched + 1 };

  if (p.type === "none") return null;
  if (rowsThisPage === 0) return null;

  // ArcGIS and similar APIs return a full page every time and signal the end
  // with exceededTransferLimit:false rather than a short final page.
  if (
    page.parsed &&
    typeof page.parsed === "object" &&
    (page.parsed as Record<string, unknown>).exceededTransferLimit === false
  ) {
    return null;
  }

  switch (p.type) {
    case "offset": {
      if (p.size && rowsThisPage < p.size) return null;
      next.offset = (state.offset ?? p.start ?? 0) + (p.size ?? rowsThisPage);
      return next;
    }
    case "page": {
      if (p.size && rowsThisPage < p.size) return null;
      next.page = (state.page ?? p.start ?? 1) + 1;
      return next;
    }
    case "cursor": {
      const token = p.nextField ? resolvePath(page.parsed, p.nextField) : undefined;
      if (typeof token !== "string" || !token) return null;
      next.cursor = token;
      return next;
    }
    case "next-field": {
      const value = p.nextField ? resolvePath(page.parsed, p.nextField) : undefined;
      if (typeof value !== "string" || !value) return null;
      next.nextUrl = p.nextIsUrl ? value : new URL(value, recipe.source.url).toString();
      return next;
    }
    case "link-header": {
      if (!page.linkNext) return null;
      next.nextUrl = new URL(page.linkNext, recipe.source.url).toString();
      return next;
    }
    default:
      return null;
  }
}

export async function runHarvest(
  recipe: Recipe,
  opts: HarvestOptions = {},
): Promise<{ rows: number; pages: number; outputs: string[] }> {
  const log = opts.log ?? (() => {});
  const base = recipe.output.basename;
  const maxPages = opts.maxPages ?? recipe.pagination.maxPages;
  const warnings: string[] = [];

  let state = initialState(recipe);
  let collected = 0;

  const { headers: resolvedHeaders, missing } = resolveHeaderEnv(recipe.source.headers ?? {});
  if (missing.length) {
    warnings.push(`Missing env vars for headers: ${missing.join(", ")} (set them before running).`);
    log(`Warning: missing env vars ${missing.join(", ")}; those headers will be empty.`);
  }

  let alreadyComplete = false;
  if (opts.resume && existsSync(stateFile(base)) && existsSync(rowsFile(base))) {
    state = JSON.parse(await readFile(stateFile(base), "utf8")) as PageState;
    const existing = (await readFile(rowsFile(base), "utf8")).split("\n").filter(Boolean);
    collected = existing.length;
    if (state.done) {
      alreadyComplete = true;
      log(`Already complete: ${collected} rows. Rebuilding outputs without re-fetching.`);
    } else {
      log(`Resuming: ${collected} rows already saved, continuing from page ${state.pagesFetched + 1}.`);
    }
  } else {
    // Fresh run: clear any prior partial output.
    for (const f of [rowsFile(base), stateFile(base)]) {
      if (existsSync(f)) await rm(f);
    }
  }

  while (!alreadyComplete && state.pagesFetched < maxPages) {
    const url = buildUrl(recipe, state);
    log(`Page ${state.pagesFetched + 1}: ${url}`);
    const res = await fetchWithRetry(url, recipe, resolvedHeaders, log);

    if (!res.ok) {
      warnings.push(`Stopped: server returned ${res.status} for ${url}`);
      log(`  stopping: HTTP ${res.status}`);
      break;
    }

    const text = await res.text();
    const linkNext = res.headers.get("link") ? parseLinkNext(res.headers.get("link") as string) : undefined;

    let page: PageResult;
    try {
      page = parseResponse(text, recipe, linkNext);
    } catch (err) {
      warnings.push(`Could not parse response at ${url}: ${(err as Error).message}; stopping.`);
      log(`  stopping: ${(err as Error).message}`);
      break;
    }

    const flat: FlatRow[] = page.rows.map(flattenRecord);
    if (flat.length) {
      await appendFile(rowsFile(base), flat.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    } else if (state.pagesFetched === 0) {
      const where = recipe.rows.format === "html" ? `selector "${recipe.rows.selector}"` : `rows.path "${recipe.rows.path}"`;
      warnings.push(`No rows found on the first page using ${where}; check the recipe.`);
    }
    collected += flat.length;
    log(`  +${flat.length} rows (total ${collected})`);

    const nextState = advance(recipe, state, flat.length, page);
    if (!nextState) {
      state = { ...state, pagesFetched: state.pagesFetched + 1, done: true };
      await writeFile(stateFile(base), JSON.stringify(state), "utf8");
      break;
    }
    state = nextState;
    await writeFile(stateFile(base), JSON.stringify(state), "utf8");

    if (recipe.politeness.delayMs > 0) await sleep(recipe.politeness.delayMs);
  }

  if (state.pagesFetched >= maxPages) {
    warnings.push(`Hit maxPages cap (${maxPages}); there may be more data.`);
  }

  // Materialize final outputs from the row log.
  const allRows: FlatRow[] = existsSync(rowsFile(base))
    ? (await readFile(rowsFile(base), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FlatRow)
    : [];
  const columns = unionColumns(allRows);
  const columnTypes = inferColumnTypes(columns, allRows);
  const outputs: string[] = [];

  if (recipe.output.formats.includes("csv")) {
    const path = `${base}.csv`;
    await writeCsv(path, columns, allRows);
    outputs.push(path);
  }
  if (recipe.output.formats.includes("sqlite")) {
    const path = `${base}.sqlite`;
    writeSqlite(path, "records", columns, allRows);
    outputs.push(path);
  }

  const manifestPath = `${base}.manifest.json`;
  await writeManifest(manifestPath, recipe, {
    pagesFetched: state.pagesFetched,
    rowsCollected: allRows.length,
    columns,
    columnTypes,
    outputs,
    warnings,
  });
  outputs.push(manifestPath);

  return { rows: allRows.length, pages: state.pagesFetched, outputs };
}
