import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function previewConfig(base, pr, dbId) {
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`invalid PR number: ${pr}`);
  if (!dbId) throw new Error("database id is required");
  const cfg = structuredClone(base);
  cfg.name = `sfd-api-pr-${pr}`;
  cfg.d1_databases = cfg.d1_databases.map((d) =>
    d.binding === "DB" ? { ...d, database_name: `sfd-pr-${pr}`, database_id: dbId } : d,
  );
  return cfg;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { pr: { type: "string" }, "db-id": { type: "string" } },
  });
  const apiDir = new URL("../apps/api/", import.meta.url);
  const base = JSON.parse(readFileSync(new URL("wrangler.json", apiDir), "utf8"));
  const cfg = previewConfig(base, Number(values.pr), values["db-id"]);
  writeFileSync(new URL("wrangler.preview.json", apiDir), JSON.stringify(cfg, null, 2));
  console.log(`wrote apps/api/wrangler.preview.json for ${cfg.name}`);
}
