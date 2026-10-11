import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { comments, users } from "../db/schema";
import type { AppEnv } from "../env";
import { readWrapped, requireString } from "../lib/body";
import { forbidden, notFound } from "../lib/errors";
import { authedUserId, optionalAuth, requireAuth } from "../middleware/auth";
import { serializeComment } from "../serializers";
import { loadArticle } from "./articles";

export const commentsRouter = new Hono<AppEnv>();

commentsRouter.get("/articles/:slug/comments", optionalAuth, async (c) => {
  const d = db(c.env);
  const found = await loadArticle(d, c.req.param("slug"));
  if (!found) throw notFound("article");
  const rows = await d
    .select({ comment: comments, author: users })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(eq(comments.articleId, found.article.id))
    .orderBy(asc(comments.id));
  return c.json({ comments: rows.map((r) => serializeComment(r.comment, r.author)) });
});

commentsRouter.post("/articles/:slug/comments", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const d = db(c.env);
  const found = await loadArticle(d, c.req.param("slug"));
  if (!found) throw notFound("article");
  const input = await readWrapped<{ body: unknown }>(c, "comment");
  const body = requireString(input.body, "body");
  const now = new Date().toISOString();
  const row = await d
    .insert(comments)
    .values({ body, articleId: found.article.id, authorId: userId, createdAt: now, updatedAt: now })
    .returning()
    .get();
  const author = await d.select().from(users).where(eq(users.id, userId)).get();
  return c.json({ comment: serializeComment(row, author!) }, 201);
});

commentsRouter.delete("/articles/:slug/comments/:id", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const d = db(c.env);
  const found = await loadArticle(d, c.req.param("slug"));
  if (!found) throw notFound("article");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw notFound("comment");
  const row = await d
    .select()
    .from(comments)
    .where(and(eq(comments.id, id), eq(comments.articleId, found.article.id)))
    .get();
  if (!row) throw notFound("comment");
  if (row.authorId !== userId) throw forbidden("comment");
  await d.delete(comments).where(eq(comments.id, id));
  return c.body(null, 204);
});
