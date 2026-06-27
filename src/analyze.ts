import type { CapturedRequest, RankedRequest } from "./types.js";
import { analyzeBody } from "./detect.js";

/** Domains that almost always carry tracking/analytics, not the data we want. */
const NOISE_DOMAINS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "facebook.com",
  "facebook.net",
  "segment.io",
  "segment.com",
  "sentry.io",
  "amplitude.com",
  "mixpanel.com",
  "hotjar.com",
  "newrelic.com",
  "nr-data.net",
  "scorecardresearch.com",
  "adservice",
  "analytics",
];

/** URL hints that a request is a data API rather than a page asset. */
const API_HINTS = ["/api/", "/v1/", "/v2/", "/graphql", "/rest/", ".json", "/data/", "/feed"];

const ASSET_EXT = /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|mp4|map)(\?|$)/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function rankRequests(requests: CapturedRequest[]): RankedRequest[] {
  const ranked: RankedRequest[] = requests.map((request) => {
    const reasons: string[] = [];
    let score = 0;
    let estimatedRows = 0;
    let rowsPath: string | undefined;

    const url = request.url;
    const host = hostOf(url);
    const contentType = request.response?.contentType ?? "";

    if (NOISE_DOMAINS.some((d) => host.includes(d))) {
      reasons.push("known analytics/tracking host");
      score -= 50;
    }

    if (ASSET_EXT.test(url)) {
      reasons.push("looks like a static asset");
      score -= 30;
    }

    if (/json/.test(contentType)) {
      score += 20;
      reasons.push("JSON response");
    } else if (/xml/.test(contentType)) {
      score += 10;
      reasons.push("XML response");
    }

    if (API_HINTS.some((h) => url.toLowerCase().includes(h))) {
      score += 10;
      reasons.push("URL looks like an API endpoint");
    }

    const body = request.response?.bodyText;
    if (body) {
      const analysis = analyzeBody(body, contentType);
      if (analysis && analysis.rowsPath && analysis.estimatedRows > 0) {
        estimatedRows = analysis.estimatedRows;
        rowsPath = analysis.rowsPath;
        score += Math.min(analysis.estimatedRows, 100); // cap so a huge array doesn't dominate
        if (analysis.recordiness > 0.5) score += 15;
        reasons.push(
          `${analysis.format.toUpperCase()} response contains an array of ${analysis.estimatedRows} ${
            analysis.recordiness > 0.5 ? "records" : "items"
          } at ${analysis.rowsPath}`,
        );
      }
    } else if (request.response && !request.response.bodyText) {
      reasons.push("no response body in HAR (use init --probe to detect the record path)");
    }

    return { request, score, estimatedRows, rowsPath, reasons };
  });

  return ranked.sort((a, b) => b.score - a.score);
}
