import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarvest } from "../src/harvest.js";
import type { Recipe } from "../src/recipe.js";

const realFetch = globalThis.fetch;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ds-harvest-"));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

/** Stub global fetch with a function mapping URL -> {body, headers}. */
function stubFetch(handler: (url: string) => { body: string; headers?: Record<string, string>; status?: number }) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const { body, headers = {}, status = 200 } = handler(url);
    return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
}

function recipe(overrides: Partial<Recipe>): Recipe {
  return {
    source: { url: "https://api.test/x", method: "GET" },
    pagination: { type: "none", maxPages: 100 },
    rows: { format: "json", path: "$.results" },
    politeness: { delayMs: 0, maxRetries: 0 },
    output: { formats: ["csv"], basename: join(dir, "out") },
    ...overrides,
  };
}

test("offset pagination collects pages until a short final page", async () => {
  stubFetch((url) => {
    const offset = Number(new URL(url).searchParams.get("$offset") ?? "0");
    // size=2: pages [0,2] full, [4] short (1 row) -> stop
    const all = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const slice = all.slice(offset, offset + 2);
    return { body: JSON.stringify({ results: slice }) };
  });

  const r = recipe({
    source: { url: "https://api.test/x?$offset=0&$limit=2", method: "GET" },
    pagination: { type: "offset", param: "$offset", sizeParam: "$limit", size: 2, start: 0, maxPages: 100 },
  });
  const result = await runHarvest(r);
  assert.equal(result.rows, 5);
  assert.equal(result.pages, 3);
});

test("exceededTransferLimit:false stops pagination (ArcGIS)", async () => {
  let call = 0;
  stubFetch(() => {
    call++;
    const body = JSON.stringify({
      features: [{ attributes: { OBJECTID: call } }, { attributes: { OBJECTID: call * 10 } }],
      exceededTransferLimit: call < 2,
    });
    return { body };
  });

  const r = recipe({
    source: { url: "https://maps.test/query?resultOffset=0&resultRecordCount=2&f=json", method: "GET" },
    pagination: { type: "offset", param: "resultOffset", sizeParam: "resultRecordCount", size: 2, start: 0, maxPages: 100 },
    rows: { format: "json", path: "$.features" },
  });
  const result = await runHarvest(r);
  assert.equal(result.pages, 2);
  assert.equal(result.rows, 4);

  // ArcGIS attributes should be hoisted to top-level columns.
  const csv = await readFile(`${join(dir, "out")}.csv`, "utf8");
  assert.ok(csv.startsWith("OBJECTID\n"));
});

test("link-header pagination follows rel=next then stops", async () => {
  stubFetch((url) => {
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    if (page === 1) {
      return {
        body: JSON.stringify({ results: [{ id: 1 }] }),
        headers: { link: '<https://api.test/x?page=2>; rel="next"' },
      };
    }
    return { body: JSON.stringify({ results: [{ id: 2 }] }) };
  });

  const r = recipe({
    source: { url: "https://api.test/x?page=1", method: "GET" },
    pagination: { type: "link-header", size: 1, maxPages: 100 },
  });
  const result = await runHarvest(r);
  assert.equal(result.pages, 2);
  assert.equal(result.rows, 2);
});

test("cursor pagination follows the next token in the body", async () => {
  stubFetch((url) => {
    const cursor = new URL(url).searchParams.get("cursor");
    if (!cursor) return { body: JSON.stringify({ data: [{ id: 1 }], next_cursor: "c2" }) };
    if (cursor === "c2") return { body: JSON.stringify({ data: [{ id: 2 }], next_cursor: "c3" }) };
    return { body: JSON.stringify({ data: [{ id: 3 }] }) };
  });

  const r = recipe({
    source: { url: "https://api.test/x", method: "GET" },
    pagination: { type: "cursor", param: "cursor", nextField: "$.next_cursor", size: 1, maxPages: 100 },
    rows: { format: "json", path: "$.data" },
  });
  const result = await runHarvest(r);
  assert.equal(result.pages, 3);
  assert.equal(result.rows, 3);
});

test("writes a manifest describing the run", async () => {
  stubFetch(() => ({ body: JSON.stringify({ results: [{ id: 1 }] }) }));
  const r = recipe({ source: { url: "https://api.test/x", method: "GET" }, pagination: { type: "none", maxPages: 1 } });
  await runHarvest(r);
  const manifest = JSON.parse(await readFile(`${join(dir, "out")}.manifest.json`, "utf8"));
  assert.equal(manifest.tool, "datasiphon");
  assert.equal(manifest.rowsCollected, 1);
  assert.equal(manifest.pagination, "none");
  assert.deepEqual(manifest.columns, ["id"]);
});

test("warns when the first page yields no rows", async () => {
  stubFetch(() => ({ body: JSON.stringify({ wrong: [{ id: 1 }] }) }));
  const r = recipe({ pagination: { type: "none", maxPages: 1 }, rows: { format: "json", path: "$.results" } });
  await runHarvest(r);
  const manifest = JSON.parse(await readFile(`${join(dir, "out")}.manifest.json`, "utf8"));
  assert.ok(manifest.warnings.some((w: string) => w.includes("No rows found")));
});

test("maxPages override caps the harvest and warns", async () => {
  stubFetch((url) => {
    const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
    return { body: JSON.stringify({ results: [{ id: offset }, { id: offset + 1 }] }) };
  });
  const r = recipe({
    source: { url: "https://api.test/x?offset=0", method: "GET" },
    pagination: { type: "offset", param: "offset", size: 2, start: 0, maxPages: 100 },
  });
  const result = await runHarvest(r, { maxPages: 2 });
  assert.equal(result.pages, 2);
  const manifest = JSON.parse(await readFile(`${join(dir, "out")}.manifest.json`, "utf8"));
  assert.ok(manifest.warnings.some((w: string) => w.includes("maxPages")));
});

test("retries on 5xx then succeeds", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response("err", { status: 503 });
    return new Response(JSON.stringify({ results: [{ id: 1 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const r = recipe({
    pagination: { type: "none", maxPages: 1 },
    politeness: { delayMs: 0, maxRetries: 2 },
  });
  const result = await runHarvest(r);
  assert.equal(calls, 2);
  assert.equal(result.rows, 1);
});

test("stops and warns on a non-retryable error status", async () => {
  stubFetch(() => ({ body: "nope", status: 404 }));
  const r = recipe({ pagination: { type: "none", maxPages: 1 } });
  const result = await runHarvest(r);
  assert.equal(result.rows, 0);
  const manifest = JSON.parse(await readFile(`${join(dir, "out")}.manifest.json`, "utf8"));
  assert.ok(manifest.warnings.some((w: string) => w.includes("404")));
});
