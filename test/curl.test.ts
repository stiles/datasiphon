import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCurlString } from "../src/parse/curl.js";

test("parses a basic GET with headers", () => {
  const cmd = `curl 'https://api.test/v1/data?limit=10' \\
    -H 'Accept: application/json' \\
    -H 'Authorization: Bearer tok123'`;
  const r = parseCurlString(cmd);
  assert.equal(r.method, "GET");
  assert.equal(r.url, "https://api.test/v1/data?limit=10");
  assert.equal(r.headers["Accept"], "application/json");
  assert.equal(r.headers["Authorization"], "Bearer tok123");
  assert.equal(r.queryParams.limit, "10");
});

test("body data implies POST", () => {
  const r = parseCurlString(`curl 'https://api.test/x' --data-raw '{"q":"hi"}'`);
  assert.equal(r.method, "POST");
  assert.equal(r.bodyText, '{"q":"hi"}');
});

test("explicit -X overrides inferred method", () => {
  const r = parseCurlString(`curl -X DELETE 'https://api.test/x/1'`);
  assert.equal(r.method, "DELETE");
});

test("multiple --data parts join with &", () => {
  const r = parseCurlString(`curl 'https://api.test/x' -d 'a=1' -d 'b=2'`);
  assert.equal(r.bodyText, "a=1&b=2");
});

test("-b sets the Cookie header", () => {
  const r = parseCurlString(`curl 'https://api.test/x' -b 'session=abc'`);
  assert.equal(r.headers["Cookie"], "session=abc");
});

test("pseudo-headers starting with colon are skipped", () => {
  const r = parseCurlString(`curl 'https://api.test/x' -H ':authority: api.test'`);
  assert.equal(r.headers[":authority"], undefined);
});

test("flags without args are ignored", () => {
  const r = parseCurlString(`curl --compressed -s -L 'https://api.test/x'`);
  assert.equal(r.url, "https://api.test/x");
  assert.equal(r.method, "GET");
});

test("throws when input is not curl", () => {
  assert.throws(() => parseCurlString("wget https://api.test/x"), /does not look like a cURL/);
});

test("throws when no URL is present", () => {
  assert.throws(() => parseCurlString("curl -H 'Accept: */*'"), /Could not find a URL/);
});

test("double-quote escapes are honored", () => {
  const r = parseCurlString(`curl "https://api.test/x" -H "X-Test: a\\"b"`);
  assert.equal(r.headers["X-Test"], 'a"b');
});
