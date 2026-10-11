import { describe, expect, it } from "vitest";
import { chunk, FAVORITES_CHUNK } from "../src/routes/articles";
import { api, register } from "./helpers";

type Art = { slug: string; favorited: boolean; favoritesCount: number };
type ErrBody = { errors: Record<string, string[]> };

async function create(token: string, title: string) {
  const res = await api("/articles", {
    method: "POST",
    token,
    body: { article: { title, description: "d", body: "b" } },
  });
  return ((await res.json()) as { article: Art }).article;
}
const fav = (slug: string, token?: string, method = "POST") =>
  api(`/articles/${slug}/favorite`, { method, token });

describe("favorites", () => {
  it("favorites and unfavorites with count", async () => {
    const a = await register("fa");
    const b = await register("fb");
    const art = await create(a.token, "Fav one");
    const r1 = await fav(art.slug, a.token);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { article: Art }).article).toMatchObject({
      favorited: true,
      favoritesCount: 1,
    });
    // idempotent
    const again = await fav(art.slug, a.token);
    expect(((await again.json()) as { article: Art }).article.favoritesCount).toBe(1);
    const r2 = await fav(art.slug, b.token);
    expect(((await r2.json()) as { article: Art }).article.favoritesCount).toBe(2);
    const un = await fav(art.slug, a.token, "DELETE");
    expect(((await un.json()) as { article: Art }).article).toMatchObject({
      favorited: false,
      favoritesCount: 1,
    });
    const anon = await api(`/articles/${art.slug}`);
    expect(((await anon.json()) as { article: Art }).article).toMatchObject({
      favorited: false,
      favoritesCount: 1,
    });
  });

  it("401 without auth, 404 for unknown slug", async () => {
    for (const method of ["POST", "DELETE"]) {
      const res = await fav("x", undefined, method);
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrBody).errors.token).toEqual(["is missing"]);
    }
    const a = await register("fn");
    const res = await fav("ghost-slug", a.token);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrBody).errors.article).toEqual(["not found"]);
    expect((await fav("ghost-slug", a.token, "DELETE")).status).toBe(404);
  });

  it("filters list by ?favorited=username", async () => {
    const a = await register("ff");
    const art1 = await create(a.token, "Filter one");
    await create(a.token, "Filter two");
    await fav(art1.slug, a.token);
    const res = await api(`/articles?favorited=${a.username}`, { token: a.token });
    const body = (await res.json()) as { articles: Art[]; articlesCount: number };
    expect(body.articlesCount).toBe(1);
    expect(body.articles).toHaveLength(1);
    expect(body.articles[0]).toMatchObject({ slug: art1.slug, favorited: true, favoritesCount: 1 });
    const none = await api("/articles?favorited=nobody-here");
    expect(((await none.json()) as { articlesCount: number }).articlesCount).toBe(0);
  });

  it("unfavoriting twice is idempotent", async () => {
    const a = await register("fu");
    const art = await create(a.token, "Unfav twice");
    await fav(art.slug, a.token);
    const first = await fav(art.slug, a.token, "DELETE");
    const second = await fav(art.slug, a.token, "DELETE");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { article: Art }).article).toMatchObject({
      favorited: false,
      favoritesCount: 0,
    });
  });

  it("list favorited reflects each viewer separately", async () => {
    const a = await register("fv1");
    const b = await register("fv2");
    const art = await create(a.token, "Viewer split");
    await fav(art.slug, a.token);
    const find = async (token?: string) => {
      const res = await api("/articles?limit=100", { token });
      const list = ((await res.json()) as { articles: Art[] }).articles;
      return list.find((x) => x.slug === art.slug);
    };
    expect(await find(a.token)).toMatchObject({ favorited: true, favoritesCount: 1 });
    expect(await find(b.token)).toMatchObject({ favorited: false, favoritesCount: 1 });
    expect(await find()).toMatchObject({ favorited: false, favoritesCount: 1 });
  });

  it("signed-in GET /articles?limit=100 works with a full page", async () => {
    const a = await register("fl");
    for (let i = 0; i < 101; i++) await create(a.token, `Bulk ${i}`);
    const res = await api("/articles?limit=100", { token: a.token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { articles: Art[] }).articles).toHaveLength(100);
  }, 60000);
});

describe("chunk (D1 allows at most 100 bound parameters per query)", () => {
  it("keeps userId + chunk within 100 parameters", () => {
    expect(FAVORITES_CHUNK + 1).toBeLessThanOrEqual(100);
    const parts = chunk(
      Array.from({ length: 100 }, (_, i) => i),
      FAVORITES_CHUNK,
    );
    expect(parts).toHaveLength(2);
    for (const p of parts) expect(p.length + 1).toBeLessThanOrEqual(100);
    expect(parts.flat()).toHaveLength(100);
  });
  it("returns no chunks for empty input", () => {
    expect(chunk([], 99)).toEqual([]);
  });
});
