import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { db, type Db } from "../db/client";
import { articles, articleTags, favorites, tags, users } from "../db/schema";
import type { AppEnv } from "../env";
import { readWrapped, requireString } from "../lib/body";
import { ApiError, forbidden, invalid, notFound, tooLarge } from "../lib/errors";
import { slugify } from "../lib/slug";
import { nextTimestamp } from "../lib/time";
import { authedUserId, optionalAuth, requireAuth } from "../middleware/auth";
import { serializeArticle } from "../serializers";

const MAX_TAGS = 20;
type ArticleInput = { title: unknown; description: unknown; body: unknown; tagList: unknown };

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((t) => typeof t !== "string")) throw invalid("tagList");
  const out: string[] = [];
  for (const raw of value as string[]) {
    const t = raw.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS)
    throw new ApiError(422, { tagList: [`is too long (maximum is ${MAX_TAGS} tags)`] });
  return out;
}

export async function tagsFor(d: Db, ids: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;
  const rows = await d
    .select({ articleId: articleTags.articleId, name: tags.name })
    .from(articleTags)
    .innerJoin(tags, eq(tags.id, articleTags.tagId))
    .where(inArray(articleTags.articleId, ids))
    .orderBy(asc(articleTags.position));
  for (const r of rows) map.get(r.articleId)!.push(r.name);
  return map;
}

async function setTags(d: Db, articleId: number, names: string[]) {
  await d.delete(articleTags).where(eq(articleTags.articleId, articleId));
  if (names.length === 0) return;
  await d
    .insert(tags)
    .values(names.map((name) => ({ name })))
    .onConflictDoNothing();
  const rows = await d.select().from(tags).where(inArray(tags.name, names));
  const idByName = new Map(rows.map((r) => [r.name, r.id]));
  await d
    .insert(articleTags)
    .values(names.map((n, i) => ({ articleId, tagId: idByName.get(n)!, position: i })));
}

export async function loadArticle(d: Db, slug: string) {
  const row = await d
    .select({ article: articles, author: users })
    .from(articles)
    .innerJoin(users, eq(users.id, articles.authorId))
    .where(eq(articles.slug, slug))
    .get();
  return row ?? undefined;
}

// D1 allows at most 100 bound parameters per query. The "mine" query binds userId plus the ids.
export const FAVORITES_CHUNK = 99;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function favoritesFor(d: Db, ids: number[], userId: number | null) {
  const counts = new Map<number, number>(ids.map((id) => [id, 0]));
  const mine = new Set<number>();
  for (const part of chunk(ids, FAVORITES_CHUNK)) {
    const rows = await d
      .select({ articleId: favorites.articleId, n: count() })
      .from(favorites)
      .where(inArray(favorites.articleId, part))
      .groupBy(favorites.articleId);
    for (const r of rows) counts.set(r.articleId, r.n);
    if (userId !== null) {
      const own = await d
        .select({ articleId: favorites.articleId })
        .from(favorites)
        .where(and(eq(favorites.userId, userId), inArray(favorites.articleId, part)));
      for (const r of own) mine.add(r.articleId);
    }
  }
  return { counts, mine };
}

async function respondOne(d: Db, slug: string, userId: number | null) {
  const row = await loadArticle(d, slug);
  if (!row) throw notFound("article");
  const id = row.article.id;
  const tagList = (await tagsFor(d, [id])).get(id) ?? [];
  const fav = await favoritesFor(d, [id], userId);
  return {
    article: serializeArticle(row.article, tagList, row.author, {
      body: true,
      favorited: fav.mine.has(id),
      favoritesCount: fav.counts.get(id) ?? 0,
    }),
  };
}

const intParam = (v: string | undefined, dflt: number, min: number, max: number) => {
  const n = v === undefined ? dflt : Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
};

export const articlesRouter = new Hono<AppEnv>();

