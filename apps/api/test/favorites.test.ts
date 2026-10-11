import { describe, expect, it } from "vitest";
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
});
