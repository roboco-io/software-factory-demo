import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

type UserBody = {
  user: {
    email: string;
    username: string;
    token: string;
    bio: string | null;
    image: string | null;
  };
};
type ErrBody = { errors: Record<string, string[]> };

describe("POST /users", () => {
  it("registers and returns user with token, bio/image null", async () => {
    const res = await api("/users", {
      method: "POST",
      body: { user: { username: "alice1", email: "alice1@test.com", password: "password123" } },
    });
    expect(res.status).toBe(201);
    const { user } = (await res.json()) as UserBody;
    expect(user).toMatchObject({
      username: "alice1",
      email: "alice1@test.com",
      bio: null,
      image: null,
    });
    expect(user.token.length).toBeGreaterThan(10);
  });

  it("rejects a 7 char password with 422 too short", async () => {
    const res = await api("/users", {
      method: "POST",
      body: { user: { username: "shortpw", email: "shortpw@test.com", password: "short7c" } },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrBody).errors["password"]).toBeDefined();
  });

  it.each(["username", "email", "password"])("rejects blank %s with 422", async (field) => {
    const user: Record<string, string> = {
      username: "b1",
      email: "b1@test.com",
      password: "password123",
    };
    user[field] = "";
    const res = await api("/users", { method: "POST", body: { user } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrBody).errors[field]).toEqual(["can't be blank"]);
  });

  it("rejects duplicate username and case-variant email with 409", async () => {
    const a = await register("dup");
    const r1 = await api("/users", {
      method: "POST",
      body: { user: { username: a.username, email: "other@test.com", password: "password123" } },
    });
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as ErrBody).errors.username).toEqual(["has already been taken"]);
    const r2 = await api("/users", {
      method: "POST",
      body: { user: { username: "fresh1", email: a.email.toUpperCase(), password: "password123" } },
    });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as ErrBody).errors.email).toEqual(["has already been taken"]);
  });

  it("returns 422 for malformed JSON and missing wrapper", async () => {
    expect((await api("/users", { method: "POST", rawBody: "{oops" })).status).toBe(422);
    expect((await api("/users", { method: "POST", body: { username: "x" } })).status).toBe(422);
  });
});

describe("POST /users/login", () => {
  it("logs in case-insensitively by email", async () => {
    const a = await register("login");
    const res = await api("/users/login", {
      method: "POST",
      body: { user: { email: a.email.toUpperCase(), password: "password123" } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as UserBody).user.username).toBe(a.username);
  });

  it("rejects wrong password and unknown email with 401 credentials invalid", async () => {
    const a = await register("login");
    for (const user of [
      { email: a.email, password: "wrong-pass" },
      { email: "nobody@test.com", password: "password123" },
    ]) {
      const res = await api("/users/login", { method: "POST", body: { user } });
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrBody).errors.credentials).toEqual(["invalid"]);
    }
  });

  it.each(["email", "password"])("rejects blank %s with 422", async (field) => {
    const user: Record<string, string> = { email: "a@test.com", password: "password123" };
    user[field] = "";
    const res = await api("/users/login", { method: "POST", body: { user } });
    expect(res.status).toBe(422);
  });
});

describe("GET/PUT /user", () => {
  it("401 token is missing without header, is invalid with bad token", async () => {
    const r1 = await api("/user");
    expect(r1.status).toBe(401);
    expect(((await r1.json()) as ErrBody).errors.token).toEqual(["is missing"]);
    const r2 = await api("/user", { token: "garbage" });
    expect(r2.status).toBe(401);
    expect(((await r2.json()) as ErrBody).errors.token).toEqual(["is invalid"]);
  });

  it("returns current user", async () => {
    const a = await register("me");
    const res = await api("/user", { token: a.token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as UserBody).user.email).toBe(a.email);
  });

  it("normalizes empty bio/image to null and accepts null", async () => {
    const a = await register("upd");
    const set = async (user: Record<string, unknown>) =>
      (
        (await (
          await api("/user", { method: "PUT", token: a.token, body: { user } })
        ).json()) as UserBody
      ).user;
    expect((await set({ bio: "hello" })).bio).toBe("hello");
    expect((await set({ bio: "" })).bio).toBeNull();
    expect((await set({ bio: "again" })).bio).toBe("again");
    expect((await set({ bio: null })).bio).toBeNull();
    expect((await set({ image: "https://x/y.png" })).image).toBe("https://x/y.png");
    expect((await set({ image: "" })).image).toBeNull();
  });

  it("rejects bio over 500 chars and accepts exactly 500", async () => {
    const a = await register("biolen");
    const put = (bio: string) =>
      api("/user", { method: "PUT", token: a.token, body: { user: { bio } } });
    const bad = await put("a".repeat(501));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ errors: { bio: ["must be 500 characters or less"] } });
    const ok = await put("b".repeat(500));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as UserBody).user.bio).toBe("b".repeat(500));
  });

  it.each([
    [{ email: "" }, "email"],
    [{ email: null }, "email"],
    [{ username: "" }, "username"],
    [{ username: null }, "username"],
    [{ password: "" }, "password"],
    [{ password: null }, "password"],
    [{ password: "short7c" }, "password"],
  ])("rejects %j with 422", async (user, field) => {
    const a = await register("bad");
    const res = await api("/user", { method: "PUT", token: a.token, body: { user } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrBody).errors[field]).toBeDefined();
  });

  it("accepts 8 and 64 char passwords, and the new password logs in", async () => {
    const a = await register("pw");
    for (const password of ["simpleww", "p".repeat(64)]) {
      const res = await api("/user", {
        method: "PUT",
        token: a.token,
        body: { user: { password } },
      });
      expect(res.status).toBe(200);
      const login = await api("/users/login", {
        method: "POST",
        body: { user: { email: a.email, password } },
      });
      expect(login.status).toBe(200);
    }
  });

  it("rejects changing username to one already taken with 409", async () => {
    const a = await register("own");
    const b = await register("other");
    const res = await api("/user", {
      method: "PUT",
      token: a.token,
      body: { user: { username: b.username } },
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /users race", () => {
  it("maps a UNIQUE race on insert to 409 instead of 500", async () => {
    const body = { user: { username: "race1", email: "race1@test.com", password: "password123" } };
    const [r1, r2] = await Promise.all([
      api("/users", { method: "POST", body }),
      api("/users", { method: "POST", body }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
  });
});
