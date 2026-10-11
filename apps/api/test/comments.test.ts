import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

type Comment = {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { username: string };
};
type ErrBody = { errors: Record<string, string[]> };

async function setup() {
  const a = await register("cmt");
  const res = await api("/articles", {
    method: "POST",
    token: a.token,
    body: { article: { title: "C", description: "D", body: "B" } },
  });
  const { article } = (await res.json()) as { article: { slug: string } };
  return { a, slug: article.slug };
}
const post = (slug: string, token: string | undefined, body: unknown) =>
  api(`/articles/${slug}/comments`, { method: "POST", token, body: { comment: { body } } });

describe("comments", () => {
  it("creates, lists in order, deletes selectively", async () => {
    const { a, slug } = await setup();
    const c1 = ((await (await post(slug, a.token, "first")).json()) as { comment: Comment })
      .comment;
    const r2 = await post(slug, a.token, "second");
    expect(r2.status).toBe(201);
    expect(Number.isInteger(c1.id)).toBe(true);
    expect(c1.author.username).toBe(a.username);

    const list = async () =>
      ((await (await api(`/articles/${slug}/comments`)).json()) as { comments: Comment[] })
        .comments;
    expect((await list()).map((c) => c.body)).toEqual(["first", "second"]);
    expect(
      (await api(`/articles/${slug}/comments/${c1.id}`, { method: "DELETE", token: a.token }))
        .status,
    ).toBe(204);
    expect((await list()).map((c) => c.body)).toEqual(["second"]);
  });

  it("401 without auth, 422 blank body, 404 unknown article", async () => {
    const { a, slug } = await setup();
    expect((await post(slug, undefined, "x")).status).toBe(401);
    const blank = await post(slug, a.token, "");
    expect(blank.status).toBe(422);
    expect(((await blank.json()) as ErrBody).errors.body).toEqual(["can't be blank"]);
    for (const res of [
      await post("ghost-000000", a.token, "x"),
      await api("/articles/ghost-000000/comments"),
      await api("/articles/ghost-000000/comments/1", { method: "DELETE", token: a.token }),
    ]) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrBody).errors.article).toEqual(["not found"]);
    }
  });

  it("404 comment for unknown id, non-integer id, or a comment on another article", async () => {
    const one = await setup();
    const two = await setup();
    const c = ((await (await post(two.slug, two.a.token, "other")).json()) as { comment: Comment })
      .comment;
    for (const id of ["99999", "abc", String(c.id)]) {
      const res = await api(`/articles/${one.slug}/comments/${id}`, {
        method: "DELETE",
        token: one.a.token,
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrBody).errors.comment).toEqual(["not found"]);
    }
  });

  it("403 when deleting someone else's comment, and the comment survives", async () => {
    const { a, slug } = await setup();
    const b = await register("intruder");
    const c = ((await (await post(slug, a.token, "A's comment")).json()) as { comment: Comment })
      .comment;
    const res = await api(`/articles/${slug}/comments/${c.id}`, {
      method: "DELETE",
      token: b.token,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrBody).errors.comment).toEqual(["forbidden"]);
    const list = (
      (await (await api(`/articles/${slug}/comments`)).json()) as { comments: Comment[] }
    ).comments;
    expect(list).toHaveLength(1);
  });
});
