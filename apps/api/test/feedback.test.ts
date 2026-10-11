import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ipHash } from "../src/routes/feedback";
import { api } from "./helpers";

const post = (body: unknown, ip?: string, headers: Record<string, string> = {}) =>
  api("/feedback", {
    method: "POST",
    body,
    headers: { ...(ip ? { "cf-connecting-ip": ip } : {}), ...headers },
  });
const valid = (text: string) => ({ feedback: { body: text, path: "/#/" } });

describe("POST /api/feedback", () => {
  it("stores feedback with an IP hash only and answers the 4th request in 10 minutes with 429", async () => {
    for (let i = 0; i < 3; i++)
      expect((await post(valid(`fb ${i}`), "203.0.113.7")).status).toBe(201);
    const fourth = await post(valid("fb 3"), "203.0.113.7");
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ errors: { feedback: ["too many requests"] } });
    expect((await post(valid("other ip"), "203.0.113.8")).status).toBe(201);
    const rows = await env.DB.prepare("SELECT * FROM feedback").all<Record<string, unknown>>();
    expect(JSON.stringify(rows.results)).not.toContain("203.0.113.7");
    const hash = await ipHash("203.0.113.7", env.INTAKE_TOKEN);
    expect(rows.results.filter((r) => r.ip_hash === hash)).toHaveLength(3);
  });

  it("forgets requests older than 10 minutes", async () => {
    const hash = await ipHash("198.51.100.9", env.INTAKE_TOKEN);
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await env.DB.batch(
      [0, 1, 2].map((i) =>
        env.DB.prepare(
          "INSERT INTO feedback (body, path, ip_hash, created_at) VALUES (?, '/', ?, ?)",
        ).bind(`old ${i}`, hash, old),
      ),
    );
    expect((await post(valid("new"), "198.51.100.9")).status).toBe(201);
  });

  it("puts requests without CF-Connecting-IP into one shared bucket", async () => {
    for (let i = 0; i < 3; i++) expect((await post(valid(`anon ${i}`))).status).toBe(201);
    expect((await post(valid("anon 3"))).status).toBe(429);
  });

  it("accepts exactly 2000 characters, trims the body and defaults the path to /", async () => {
    const res = await post({ feedback: { body: ` ${"가".repeat(2000)} ` } }, "192.0.2.1");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ feedback: { received: true } });
    const row = await env.DB.prepare("SELECT body, path FROM feedback WHERE ip_hash = ?")
      .bind(await ipHash("192.0.2.1", env.INTAKE_TOKEN))
      .first<{ body: string; path: string }>();
    expect(row).toEqual({ body: "가".repeat(2000), path: "/" });
  });

  it("ignores the Authorization header (anonymous)", async () => {
    const res = await post(valid("with bogus auth"), "192.0.2.50", {
      authorization: "Token not-a-real-token",
    });
    expect(res.status).toBe(201);
  });

  it("accepts a hash-only path", async () => {
    expect((await post({ feedback: { body: "x", path: "#/x" } }, "192.0.2.51")).status).toBe(201);
  });

  it("rejects a request larger than the size cap before parsing it", async () => {
    const res = await post({ feedback: { body: "x".repeat(20_000) } }, "192.0.2.52");
    expect(res.status).toBe(422);
    expect(Object.keys(((await res.json()) as { errors: object }).errors)).toEqual(["body"]);
  });

  it.each([
    [{ feedback: { body: "" } }, "body"],
    [{ feedback: { body: "   " } }, "body"],
    [{ feedback: { body: "x".repeat(2001) } }, "body"],
    [{ feedback: { body: "x", path: "/".repeat(201) } }, "path"],
    [{ feedback: { body: "x", path: 5 } }, "path"],
    [{ feedback: { body: "x", path: "evil" } }, "path"],
    [{ feedback: { body: "x", path: "" } }, "path"],
    [{ feedback: { body: 5 } }, "body"],
    [{ body: "x" }, "body"],
  ])("rejects %j with 422 on %s", async (body, field) => {
    const res = await post(body, "192.0.2.99");
    expect(res.status).toBe(422);
    expect(Object.keys(((await res.json()) as { errors: Record<string, unknown> }).errors)).toEqual(
      [field],
    );
  });

  it("rejects malformed JSON with 422", async () => {
    const res = await api("/feedback", { method: "POST", rawBody: "{nope", headers: {} });
    expect(res.status).toBe(422);
  });

  it("answers with a distinct 429 once 50 rows exist for the UTC day, across IPs", async () => {
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 50 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO feedback (body, path, ip_hash, created_at) VALUES (?, '/', ?, ?)",
        ).bind(`cap ${i}`, `h${i}`, now),
      ),
    );
    const res = await post(valid("over cap"), "192.0.2.200");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ errors: { feedback: ["daily limit reached"] } });
    await env.DB.prepare("DELETE FROM feedback").run();
  });
});
