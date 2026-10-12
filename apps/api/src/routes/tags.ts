import { Hono } from "hono";
import { db } from "../db/client";
import { tags } from "../db/schema";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";

export const tagsRouter = new Hono<AppEnv>();

tagsRouter.get("/tags", async (c) => {
  const raw = c.req.query("limit");
  let limit: number | undefined;
  if (raw !== undefined) {
    limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(limit >= 1 && limit <= 50)) {
      throw new ApiError(422, { limit: ["must be between 1 and 50"] });
    }
  }
  const query = db(c.env).select({ name: tags.name }).from(tags).orderBy(tags.name);
  const rows = await (limit === undefined ? query : query.limit(limit)).all();
  return c.json({ tags: rows.map((r) => r.name) });
});
