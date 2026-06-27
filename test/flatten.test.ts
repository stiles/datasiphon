import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenRecord, unwrapArcgisFeature, unionColumns } from "../src/flatten.js";

test("flattens nested objects to dotted keys", () => {
  const out = flattenRecord({ a: 1, b: { c: 2, d: { e: 3 } } });
  assert.deepEqual(out, { a: 1, "b.c": 2, "b.d.e": 3 });
});

test("joins scalar arrays with pipe separator", () => {
  const out = flattenRecord({ tags: ["x", "y", "z"] });
  assert.equal(out.tags, "x | y | z");
});

test("scalar array with null becomes empty string element", () => {
  const out = flattenRecord({ tags: ["x", null, "z"] });
  assert.equal(out.tags, "x |  | z");
});

test("arrays of objects are stored as compact JSON", () => {
  const out = flattenRecord({ items: [{ id: 1 }, { id: 2 }] });
  assert.equal(out.items, '[{"id":1},{"id":2}]');
});

test("null values are preserved", () => {
  const out = flattenRecord({ a: null });
  assert.equal(out.a, null);
});

test("empty nested object becomes empty string", () => {
  const out = flattenRecord({ a: {} });
  assert.equal(out.a, "");
});

test("unwrapArcgisFeature hoists attributes to top level", () => {
  const out = unwrapArcgisFeature({ attributes: { OBJECTID: 1, name: "x" }, geometry: { x: 0 } });
  assert.deepEqual(out, { geometry: { x: 0 }, OBJECTID: 1, name: "x" });
});

test("unwrapArcgisFeature leaves non-arcgis records unchanged", () => {
  const rec = { id: 1, name: "x" };
  assert.deepEqual(unwrapArcgisFeature(rec), rec);
});

test("unwrapArcgisFeature ignores non-object attributes", () => {
  const rec = { attributes: "not-an-object" };
  assert.deepEqual(unwrapArcgisFeature(rec), rec);
});

test("unionColumns preserves first-seen order across ragged rows", () => {
  const cols = unionColumns([
    { a: 1, b: 2 },
    { b: 2, c: 3 },
    { a: 1, d: 4 },
  ]);
  assert.deepEqual(cols, ["a", "b", "c", "d"]);
});
