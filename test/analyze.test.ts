import { test } from "node:test";
import assert from "node:assert/strict";
import { rankRequests } from "../src/analyze.js";
import type { CapturedRequest } from "../src/types.js";

function req(url: string, response?: CapturedRequest["response"]): CapturedRequest {
  return { method: "GET", url, headers: {}, queryParams: {}, response };
}

test("a JSON data endpoint outranks an analytics beacon and a static asset", () => {
  const requests = [
    req("https://www.google-analytics.com/collect?v=1"),
    req("https://site.test/app.js", { status: 200, contentType: "application/javascript" }),
    req("https://api.site.test/v1/records.json", {
      status: 200,
      contentType: "application/json",
      bodyText: JSON.stringify({ results: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    }),
  ];
  const ranked = rankRequests(requests);
  assert.equal(ranked[0].request.url, "https://api.site.test/v1/records.json");
  assert.equal(ranked[0].rowsPath, "$.results");
  assert.equal(ranked[0].estimatedRows, 3);
});

test("analytics hosts get a negative score", () => {
  const ranked = rankRequests([req("https://www.google-analytics.com/collect")]);
  assert.ok(ranked[0].score < 0);
  assert.ok(ranked[0].reasons.some((r) => r.includes("analytics")));
});

test("static assets get a negative score", () => {
  const ranked = rankRequests([
    req("https://site.test/styles.css", { status: 200, contentType: "text/css" }),
  ]);
  assert.ok(ranked[0].reasons.some((r) => r.includes("static asset")));
});

test("bodyless responses note that probing is needed", () => {
  const ranked = rankRequests([
    req("https://api.site.test/v1/data", { status: 200, contentType: "application/json" }),
  ]);
  assert.ok(ranked[0].reasons.some((r) => r.includes("init --probe")));
});

test("results are sorted by descending score", () => {
  const ranked = rankRequests([
    req("https://www.google-analytics.com/collect"),
    req("https://api.site.test/v1/x.json", {
      status: 200,
      contentType: "application/json",
      bodyText: '{"data":[{"a":1}]}',
    }),
  ]);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
});