articlesRouter.get("/articles", optionalAuth, async (c) => {
  const q = c.req.query();
  if (q.limit !== undefined && Number.parseInt(q.limit, 10) > 100) throw tooLarge("limit", 100);
  const limit = intParam(q.limit, 20, 1, 100);
  const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const conds: SQL[] = [];
  if (q.author) conds.push(eq(users.username, q.author));
  if (q.tag)
    conds.push(
      sql`exists (select 1 from article_tags at join tags t on t.id = at.tag_id where at.article_id = ${articles.id} and t.name = ${q.tag})`,
    );
  if (q.favorited)
    conds.push(
      sql`exists (select 1 from favorites f join users fu on fu.id = f.user_id where f.article_id = ${articles.id} and fu.username = ${q.favorited})`,
    );
  const where = conds.length > 0 ? and(...conds) : undefined;
  const d = db(c.env);

  const rows = await d
    .select({ article: articles, author: users })
    .from(articles)
    .innerJoin(users, eq(users.id, articles.authorId))
    .where(where)
    .orderBy(desc(articles.createdAt), desc(articles.id))
    .limit(limit)
    .offset(offset);
  const total = await d
    .select({ n: count() })
    .from(articles)
    .innerJoin(users, eq(users.id, articles.authorId))
    .where(where)
    .get();
  const tagMap = await tagsFor(
    d,
    rows.map((r) => r.article.id),
  );
  const fav = await favoritesFor(
    d,
    rows.map((r) => r.article.id),
    c.get("userId"),
  );
  return c.json({
    articles: rows.map((r) =>
      serializeArticle(r.article, tagMap.get(r.article.id) ?? [], r.author, {
        body: false,
        favorited: fav.mine.has(r.article.id),
        favoritesCount: fav.counts.get(r.article.id) ?? 0,
      }),
    ),
    articlesCount: total?.n ?? 0,
  });
});

articlesRouter.post("/articles", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const input = await readWrapped<ArticleInput>(c, "article");
  const title = requireString(input.title, "title");
  const description = requireString(input.description, "description");
  const body = requireString(input.body, "body");
  const tagList = input.tagList === undefined ? [] : parseTags(input.tagList);
  const d = db(c.env);
  const now = new Date().toISOString();
  const row = await d
    .insert(articles)
    .values({
      slug: slugify(title),
      title,
      description,
      body,
      authorId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  await setTags(d, row.id, tagList);
  return c.json(await respondOne(d, row.slug, userId), 201);
});

articlesRouter.get("/articles/:slug", optionalAuth, async (c) =>
  c.json(await respondOne(db(c.env), c.req.param("slug"), c.get("userId"))),
);

articlesRouter.put("/articles/:slug", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const d = db(c.env);
  const found = await loadArticle(d, c.req.param("slug"));
  if (!found) throw notFound("article");
  if (found.article.authorId !== userId) throw forbidden("article");
  const input = await readWrapped<ArticleInput>(c, "article");

  const patch: Partial<typeof articles.$inferInsert> = {};
  for (const key of ["title", "description", "body"] as const) {
    if (key in input) patch[key] = requireString(input[key], key);
  }
  let newTags: string[] | undefined;
  if ("tagList" in input) {
    if (input.tagList === null) throw invalid("tagList");
    newTags = parseTags(input.tagList);
  }
  patch.updatedAt = nextTimestamp(found.article.updatedAt);
  await d.update(articles).set(patch).where(eq(articles.id, found.article.id));
  if (newTags !== undefined) await setTags(d, found.article.id, newTags);
  return c.json(await respondOne(d, found.article.slug, userId));
});

articlesRouter.delete("/articles/:slug", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const d = db(c.env);
  const found = await loadArticle(d, c.req.param("slug"));
  if (!found) throw notFound("article");
  if (found.article.authorId !== userId) throw forbidden("article");
  await d.delete(articles).where(eq(articles.id, found.article.id));
  return c.body(null, 204);
});

articlesRouter.post("/articles/:slug/favorite", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const d = db(c.env);
  const found = await loadArticle(d, c.req.param("slug"));
  if (!found) throw notFound("article");
  await d
    .insert(favorites)
    .values({ userId, articleId: found.article.id, createdAt: new Date().toISOString() })
    .onConflictDoNothing();
  return c.json(await respondOne(d, found.article.slug, userId));
});

articlesRouter.delete("/articles/:slug/favorite", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const d = db(c.env);
  const found = await loadArticle(d, c.req.param("slug"));
  if (!found) throw notFound("article");
  await d
    .delete(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.articleId, found.article.id)));
  return c.json(await respondOne(d, found.article.slug, userId));
});
