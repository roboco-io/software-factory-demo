import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

type Article = {
  slug: string;
  title: string;
  description: string;
  body?: string;
  tagList: string[];
  createdAt: string;
  updatedAt: string;
  favorited: boolean;
  favoritesCount: number;
  author: { username: string; following: boolean };
};
type ErrBody = { errors: Record<string, string[]> };

async function create(token: string, article: Record<string, unknown>) {
  const res = await api("/articles", { method: "POST", token, body: { article } });
  return {
    res,
    article: res.status === 201 ? ((await res.json()) as { article: Article }).article : undefined,
  };
}
const base = { title: "T", description: "D", body: "B" };

describe("POST /articles", () => {
  it("creates with ordered, deduped tags", async () => {
    const a = await register("art");
    const { res, article } = await create(a.token, { ...base, tagList: ["x", " y ", "x", ""] });
    expect(res.status).toBe(201);
    expect(article).toMatchObject({
      title: "T",
      description: "D",
      body: "B",
      tagList: ["x", "y"],
      favorited: false,
      favoritesCount: 0,
      author: { username: a.username, following: false },
    });
    expect(article!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it.each(["title", "description", "body"])("rejects blank %s", async (field) => {
    const a = await register("art");
    const { res } = await create(a.token, { ...base, [field]: "" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrBody).errors[field]).toEqual(["can't be blank"]);
  });

  it("rejects non-array tagList and more than 20 tags", async () => {
    const a = await register("art");
    expect((await create(a.token, { ...base, tagList: "x" })).res.status).toBe(422);
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
    expect((await create(a.token, { ...base, tagList: many })).res.status).toBe(422);
  });

  it("requires auth", async () => {
    const res = await api("/articles", { method: "POST", body: { article: base } });
    expect(res.status).toBe(401);
  });

  it("allows duplicate titles with distinct slugs", async () => {
    const a = await register("art");
    const s1 = (await create(a.token, base)).article!.slug;
    const s2 = (await create(a.token, base)).article!.slug;
    expect(s1).not.toBe(s2);
  });
});

describe("GET /articles", () => {
  it("filters by author and tag, newest first, paginates, omits body", async () => {
    const a = await register("lst");
    const tag = `tag${Date.now()}`;
    const first = (await create(a.token, { ...base, title: "first", tagList: [tag] })).article!;
    const second = (await create(a.token, { ...base, title: "second", tagList: [tag] })).article!;

    const byAuthor = (await (await api(`/articles?author=${a.username}`)).json()) as {
      articles: Article[];
      articlesCount: number;
    };
    expect(byAuthor.articlesCount).toBe(2);
    expect(byAuthor.articles.map((x) => x.slug)).toEqual([second.slug, first.slug]);
    expect(byAuthor.articles[0]!.body).toBeUndefined();

    const page2 = (await (await api(`/articles?author=${a.username}&limit=1&offset=1`)).json()) as {
      articles: Article[];
      articlesCount: number;
    };
    expect(page2.articles.map((x) => x.slug)).toEqual([first.slug]);
    expect(page2.articlesCount).toBe(2);

    const byTag = (await (await api(`/articles?tag=${tag}`)).json()) as { articles: Article[] };
    expect(byTag.articles).toHaveLength(2);
    expect(byTag.articles[0]!.tagList).toEqual([tag]);
  });

  it("clamps limit/offset and returns empty list for favorited filter", async () => {
    expect((await api("/articles?limit=1000&offset=-5")).status).toBe(200);
    const fav = (await (await api("/articles?favorited=someone")).json()) as {
      articles: Article[];
      articlesCount: number;
    };
    expect(fav).toEqual({ articles: [], articlesCount: 0 });
  });

  it("treats an invalid token as anonymous", async () => {
    expect((await api("/articles", { token: "garbage" })).status).toBe(200);
  });
});

describe("GET/PUT/DELETE /articles/:slug", () => {
  it("404 for unknown slug", async () => {
    const res = await api("/articles/nope-000000");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrBody).errors.article).toEqual(["not found"]);
  });

  it("updates body, keeps slug/createdAt, bumps updatedAt even within the same ms", async () => {
    const a = await register("upd");
    const art = (await create(a.token, { ...base, tagList: ["k1", "k2"] })).article!;
    const res = await api(`/articles/${art.slug}`, {
      method: "PUT",
      token: a.token,
      body: { article: { body: "B2", title: "New title" } },
    });
    expect(res.status).toBe(200);
    const upd = ((await res.json()) as { article: Article }).article;
    expect(upd.slug).toBe(art.slug);
    expect(upd.title).toBe("New title");
    expect(upd.createdAt).toBe(art.createdAt);
    expect(upd.updatedAt > art.updatedAt).toBe(true);
    expect(upd.tagList).toEqual(["k1", "k2"]);
  });

  it("tagList: omitted keeps, [] clears, null rejects", async () => {
    const a = await register("tags");
    const art = (await create(a.token, { ...base, tagList: ["k1"] })).article!;
    const put = (article: Record<string, unknown>) =>
      api(`/articles/${art.slug}`, { method: "PUT", token: a.token, body: { article } });
    expect(
      ((await (await put({ body: "x" })).json()) as { article: Article }).article.tagList,
    ).toEqual(["k1"]);
    expect(
      ((await (await put({ tagList: [] })).json()) as { article: Article }).article.tagList,
    ).toEqual([]);
    expect((await put({ tagList: null })).status).toBe(422);
    expect((await put({ title: "" })).status).toBe(422);
  });

  it("403 for non-author update/delete, 204 then 404 for author delete", async () => {
    const a = await register("own");
    const b = await register("oth");
    const art = (await create(a.token, base)).article!;
    const upd = await api(`/articles/${art.slug}`, {
      method: "PUT",
      token: b.token,
      body: { article: { body: "x" } },
    });
    expect(upd.status).toBe(403);
    expect(((await upd.json()) as ErrBody).errors.article).toEqual(["forbidden"]);
    expect((await api(`/articles/${art.slug}`, { method: "DELETE", token: b.token })).status).toBe(
      403,
    );
    expect((await api(`/articles/${art.slug}`, { method: "DELETE", token: a.token })).status).toBe(
      204,
    );
    expect((await api(`/articles/${art.slug}`)).status).toBe(404);
  });
});
