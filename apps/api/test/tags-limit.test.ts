import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

async function seed() {
  const a = await register("tl");
  await api("/articles", {
    method: "POST",
    token: a.token,
    body: {
      article: { title: "TL", description: "d", body: "b", tagList: ["tl-c", "tl-a", "tl-b"] },
    },
  });
}

describe("GET /tags limit", () => {
  it("returns the first N tags by name", async () => {
    await seed();
    const all = ((await (await api("/tags")).json()) as { tags: string[] }).tags;
    const res = await api("/tags?limit=2");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tags: string[] }).tags).toEqual(all.slice(0, 2));
    expect(all).toEqual([...all].sort());
  });

  it.each(["0", "51", "abc", "-1", "1.5"])("rejects limit=%s", async (v) => {
    const res = await api(`/tags?limit=${v}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ errors: { limit: ["must be between 1 and 50"] } });
  });
});
