import assert from "node:assert/strict";
import { test } from "node:test";
import { previewConfig } from "./preview-config.mjs";

const base = {
  name: "sfd-api",
  main: "src/index.ts",
  vars: { ALLOWED_ORIGINS: "https://roboco.io" },
  d1_databases: [
    {
      binding: "DB",
      database_name: "sfd-prod",
      database_id: "prod-id",
      migrations_dir: "migrations",
    },
  ],
};

test("renames worker and database for the PR", () => {
  const cfg = previewConfig(base, 12, "pr-id");
  assert.equal(cfg.name, "sfd-api-pr-12");
  assert.deepEqual(cfg.d1_databases, [
    {
      binding: "DB",
      database_name: "sfd-pr-12",
      database_id: "pr-id",
      migrations_dir: "migrations",
    },
  ]);
  assert.equal(cfg.vars.ALLOWED_ORIGINS, "https://roboco.io");
});

test("does not mutate the base config", () => {
  previewConfig(base, 1, "x");
  assert.equal(base.name, "sfd-api");
  assert.equal(base.d1_databases[0].database_id, "prod-id");
});

test("rejects invalid PR numbers and empty ids", () => {
  assert.throws(() => previewConfig(base, 0, "x"));
  assert.throws(() => previewConfig(base, 1.5, "x"));
  assert.throws(() => previewConfig(base, 3, ""));
});

test("keeps alias + worker name within the 63-char DNS label limit", () => {
  assert.ok(previewConfig(base, 999999, "x").name.length <= 63);
});
