import { test } from "node:test";
import assert from "node:assert/strict";
import { probeRequest, type FetchLike } from "../src/probe.js";
import type { CapturedRequest } from "../src/types.js";

function req(url: string): CapturedRequest {
  return { method: "GET", url, headers: { Accept: "application/json" }, queryParams: {} };
}

/** Build a FetchLike from a url -> body map (all JSON, 200). */
function fakeFetch(bodies: Record<string, string>, spy?: string[]): FetchLike {
  return async (url) => {
    spy?.push(url);
    const body = bodies[url];
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return {
      status: 200,
      text: async () => body,
      contentType: "application/json",
      headers: {},
    };
  };
}

test("uses the response directly when it already carries records", async () => {
  const urls: string[] = [];
  const fetcher = fakeFetch(
    { "https://api.test/data.json": JSON.stringify({ results: [{ id: 1 }, { id: 2 }] }) },
    urls,
  );
  const result = await probeRequest(req("https://api.test/data.json"), fetcher);
  assert.equal(result.request.url, "https://api.test/data.json");
  assert.equal(result.rowsPath, "$.results");
  assert.equal(result.followedFrom, undefined);
  assert.deepEqual(urls, ["https://api.test/data.json"]);
});

test("follows a CDC-style config dataUrl to the real data", async () => {
  const urls: string[] = [];
  const config = JSON.stringify({
    type: "chart",
    series: [{ dataKey: "cases" }],
    dataUrl: "/wcms/vizdata/measles/MeaslesCasesWeekly.json",
  });
  const data = JSON.stringify([
    { week_start: "2022-01-02", cases: "0" },
    { week_start: "2022-01-09", cases: "1" },
  ]);
  const fetcher = fakeFetch(
    {
      "https://www.cdc.gov/measles/weekly-cases-chart.json": config,
      "https://www.cdc.gov/wcms/vizdata/measles/MeaslesCasesWeekly.json": data,
    },
    urls,
  );

  const result = await probeRequest(req("https://www.cdc.gov/measles/weekly-cases-chart.json"), fetcher);
  assert.equal(result.request.url, "https://www.cdc.gov/wcms/vizdata/measles/MeaslesCasesWeekly.json");
  assert.equal(result.followedFrom, "https://www.cdc.gov/measles/weekly-cases-chart.json");
  assert.equal(result.rowsPath, "$");
  assert.equal(result.format, "json");
  assert.equal(result.request.response?.bodyText, data);
  assert.ok(result.notes.some((n) => n.includes("following dataUrl")));
  assert.equal(urls.length, 2);
});

test("does not follow dataUrl when the config also has records", async () => {
  // A response with both a dataUrl and its own record array prefers the records.
  const body = JSON.stringify({ dataUrl: "/elsewhere.json", results: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  const urls: string[] = [];
  const result = await probeRequest(
    req("https://api.test/x.json"),
    fakeFetch({ "https://api.test/x.json": body }, urls),
  );
  assert.equal(result.followedFrom, undefined);
  assert.equal(result.rowsPath, "$.results");
  assert.deepEqual(urls, ["https://api.test/x.json"]);
});

test("stops after the follow budget and reports it", async () => {
  // A config that points to itself-ish chain longer than MAX_FOLLOW (3).
  const mk = (n: number) => JSON.stringify({ dataUrl: `/c${n + 1}.json` });
  const bodies: Record<string, string> = {};
  for (let i = 0; i < 6; i++) bodies[`https://api.test/c${i}.json`] = mk(i);
  const urls: string[] = [];
  const result = await probeRequest(
    req("https://api.test/c0.json"),
    fakeFetch(bodies, urls),
  );
  assert.equal(urls.length, 3);
  assert.ok(result.notes.some((n) => n.includes("follow limit")));
});

test("suggests an HTML row selector for an html response", async () => {
  const html = `<html><body><table id="t"><thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table></body></html>`;
  const fetcher: FetchLike = async () => ({
    status: 200,
    text: async () => html,
    contentType: "text/html",
    headers: {},
  });
  const result = await probeRequest(req("https://site.test/page"), fetcher);
  assert.equal(result.format, "html");
  assert.equal(result.selector, "#t tbody tr");
  assert.deepEqual(result.fields, { name: "td:nth-child(1)", value: "td:nth-child(2)" });
  assert.ok(result.notes.some((n) => n.includes("suggested row selector")));
});

test("detects a loop when a dataUrl points back to a fetched URL", async () => {
  const bodies = {
    "https://api.test/a.json": JSON.stringify({ dataUrl: "/b.json" }),
    "https://api.test/b.json": JSON.stringify({ dataUrl: "/a.json" }),
  };
  const urls: string[] = [];
  const result = await probeRequest(req("https://api.test/a.json"), fakeFetch(bodies, urls));
  assert.ok(result.notes.some((n) => n.includes("loop")));
});
