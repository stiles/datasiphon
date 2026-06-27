import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePath } from "../src/jsonpath.js";

const data = {
  results: [{ id: 1 }, { id: 2 }],
  records: { record: [{ a: 1 }] },
  meta: { next: "tok", nested: { deep: "value" } },
  list: ["x", "y", "z"],
};

test("returns root for $ or empty path", () => {
  assert.equal(resolvePath(data, "$"), data);
  assert.equal(resolvePath(data, ""), data);
});

test("dotted keys", () => {
  assert.equal(resolvePath(data, "$.meta.next"), "tok");
  assert.equal(resolvePath(data, "$.meta.nested.deep"), "value");
});

test("bare leading key without dot", () => {
  assert.deepEqual(resolvePath(data, "results"), data.results);
});

test("bracket string keys", () => {
  assert.equal(resolvePath(data, '$["meta"]["next"]'), "tok");
  assert.equal(resolvePath(data, "$['meta']['next']"), "tok");
});

test("numeric array index", () => {
  assert.deepEqual(resolvePath(data, "$.results[0]"), { id: 1 });
  assert.equal(resolvePath(data, "$.list[2]"), "z");
});

test("mixed dotted + nested array path", () => {
  assert.deepEqual(resolvePath(data, "$.records.record"), [{ a: 1 }]);
  assert.equal(resolvePath(data, "$.records.record[0].a"), 1);
});

test("missing keys return undefined, not throw", () => {
  assert.equal(resolvePath(data, "$.nope.deeper"), undefined);
  assert.equal(resolvePath(data, "$.results[99]"), undefined);
});

test("indexing a non-array returns undefined", () => {
  assert.equal(resolvePath(data, "$.meta[0]"), undefined);
});

test("keying into a scalar returns undefined", () => {
  assert.equal(resolvePath({ a: 5 }, "$.a.b"), undefined);
});
