import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { writeCsv } from "../src/output/csv.js";
import { writeSqlite, inferColumnType, inferColumnTypes } from "../src/output/sqlite.js";

test("writeCsv quotes cells containing commas, quotes, and newlines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-csv-"));
  const path = join(dir, "out.csv");
  try {
    await writeCsv(path, ["a", "b"], [
      { a: "plain", b: "has,comma" },
      { a: 'has"quote', b: "line\nbreak" },
      { a: null, b: 42 },
    ]);
    const text = await readFile(path, "utf8");
    const expected =
      "a,b\n" +
      "plain,\"has,comma\"\n" +
      '"has""quote","line\nbreak"\n' +
      ",42\n";
    assert.equal(text, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inferColumnType classifies numbers, floats, and text", () => {
  assert.equal(inferColumnType(["0", "10", "-3"]), "INTEGER");
  assert.equal(inferColumnType([1, 2, 3]), "INTEGER");
  assert.equal(inferColumnType(["1.5", "2", "3"]), "REAL");
  assert.equal(inferColumnType([1.5, 2, 3]), "REAL");
  assert.equal(inferColumnType(["a", "1", "2"]), "TEXT");
  assert.equal(inferColumnType([]), "TEXT");
  assert.equal(inferColumnType([null, "", null]), "TEXT");
});

test("inferColumnType preserves leading-zero codes as TEXT", () => {
  // ZIP / FIPS codes must not be coerced to integers (would drop the zero).
  assert.equal(inferColumnType(["01234", "00501", "90210"]), "TEXT");
});

test("inferColumnType keeps oversized digit strings as TEXT", () => {
  // Long IDs / phone numbers: not real quantities, and risk int overflow.
  assert.equal(inferColumnType(["1234567890123456789"]), "TEXT");
});

test("inferColumnType treats all-boolean columns as INTEGER", () => {
  assert.equal(inferColumnType([true, false, true]), "INTEGER");
});

test("inferColumnType ignores blanks/nulls when deciding", () => {
  assert.equal(inferColumnType([null, "5", "", "7"]), "INTEGER");
});

test("inferColumnTypes maps each column independently", () => {
  const types = inferColumnTypes(
    ["id", "rate", "name", "zip"],
    [
      { id: "1", rate: "1.5", name: "Alice", zip: "01234" },
      { id: "2", rate: "2.0", name: "Bob", zip: "90210" },
    ],
  );
  assert.deepEqual(types, { id: "INTEGER", rate: "REAL", name: "TEXT", zip: "TEXT" });
});

test("writeSqlite applies inferred types and coerces values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-sql-"));
  const path = join(dir, "out.sqlite");
  try {
    const types = writeSqlite(path, "records", ["id", "rate", "name", "zip", "flag"], [
      { id: "1", rate: "1.5", name: "Alice", zip: "01234", flag: true },
      { id: "2", rate: "2", name: null, zip: "90210", flag: false },
    ]);
    assert.deepEqual(types, {
      id: "INTEGER",
      rate: "REAL",
      name: "TEXT",
      zip: "TEXT",
      flag: "INTEGER",
    });
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.prepare("SELECT id, rate, name, zip, flag FROM records ORDER BY id").all() as Array<{
        id: number;
        rate: number;
        name: string | null;
        zip: string;
        flag: number;
      }>;
      assert.equal(rows[0].id, 1); // numeric, not "1"
      assert.equal(typeof rows[0].id, "number");
      assert.equal(rows[0].rate, 1.5);
      assert.equal(rows[0].name, "Alice");
      assert.equal(rows[0].zip, "01234"); // leading zero preserved
      assert.equal(rows[0].flag, 1); // boolean -> 1
      assert.equal(rows[1].name, null);
      assert.equal(rows[1].flag, 0);

      const info = db.prepare("PRAGMA table_info(records)").all() as Array<{ name: string; type: string }>;
      const idCol = info.find((c) => c.name === "id");
      assert.equal(idCol?.type, "INTEGER");
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeSqlite handles zero columns without crashing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-sql-"));
  const path = join(dir, "empty.sqlite");
  try {
    writeSqlite(path, "records", [], []);
    const db = new Database(path, { readonly: true });
    try {
      const info = db.prepare("PRAGMA table_info(records)").all();
      assert.ok(info.length >= 1);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
