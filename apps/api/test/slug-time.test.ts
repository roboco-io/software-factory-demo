import { describe, expect, it } from "vitest";
import { slugify } from "../src/lib/slug";
import { nextTimestamp } from "../src/lib/time";

describe("slugify", () => {
  it("lowercases, dashes non-alphanumerics, appends suffix", () => {
    expect(slugify("Hello, World!  RealWorld", () => "abc123")).toBe(
      "hello-world-realworld-abc123",
    );
  });
  it("falls back to 'article' for symbol-only titles", () => {
    expect(slugify("!!!", () => "zzzzzz")).toBe("article-zzzzzz");
  });
  it("truncates the base to 60 chars", () => {
    const s = slugify("a".repeat(100), () => "000000");
    expect(s).toBe(`${"a".repeat(60)}-000000`);
  });
  it("gives different slugs for the same title", () => {
    expect(slugify("Same")).not.toBe(slugify("Same"));
  });
});

describe("nextTimestamp", () => {
  it("returns now when later than prev", () => {
    expect(nextTimestamp("2026-01-01T00:00:00.000Z", Date.parse("2026-01-02T00:00:00.000Z"))).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });
  it("returns prev + 1ms when now is not later", () => {
    const prev = "2026-01-01T00:00:00.000Z";
    expect(nextTimestamp(prev, Date.parse(prev))).toBe("2026-01-01T00:00:00.001Z");
  });
});
