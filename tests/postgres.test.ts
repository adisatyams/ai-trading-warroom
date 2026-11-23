import test from "node:test";
import assert from "node:assert/strict";
import { postgresPlaceholders } from "../src/postgres.ts";

test("PostgreSQL placeholders ignore question marks in literals and comments", () => {
  assert.equal(
    postgresPlaceholders(
      "SELECT ?, '?', \"?\", ? -- ?\n/* ? */ WHERE value = ?"
    ),
    "SELECT $1, '?', \"?\", $2 -- ?\n/* ? */ WHERE value = $3"
  );
});
