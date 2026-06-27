import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPagination, parseLinkNext } from "../src/pagination.js";
import type { CapturedRequest } from "../src/types.js";

function req(url: string, extra: Partial<CapturedRequest> = {}): CapturedRequest {
  let queryParams: Record<string, string> = {};
  try {
    queryParams = Object.fromEntries(new URL(url).searchParams.entries());
  } catch {
    /* ignore */
  }
  return { method: "GET", url, headers: {}, queryParams, ...extra };
}

test("parseLinkNext extracts the rel=next URL", () => {
  const header = '<https://api.test/x?page=1>; rel="prev", <https://api.test/x?page=3>; rel="next"';
  assert.equal(parseLinkNext(header), "https://api.test/x?page=3");
});

test("parseLinkNext handles unquoted rel and returns undefined when absent", () => {
  assert.equal(parseLinkNext("<https://api.test/x>; rel=next"), "https://api.test/x");
  assert.equal(parseLinkNext('<https://api.test/x>; rel="last"'), undefined);
});

test("offset pagination via $offset/$limit", () => {
  const g = detectPagination(req("https://data.test/x.json?$offset=0&$limit=50"));
  assert.equal(g.pagination.type, "offset");
  assert.equal(g.pagination.param, "$offset");
  assert.equal(g.pagination.sizeParam, "$limit");
  assert.equal(g.pagination.size, 50);
  assert.equal(g.pagination.start, 0);
});

test("ArcGIS resultOffset maps to offset", () => {
  const g = detectPagination(req("https://maps.test/query?resultOffset=0&resultRecordCount=3&f=json"));
  assert.equal(g.pagination.type, "offset");
  assert.equal(g.pagination.param, "resultOffset");
  assert.equal(g.pagination.size, 3);
});

test("page-number pagination", () => {
  const g = detectPagination(req("https://api.test/x?page=2&per_page=25"));
  assert.equal(g.pagination.type, "page");
  assert.equal(g.pagination.param, "page");
  assert.equal(g.pagination.size, 25);
  assert.equal(g.pagination.start, 2);
});

test("link-header beats offset when present", () => {
  const g = detectPagination(
    req("https://api.test/x?offset=0", {
      response: { status: 200, headers: { link: '<https://api.test/x?offset=10>; rel="next"' } },
    }),
  );
  assert.equal(g.pagination.type, "link-header");
});

test("cursor pagination with next token in body", () => {
  const body = JSON.stringify({ data: [], next_cursor: "abc123" });
  const g = detectPagination(
    req("https://api.test/x?cursor=", { response: { status: 200, bodyText: body } }),
  );
  assert.equal(g.pagination.type, "cursor");
  assert.equal(g.pagination.param, "cursor");
  assert.equal(g.pagination.nextField, "$.next_cursor");
});

test("next-field pagination when only a next URL is present", () => {
  const body = JSON.stringify({ results: [], next: "https://api.test/x?page=2" });
  const g = detectPagination(
    req("https://api.test/x", { response: { status: 200, bodyText: body } }),
  );
  assert.equal(g.pagination.type, "next-field");
  assert.equal(g.pagination.nextField, "$.next");
  assert.equal(g.pagination.nextIsUrl, true);
});

test("no pagination falls back to none", () => {
  const g = detectPagination(req("https://api.test/x"));
  assert.equal(g.pagination.type, "none");
  assert.equal(g.pagination.maxPages, 1);
});

test("default size is 100 when no size param present", () => {
  const g = detectPagination(req("https://api.test/x?offset=0"));
  assert.equal(g.pagination.size, 100);
});
