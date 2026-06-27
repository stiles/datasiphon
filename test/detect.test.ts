import { test } from "node:test";
import assert from "node:assert/strict";
import { findRecordArray, analyzeBody, findDataUrl } from "../src/detect.js";

test("findRecordArray locates a top-level array", () => {
  const found = findRecordArray([{ a: 1 }, { a: 2 }]);
  assert.equal(found?.path, "$");
  assert.equal(found?.length, 2);
  assert.equal(found?.recordiness, 1);
});

test("findRecordArray prefers a data key over a metadata key", () => {
  const value = {
    fields: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
    features: [{ attributes: { id: 1 } }, { attributes: { id: 2 } }],
  };
  const found = findRecordArray(value);
  assert.equal(found?.path, "$.features");
});

test("findRecordArray scores recordiness (objects beat scalars)", () => {
  const value = {
    tags: ["x", "y", "z", "w", "v"],
    items: [{ id: 1 }, { id: 2 }],
  };
  const found = findRecordArray(value);
  assert.equal(found?.path, "$.items");
});

test("findRecordArray returns null for scalars", () => {
  assert.equal(findRecordArray(42), null);
  assert.equal(findRecordArray("hi"), null);
  assert.equal(findRecordArray(null), null);
});

test("analyzeBody classifies JSON and finds the path", () => {
  const body = JSON.stringify({ results: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  const a = analyzeBody(body, "application/json");
  assert.equal(a?.format, "json");
  assert.equal(a?.rowsPath, "$.results");
  assert.equal(a?.estimatedRows, 3);
});

test("analyzeBody detects JSON by content even without content-type", () => {
  const a = analyzeBody('[{"x":1}]');
  assert.equal(a?.format, "json");
  assert.equal(a?.estimatedRows, 1);
});

test("analyzeBody classifies XML", () => {
  const xml = "<response><record><a>1</a></record><record><a>2</a></record></response>";
  const a = analyzeBody(xml, "application/xml");
  assert.equal(a?.format, "xml");
});

test("analyzeBody classifies HTML", () => {
  const a = analyzeBody("<!doctype html><html><body><table></table></body></html>", "text/html");
  assert.equal(a?.format, "html");
  assert.equal(a?.estimatedRows, 0);
});

test("analyzeBody returns null for unrecognized text", () => {
  assert.equal(analyzeBody("just some plain text", "text/plain"), null);
});

test("analyzeBody returns null for malformed JSON content-type but garbage body", () => {
  // Declared JSON but unparseable, and not XML/HTML -> null
  assert.equal(analyzeBody("{not valid", "application/json"), null);
});

test("findDataUrl reads a CDC-style dataUrl path", () => {
  assert.equal(
    findDataUrl({ type: "chart", dataUrl: "/wcms/vizdata/measles/MeaslesCasesWeekly.json" }),
    "/wcms/vizdata/measles/MeaslesCasesWeekly.json",
  );
});

test("findDataUrl accepts dataFileName and absolute URLs", () => {
  assert.equal(findDataUrl({ dataFileName: "https://x.test/data.json" }), "https://x.test/data.json");
});

test("findDataUrl ignores non-path strings", () => {
  // A label that happens to be named dataUrl but isn't a path.
  assert.equal(findDataUrl({ dataUrl: "Weekly Cases" }), undefined);
});

test("findDataUrl returns undefined for arrays and scalars", () => {
  assert.equal(findDataUrl([{ dataUrl: "/x.json" }]), undefined);
  assert.equal(findDataUrl("nope"), undefined);
});

test("analyzeBody surfaces dataUrl on a config response", () => {
  const config = JSON.stringify({ type: "chart", series: [{ dataKey: "cases" }], dataUrl: "/data/x.json" });
  const a = analyzeBody(config, "application/json");
  assert.equal(a?.dataUrl, "/data/x.json");
});
