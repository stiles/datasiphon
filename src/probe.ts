import type { CapturedRequest } from "./types.js";
import { analyzeBody, isLikelyRecordArray, type BodyAnalysis, type BodyFormat } from "./detect.js";
import { cleanHeaders } from "./recipe.js";

export interface ProbeResult {
  /** The request whose response we should build the recipe from. */
  request: CapturedRequest;
  rowsPath?: string;
  format?: BodyFormat;
  /** Set when we followed a config's dataUrl: the original (config) URL. */
  followedFrom?: string;
  /** Human-readable notes about what the probe did. */
  notes: string[];
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{
  status: number;
  text: () => Promise<string>;
  contentType: string | null;
  headers: Record<string, string>;
}>;

/** Adapt the global fetch to FetchLike so probeRequest stays easy to test. */
export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return {
    status: res.status,
    text: () => res.text(),
    contentType: res.headers.get("content-type"),
    headers,
  };
};

/** How many config -> dataUrl hops we'll follow before giving up. */
const MAX_FOLLOW = 3;

function withResponse(
  request: CapturedRequest,
  status: number,
  contentType: string | null,
  headers: Record<string, string>,
  bodyText: string,
): CapturedRequest {
  return {
    ...request,
    response: { status, contentType: contentType ?? undefined, headers, bodyText },
  };
}

/**
 * Fetch a request's URL once to learn its response shape and pagination.
 *
 * Some sites (notably CDC's COVE visualizations) serve a config object that
 * names the real data file in a `dataUrl` field rather than the records
 * themselves. When that happens we follow the dataUrl and build the recipe
 * from the file that actually holds the records.
 */
export async function probeRequest(
  request: CapturedRequest,
  doFetch: FetchLike = defaultFetch,
): Promise<ProbeResult> {
  const { kept } = cleanHeaders(request.headers);
  const notes: string[] = [];

  let current = request;
  let followedFrom: string | undefined;
  const visited = new Set<string>();

  // Track the best response we've seen so a weak final hop can't lose to a
  // stronger config we already passed through.
  let best: { request: CapturedRequest; analysis: BodyAnalysis | null } | null = null;

  for (let hop = 0; hop < MAX_FOLLOW; hop++) {
    if (visited.has(current.url)) {
      notes.push(`stopped following dataUrl: ${current.url} was already fetched (loop).`);
      break;
    }
    visited.add(current.url);

    const res = await doFetch(current.url, { method: current.method, headers: kept });
    const text = await res.text();
    current = withResponse(current, res.status, res.contentType, res.headers, text);

    const analysis = analyzeBody(text, res.contentType ?? "");
    if (!best || (analysis?.estimatedRows ?? 0) > (best.analysis?.estimatedRows ?? 0)) {
      best = { request: current, analysis };
    }

    // If this response already holds a real record array, use it. Otherwise,
    // when it names its data elsewhere via dataUrl, follow that.
    if (isLikelyRecordArray(analysis) || !analysis?.dataUrl) break;

    let nextUrl: string;
    try {
      nextUrl = new URL(analysis.dataUrl, current.url).toString();
    } catch {
      notes.push(`found a dataUrl (${analysis.dataUrl}) but could not resolve it; using this response.`);
      break;
    }
    notes.push(`config response points elsewhere; following dataUrl to ${nextUrl}`);
    followedFrom = current.url;
    current = {
      method: "GET",
      url: nextUrl,
      headers: request.headers,
      queryParams: Object.fromEntries(safeSearchParams(nextUrl)),
    };

    if (hop === MAX_FOLLOW - 1) {
      notes.push(`reached the dataUrl follow limit (${MAX_FOLLOW}); using the best response so far.`);
    }
  }

  const chosen = best ?? { request: current, analysis: null };
  // followedFrom only matters if we actually ended up on a followed response.
  const usedFollowed = followedFrom && chosen.request.url !== request.url;
  return {
    request: chosen.request,
    rowsPath: chosen.analysis?.rowsPath,
    format: chosen.analysis?.format,
    followedFrom: usedFollowed ? followedFrom : undefined,
    notes,
  };
}

function safeSearchParams(url: string): Iterable<[string, string]> {
  try {
    return new URL(url).searchParams.entries();
  } catch {
    return [];
  }
}
