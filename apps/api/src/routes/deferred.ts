import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { articles, users } from "../db/schema";
import type { AppEnv } from "../env";
import { notFound, notImplemented } from "../lib/errors";
import { requireAuth } from "../middleware/auth";

// 팩토리 데모용으로 남겨 둔 기능. 구현할 때 해당 stub을 지우고 실제 라우트로 옮긴다.
// 순서(401 → 404 → 501)를 지켜야 RealWorld 오류 테스트가 통과한다.
export const deferredRouter = new Hono<AppEnv>();

deferredRouter.on(["POST", "DELETE"], "/profiles/:username/follow", requireAuth, async (c) => {
  const row = await db(c.env)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, c.req.param("username")))
    .get();
  if (!row) throw notFound("profile");
  throw notImplemented("follow");
});

deferredRouter.on(["POST", "DELETE"], "/articles/:slug/favorite", requireAuth, async (c) => {
  const row = await db(c.env)
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.slug, c.req.param("slug")))
    .get();
  if (!row) throw notFound("article");
  throw notImplemented("favorite");
});

deferredRouter.get("/articles/feed", requireAuth, () => {
  throw notImplemented("feed");
});
