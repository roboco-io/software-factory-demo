import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { notFound } from "../lib/errors";
import { optionalAuth } from "../middleware/auth";
import { serializeProfile } from "../serializers";

export const profilesRouter = new Hono<AppEnv>();

profilesRouter.get("/profiles/:username", optionalAuth, async (c) => {
  const row = await db(c.env)
    .select()
    .from(users)
    .where(eq(users.username, c.req.param("username")))
    .get();
  if (!row) throw notFound("profile");
  return c.json({ profile: serializeProfile(row, false) });
});
