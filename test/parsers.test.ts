import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseXml } from "../src/parse/xml.js";
import { extractHtmlRows, suggestHtmlRows } from "../src/parse/html.js";
import { parseHarFile } from "../src/parse/har.js";
import { resolvePath } from "../src/jsonpath.js";

test("parseXml produces a resolvePath-friendly object", () => {
  const parsed = parseXml(
    "<response><record><id>1</id></record><record><id>2</id></record></response>",
  );
  const records = resolvePath(parsed, "$.response.record");
  assert.ok(Array.isArray(records));
  assert.equal((records as unknown[]).length, 2);
});

test("parseXml exposes attributes with @_ prefix", () => {
  const parsed = parseXml('<root><item id="7">x</item></root>') as Record<string, unknown>;
  const item = (parsed.root as Record<string, unknown>).item as Record<string, unknown>;
  assert.equal(item["@_id"], "7");
});

test("extractHtmlRows uses named field selectors", () => {
  const html = `
    <table><tbody>
      <tr class="row"><td class="name">Alice</td><td class="age">30</td></tr>
      <tr class="row"><td class="name">Bob</td><td class="age">25</td></tr>
    </tbody></table>`;
  const rows = extractHtmlRows(html, {
    selector: "tr.row",
    fields: { name: ".name", age: ".age" },
  });
  assert.deepEqual(rows, [
    { name: "Alice", age: "30" },
    { name: "Bob", age: "25" },
  ]);
});

test("extractHtmlRows falls back to numbered cells", () => {
  const html = "<table><tr><td>a</td><td>b</td></tr></table>";
  const rows = extractHtmlRows(html, { selector: "tr" });
  assert.deepEqual(rows, [{ c1: "a", c2: "b" }]);
});

test("extractHtmlRows captures text for cell-less rows", () => {
  const html = '<ul><li class="row">hello</li></ul>';
  const rows = extractHtmlRows(html, { selector: "li.row" });
  assert.deepEqual(rows, [{ text: "hello" }]);
});

test("suggestHtmlRows targets a tbody table by id and maps header fields", () => {
  const html = `<table id="results">
    <thead><tr><th>State Name</th><th>Cases (2024)</th></tr></thead>
    <tbody>
      <tr><td>CA</td><td>10</td></tr>
      <tr><td>TX</td><td>5</td></tr>
    </tbody></table>`;
  const s = suggestHtmlRows(html);
  assert.equal(s?.selector, "#results tbody tr");
  assert.equal(s?.rowCount, 2);
  assert.deepEqual(s?.fields, {
    state_name: "td:nth-child(1)",
    cases_2024: "td:nth-child(2)",
  });
  // The suggested spec should actually extract the data rows.
  const rows = extractHtmlRows(html, { selector: s!.selector, fields: s!.fields });
  assert.deepEqual(rows, [
    { state_name: "CA", cases_2024: "10" },
    { state_name: "TX", cases_2024: "5" },
  ]);
});

test("suggestHtmlRows uses first class when there is no id", () => {
  const html = `<table class="data sortable"><tbody>
    <tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>`;
  const s = suggestHtmlRows(html);
  assert.equal(s?.selector, "table.data tbody tr");
});

test("suggestHtmlRows omits fields when the table has no tbody", () => {
  const html = `<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>`;
  const s = suggestHtmlRows(html);
  assert.equal(s?.selector, "table tr");
  assert.equal(s?.fields, undefined);
});

test("suggestHtmlRows picks the largest of multiple tables", () => {
  const html = `
    <table id="small"><tbody><tr><td>x</td></tr><tr><td>y</td></tr></tbody></table>
    <table id="big"><tbody>
      <tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr><tr><td>4</td></tr>
    </tbody></table>`;
  const s = suggestHtmlRows(html);
  assert.equal(s?.selector, "#big tbody tr");
  assert.equal(s?.rowCount, 4);
});

test("suggestHtmlRows falls back to a repeated classed element", () => {
  const html = `<section>
    <article class="card">a</article>
    <article class="card">b</article>
    <article class="card">c</article>
  </section>`;
  const s = suggestHtmlRows(html);
  assert.equal(s?.selector, "article.card");
  assert.equal(s?.rowCount, 3);
});

test("suggestHtmlRows returns undefined when nothing repeats", () => {
  assert.equal(suggestHtmlRows("<p>just a paragraph</p>"), undefined);
});

test("parseHarFile normalizes entries and lowercases response headers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-har-"));
  const harPath = join(dir, "t.har");
  const har = {
    log: {
      entries: [
        {
          request: {
            method: "GET",
            url: "https://api.test/x?limit=5",
            headers: [
              { name: ":method", value: "GET" },
              { name: "Accept", value: "application/json" },
            ],
          },
          response: {
            status: 200,
            headers: [{ name: "Content-Type", value: "application/json" }],
            content: { mimeType: "application/json", text: '{"ok":true}' },
          },
        },
      ],
    },
  };
  await writeFile(harPath, JSON.stringify(har), "utf8");
  try {
    const reqs = await parseHarFile(harPath);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].url, "https://api.test/x?limit=5");
    assert.equal(reqs[0].headers["Accept"], "application/json");
    assert.equal(reqs[0].headers[":method"], undefined);
    assert.equal(reqs[0].queryParams.limit, "5");
    assert.equal(reqs[0].response?.headers?.["content-type"], "application/json");
    assert.equal(reqs[0].response?.bodyText, '{"ok":true}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseHarFile skips base64-encoded response bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-har-"));
  const harPath = join(dir, "t.har");
  const har = {
    log: {
      entries: [
        {
          request: { method: "GET", url: "https://api.test/x" },
          response: {
            status: 200,
            content: { mimeType: "image/png", text: "aGVsbG8=", encoding: "base64" },
          },
        },
      ],
    },
  };
  await writeFile(harPath, JSON.stringify(har), "utf8");
  try {
    const reqs = await parseHarFile(harPath);
    assert.equal(reqs[0].response?.bodyText, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseHarFile throws on empty entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-har-"));
  const harPath = join(dir, "t.har");
  await writeFile(harPath, JSON.stringify({ log: { entries: [] } }), "utf8");
  try {
    await assert.rejects(() => parseHarFile(harPath), /no request entries/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
