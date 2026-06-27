import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type PaginationType = "none" | "offset" | "page" | "cursor" | "link-header" | "next-field";

export interface Recipe {
  /** Free-text note describing what this harvest collects. */
  description?: string;
  source: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  };
  pagination: {
    type: PaginationType;
    /** Query param to advance (offset/page/cursor types). */
    param?: string;
    /** Page size, and the param that sets it. */
    size?: number;
    sizeParam?: string;
    /** First value for offset/page (0 or 1, etc.). */
    start?: number;
    /** For cursor / next-field: where the next token or URL lives in the response. */
    nextField?: string;
    /** For next-field when the field is a full URL rather than a token. */
    nextIsUrl?: boolean;
    /** Safety cap so a runaway harvest can't loop forever. */
    maxPages: number;
  };
  rows: {
    /** Response format. Defaults to json. */
    format?: "json" | "xml" | "html";
    /** JSONPath to the array of records (json/xml). */
    path?: string;
    /** CSS selector for the repeating row element (html). */
    selector?: string;
    /** Optional named columns for html: { column: cssSelectorWithinRow }. */
    fields?: Record<string, string>;
  };
  politeness: {
    delayMs: number;
    maxRetries: number;
  };
  output: {
    formats: Array<"csv" | "sqlite">;
    /** Base filename (without extension) for outputs. */
    basename: string;
  };
}

/** Headers that are noise or risky to persist in a shareable recipe. */
const STRIP_HEADERS = new Set([
  "accept-encoding",
  "accept-language",
  "connection",
  "host",
  "content-length",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "pragma",
  "cache-control",
  "dnt",
  "upgrade-insecure-requests",
]);

const SECRET_HEADERS = ["authorization", "cookie", "x-api-key", "x-auth-token"];

/** Trim a captured header set down to what a recipe should carry. */
export function cleanHeaders(headers: Record<string, string>): {
  kept: Record<string, string>;
  secrets: string[];
} {
  const kept: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (STRIP_HEADERS.has(lower)) continue;
    if (SECRET_HEADERS.includes(lower)) secrets.push(name);
    kept[name] = value;
  }
  return { kept, secrets };
}

export function validateRecipe(recipe: Recipe): string[] {
  const errors: string[] = [];
  if (!recipe.source?.url) errors.push("source.url is required");
  if (!recipe.pagination?.type) errors.push("pagination.type is required");
  if (!recipe.output?.formats?.length) errors.push("output.formats must list at least one format");

  const format = recipe.rows?.format ?? "json";
  if (format === "html") {
    if (!recipe.rows?.selector) errors.push('rows.selector is required when rows.format is "html"');
  } else if (!recipe.rows?.path) {
    errors.push(`rows.path is required when rows.format is "${format}"`);
  }

  const pt = recipe.pagination?.type;
  if ((pt === "offset" || pt === "page" || pt === "cursor") && !recipe.pagination.param) {
    errors.push(`pagination.param is required for type "${pt}"`);
  }
  if ((pt === "cursor" || pt === "next-field") && !recipe.pagination.nextField) {
    errors.push(`pagination.nextField is required for type "${pt}"`);
  }
  return errors;
}

/**
 * Replace the values of sensitive headers with `${ENV_VAR}` placeholders so a
 * recipe can be shared without leaking tokens. Returns the env var names used.
 */
export function redactHeaders(headers: Record<string, string>): {
  headers: Record<string, string>;
  envVars: string[];
} {
  const out: Record<string, string> = {};
  const envVars: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (SECRET_HEADERS.includes(name.toLowerCase())) {
      const envVar = "DATASIPHON_" + name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      out[name] = `\${${envVar}}`;
      envVars.push(envVar);
    } else {
      out[name] = value;
    }
  }
  return { headers: out, envVars };
}

/** Substitute `${ENV_VAR}` placeholders in header values from process.env. */
export function resolveHeaderEnv(headers: Record<string, string>): {
  headers: Record<string, string>;
  missing: string[];
} {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, envVar: string) => {
      const v = process.env[envVar];
      if (v === undefined) {
        missing.push(envVar);
        return "";
      }
      return v;
    });
  }
  return { headers: out, missing };
}

export async function loadRecipe(path: string): Promise<Recipe> {
  const raw = await readFile(path, "utf8");
  const recipe = parseYaml(raw) as Recipe;
  const errors = validateRecipe(recipe);
  if (errors.length) {
    throw new Error(`Invalid recipe:\n  - ${errors.join("\n  - ")}`);
  }
  return recipe;
}

export async function saveRecipe(path: string, recipe: Recipe): Promise<void> {
  const header =
    "# datasiphon recipe: a reproducible record of how this data was collected.\n" +
    "# Edit pagination/rows/headers as needed, then run: datasiphon run <this file>\n\n";
  await writeFile(path, header + stringifyYaml(recipe), "utf8");
}
