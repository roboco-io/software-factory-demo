import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { tags } from "../db/schema";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";

export const tagsRouter = new Hono<AppEnv>();

tagsRouter.get("/tags", async (c) => {
  if (c.req.query("prefix") === "") return c.json({ errors: { prefix: ["must not be empty"] } }, 422);
  const raw = c.req.query("limit");
  let limit: number | undefined;
  if (raw !== undefined) {
    limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(limit >= 1 && limit <= 50)) {
      throw new ApiError(422, { limit: ["must be between 1 and 50"] });
    }
  }
  const prefix = c.req.query("prefix");
  if (prefix !== undefined && prefix.length > 20) {
    throw new ApiError(422, { prefix: ["must be 20 characters or less"] });
  }
  const base = db(c.env).select({ name: tags.name }).from(tags);
  const filtered =
    prefix === undefined || prefix === ""
      ? base
      : base.where(sql`substr(${tags.name}, 1, length(${prefix})) = ${prefix}`);
  const query = filtered.orderBy(tags.name);
  const rows = await (limit === undefined ? query : query.limit(limit)).all();
  return c.json({ tags: rows.map((r) => r.name) });
});
