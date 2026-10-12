import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

describe("GET /tags prefix", () => {
  it("returns only tags starting with prefix, sorted", async () => {
    const a = await register("tp");
    await api("/articles", {
      method: "POST",
      token: a.token,
      body: {
        article: {
          title: "TP",
          description: "d",
          body: "b",
          tagList: ["re-b", "re-a", "xx-other"],
        },
      },
    });
    const res = await api("/tags?prefix=re-");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tags: string[] }).tags).toEqual(["re-a", "re-b"]);
  });

  it("matches tags by an emoji prefix", async () => {
    const a = await register("tpe");
    await api("/articles", {
      method: "POST",
      token: a.token,
      body: {
        article: {
          title: "TPE",
          description: "d",
          body: "b",
          tagList: ["😀abc", "other"],
        },
      },
    });
    const res = await api(`/tags?prefix=${encodeURIComponent("😀")}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tags: string[] }).tags).toEqual(["😀abc"]);
  });

  it("rejects prefix over 20 characters", async () => {
    const res = await api(`/tags?prefix=${"a".repeat(21)}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      errors: { prefix: ["must be 20 characters or less"] },
    });
  });

  it("accepts a 20 character prefix", async () => {
    const res = await api(`/tags?prefix=${"a".repeat(20)}`);
    expect(res.status).toBe(200);
  });
});
