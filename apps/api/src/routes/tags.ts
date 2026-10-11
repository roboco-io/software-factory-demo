import { Hono } from "hono";
import { db } from "../db/client";
import { tags } from "../db/schema";
import type { AppEnv } from "../env";

export const tagsRouter = new Hono<AppEnv>();

tagsRouter.get("/tags", async (c) => {
  const rows = await db(c.env).select({ name: tags.name }).from(tags).orderBy(tags.name).all();
  return c.json({ tags: rows.map((r) => r.name) });
});
