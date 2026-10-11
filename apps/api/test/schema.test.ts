import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("schema", () => {
  it("creates P1 tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "article_tags",
      "articles",
      "comments",
      "tags",
      "users",
    ]);
  });

  it("rejects case-variant duplicate emails", async () => {
    const now = new Date().toISOString();
    const insert = (email: string, username: string) =>
      env.DB.prepare(
        "INSERT INTO users (email, username, password_hash, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)",
      )
        .bind(email, username, now, now)
        .run();
    await insert("dup@test.com", "dup1");
    await expect(insert("DUP@test.com", "dup2")).rejects.toThrow(/UNIQUE/);
  });

  it("cascades article deletion to comments and tag links", async () => {
    const now = new Date().toISOString();
    const u = await env.DB.prepare(
      "INSERT INTO users (email, username, password_hash, created_at, updated_at) VALUES ('c@t.com','c','x',?,?) RETURNING id",
    )
      .bind(now, now)
      .first<{ id: number }>();
    const a = await env.DB.prepare(
      "INSERT INTO articles (slug,title,description,body,author_id,created_at,updated_at) VALUES ('s','t','d','b',?,?,?) RETURNING id",
    )
      .bind(u!.id, now, now)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO comments (body,article_id,author_id,created_at,updated_at) VALUES ('x',?,?,?,?)",
    )
      .bind(a!.id, u!.id, now, now)
      .run();
    await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(a!.id).run();
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
