import { readFile } from "node:fs/promises";
import type { CapturedRequest } from "../types.js";

interface HarNameValue {
  name: string;
  value: string;
}

interface HarEntry {
  request: {
    method: string;
    url: string;
    headers?: HarNameValue[];
    postData?: { text?: string };
  };
  response?: {
    status: number;
    headers?: HarNameValue[];
    content?: { mimeType?: string; text?: string; encoding?: string };
  };
}

interface HarFile {
  log?: { entries?: HarEntry[] };
}

function headersToRecord(headers: HarNameValue[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    // HAR includes pseudo-headers like ":method"; skip those.
    if (h.name.startsWith(":")) continue;
    out[h.name] = h.value;
  }
  return out;
}

function queryFromUrl(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
  } catch {
    // Relative or malformed URL; leave query empty.
  }
  return out;
}

export async function parseHarFile(path: string): Promise<CapturedRequest[]> {
  const raw = await readFile(path, "utf8");
  let har: HarFile;
  try {
    har = JSON.parse(raw) as HarFile;
  } catch (err) {
    throw new Error(`Could not parse HAR as JSON: ${(err as Error).message}`);
  }

  const entries = har.log?.entries ?? [];
  if (entries.length === 0) {
    throw new Error("HAR contained no request entries (log.entries was empty).");
  }

  return entries.map((entry) => {
    const req = entry.request;
    const content = entry.response?.content;
    const captured: CapturedRequest = {
      method: req.method ?? "GET",
      url: req.url,
      headers: headersToRecord(req.headers),
      queryParams: queryFromUrl(req.url),
      bodyText: req.postData?.text,
    };
    if (entry.response) {
      const respHeaders: Record<string, string> = {};
      for (const h of entry.response.headers ?? []) {
        if (!h.name.startsWith(":")) respHeaders[h.name.toLowerCase()] = h.value;
      }
      captured.response = {
        status: entry.response.status,
        contentType: content?.mimeType,
        headers: respHeaders,
        // Base64 bodies are skipped in v1; we only analyze text responses.
        bodyText: content?.encoding === "base64" ? undefined : content?.text,
      };
    }
    return captured;
  });
}
