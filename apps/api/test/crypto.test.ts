import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { issueToken, readToken } from "../src/lib/token";

describe("password", () => {
  it("verifies the original password and rejects others", async () => {
    const stored = await hashPassword("password123");
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("password123", stored)).toBe(true);
    expect(await verifyPassword("password124", stored)).toBe(false);
  });

  it("uses a random salt", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("returns false for malformed stored values", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("token", () => {
  const secret = "s3cret";

  it("round-trips a user id with Token and Bearer prefixes", async () => {
    const t = await issueToken(42, secret);
    expect(await readToken(`Token ${t}`, secret)).toBe(42);
    expect(await readToken(`Bearer ${t}`, secret)).toBe(42);
  });

  it("returns null when header is absent", async () => {
    expect(await readToken(undefined, secret)).toBeNull();
  });

  it("returns invalid for wrong secret, missing prefix, garbage, expired", async () => {
    const t = await issueToken(1, secret);
    expect(await readToken(`Token ${t}`, "other")).toBe("invalid");
    expect(await readToken(t, secret)).toBe("invalid");
    expect(await readToken("Token abc.def.ghi", secret)).toBe("invalid");
    const old = await issueToken(1, secret, Date.now() - 31 * 24 * 3600 * 1000);
    expect(await readToken(`Token ${old}`, secret)).toBe("invalid");
  });
});
