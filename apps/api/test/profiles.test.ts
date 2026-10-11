import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

describe("GET /profiles/:username", () => {
  it("returns profile with following false, with or without auth", async () => {
    const a = await register("prof");
    for (const token of [undefined, a.token]) {
      const res = await api(`/profiles/${a.username}`, { token });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        profile: { username: a.username, bio: null, image: null, following: false },
      });
    }
  });

  it("returns 404 profile not found", async () => {
    const res = await api("/profiles/nobody-here");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ errors: { profile: ["not found"] } });
  });
});
