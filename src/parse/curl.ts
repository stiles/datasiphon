import { readFile } from "node:fs/promises";
import type { CapturedRequest } from "../types.js";

/**
 * Tokenize a shell-style command, respecting single/double quotes and line
 * continuations. This is intentionally small: it handles what browsers emit
 * for "Copy as cURL", not the full POSIX shell grammar.
 */
function tokenize(input: string): string[] {
  // Join backslash- and caret- (Windows) line continuations.
  const cleaned = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === "\\" && i + 1 < cleaned.length) {
        current += cleaned[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < cleaned.length) {
      current += cleaned[++i];
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function queryFromUrl(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
  } catch {
    /* leave empty */
  }
  return out;
}

export function parseCurlString(input: string): CapturedRequest {
  const tokens = tokenize(input.trim());
  if (tokens.length === 0 || tokens[0] !== "curl") {
    throw new Error('Input does not look like a cURL command (expected it to start with "curl").');
  }

  let method = "";
  let url = "";
  const headers: Record<string, string> = {};
  const bodyParts: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case "-X":
      case "--request":
        method = tokens[++i] ?? method;
        break;
      case "-H":
      case "--header": {
        const h = tokens[++i] ?? "";
        const idx = h.indexOf(":");
        if (idx > 0) {
          const name = h.slice(0, idx).trim();
          const value = h.slice(idx + 1).trim();
          if (!name.startsWith(":")) headers[name] = value;
        }
        break;
      }
      case "-b":
      case "--cookie":
        headers["Cookie"] = tokens[++i] ?? "";
        break;
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
      case "--data-urlencode":
        bodyParts.push(tokens[++i] ?? "");
        break;
      case "--compressed":
      case "-s":
      case "--silent":
      case "-L":
      case "--location":
      case "-k":
      case "--insecure":
      case "-i":
      case "--include":
        break; // flags with no argument we can safely ignore
      default:
        if (!t.startsWith("-") && !url) {
          url = t;
        }
        break;
    }
  }

  if (!url) throw new Error("Could not find a URL in the cURL command.");

  const bodyText = bodyParts.length ? bodyParts.join("&") : undefined;
  if (!method) method = bodyText ? "POST" : "GET";

  return {
    method,
    url,
    headers,
    queryParams: queryFromUrl(url),
    bodyText,
  };
}

export async function parseCurlFile(path: string): Promise<CapturedRequest> {
  const raw = await readFile(path, "utf8");
  return parseCurlString(raw);
}
