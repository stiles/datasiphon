import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { writeCsv } from "../src/output/csv.js";
import { writeSqlite } from "../src/output/sqlite.js";

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

test("writeSqlite creates a TEXT table and inserts rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-sql-"));
  const path = join(dir, "out.sqlite");
  try {
    writeSqlite(path, "records", ["id", "name"], [
      { id: 1, name: "Alice" },
      { id: 2, name: null },
    ]);
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.prepare("SELECT id, name FROM records ORDER BY id").all() as Array<{
        id: string;
        name: string | null;
      }>;
      assert.equal(rows.length, 2);
      assert.equal(rows[0].id, "1");
      assert.equal(rows[0].name, "Alice");
      assert.equal(rows[1].name, null);
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
