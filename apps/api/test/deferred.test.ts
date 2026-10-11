import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

type ErrBody = { errors: Record<string, string[]> };

describe("deferred features (left for the factory)", () => {
  it.each([
    ["POST", "/profiles/x/follow"],
    ["DELETE", "/profiles/x/follow"],
    ["POST", "/articles/x/favorite"],
    ["DELETE", "/articles/x/favorite"],
    ["GET", "/articles/feed"],
  ])("%s %s without auth → 401 token is missing", async (method, path) => {
    const res = await api(path, { method });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrBody).errors.token).toEqual(["is missing"]);
  });

  it("follow unknown user → 404 profile, known user → 501", async () => {
    const a = await register("fol");
    const unknown = await api("/profiles/ghost-user/follow", { method: "POST", token: a.token });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ErrBody).errors.profile).toEqual(["not found"]);
    const known = await api(`/profiles/${a.username}/follow`, { method: "DELETE", token: a.token });
    expect(known.status).toBe(501);
    expect(((await known.json()) as ErrBody).errors.follow).toEqual(["not implemented"]);
  });

  it("favorite unknown slug → 404 article", async () => {
    const a = await register("fav");
    const res = await api("/articles/ghost-slug/favorite", { method: "POST", token: a.token });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrBody).errors.article).toEqual(["not found"]);
  });

  it("feed with auth → 501", async () => {
    const a = await register("feed");
    expect((await api("/articles/feed", { token: a.token })).status).toBe(501);
  });

  it("tags → 200 with stored tag names, no auth", async () => {
    const a = await register("tagger");
    await api("/articles", {
      method: "POST",
      token: a.token,
      body: { article: { title: "T", description: "d", body: "b", tagList: ["alpha", "beta"] } },
    });
    const res = await api("/tags");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });
});
