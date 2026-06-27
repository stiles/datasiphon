import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanHeaders,
  redactHeaders,
  resolveHeaderEnv,
  validateRecipe,
  type Recipe,
} from "../src/recipe.js";

test("cleanHeaders strips noise and flags secrets", () => {
  const { kept, secrets } = cleanHeaders({
    Accept: "application/json",
    "Accept-Encoding": "gzip",
    "sec-fetch-mode": "cors",
    Authorization: "Bearer x",
    Cookie: "s=1",
  });
  assert.equal(kept["Accept"], "application/json");
  assert.equal(kept["Accept-Encoding"], undefined);
  assert.equal(kept["sec-fetch-mode"], undefined);
  assert.equal(kept["Authorization"], "Bearer x");
  assert.deepEqual(secrets.sort(), ["Authorization", "Cookie"]);
});

test("redactHeaders replaces secret values with env placeholders", () => {
  const { headers, envVars } = redactHeaders({
    Accept: "application/json",
    Authorization: "Bearer secret",
    "X-API-Key": "abc",
  });
  assert.equal(headers["Accept"], "application/json");
  assert.equal(headers["Authorization"], "${DATASIPHON_AUTHORIZATION}");
  assert.equal(headers["X-API-Key"], "${DATASIPHON_X_API_KEY}");
  assert.deepEqual(envVars.sort(), ["DATASIPHON_AUTHORIZATION", "DATASIPHON_X_API_KEY"]);
});

test("resolveHeaderEnv substitutes from process.env", () => {
  process.env.DATASIPHON_TEST_TOKEN = "live-token";
  const { headers, missing } = resolveHeaderEnv({ Authorization: "Bearer ${DATASIPHON_TEST_TOKEN}" });
  assert.equal(headers["Authorization"], "Bearer live-token");
  assert.deepEqual(missing, []);
  delete process.env.DATASIPHON_TEST_TOKEN;
});

test("resolveHeaderEnv reports missing env vars and blanks them", () => {
  delete process.env.DATASIPHON_NOPE;
  const { headers, missing } = resolveHeaderEnv({ Authorization: "Bearer ${DATASIPHON_NOPE}" });
  assert.equal(headers["Authorization"], "Bearer ");
  assert.deepEqual(missing, ["DATASIPHON_NOPE"]);
});

function baseRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    source: { url: "https://api.test/x", method: "GET" },
    pagination: { type: "none", maxPages: 1 },
    rows: { format: "json", path: "$.results" },
    politeness: { delayMs: 0, maxRetries: 0 },
    output: { formats: ["csv"], basename: "x" },
    ...overrides,
  };
}

test("validateRecipe passes a well-formed recipe", () => {
  assert.deepEqual(validateRecipe(baseRecipe()), []);
});

test("validateRecipe requires rows.path for json", () => {
  const errs = validateRecipe(baseRecipe({ rows: { format: "json" } }));
  assert.ok(errs.some((e) => e.includes("rows.path is required")));
});

test("validateRecipe requires selector for html", () => {
  const errs = validateRecipe(baseRecipe({ rows: { format: "html" } }));
  assert.ok(errs.some((e) => e.includes("rows.selector is required")));
});

test("validateRecipe requires param for offset pagination", () => {
  const errs = validateRecipe(
    baseRecipe({ pagination: { type: "offset", maxPages: 10 } }),
  );
  assert.ok(errs.some((e) => e.includes("pagination.param is required")));
});

test("validateRecipe requires nextField for cursor pagination", () => {
  const errs = validateRecipe(
    baseRecipe({ pagination: { type: "cursor", param: "cursor", maxPages: 10 } }),
  );
  assert.ok(errs.some((e) => e.includes("pagination.nextField is required")));
});
