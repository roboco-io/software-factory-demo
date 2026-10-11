import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { errorFingerprint, normalizeText, recordError, topFrames } from "../src/lib/error-events";

const STACK_A =
  "Error: x\n    at a (file.js:10:5)\n    at b (file.js:20:7)\n    at c (file.js:30:9)";
const STACK_B =
  "Error: x\n    at z (other.js:1:1)\n    at y (other.js:2:2)\n    at w (other.js:3:3)";

// V8은 await 뒤의 프레임에 `async`를 붙이므로 stack을 고정해 테스트를 결정적으로 만든다.
const make = (message: string, stack: string = STACK_A) => {
  const e = new Error(message);
  e.stack = stack;
  return e;
};

describe("normalizeText", () => {
  it("replaces UUIDs, slugs and numbers", () => {
    expect(
      normalizeText("article hello-world-ab12cd id 42 user 0b5e7a3c-1f2d-4e5f-8a9b-0c1d2e3f4a5b"),
    ).toBe("article {slug} id {n} user {uuid}");
  });

  it("leaves ordinary words alone", () => {
    expect(normalizeText("UNIQUE constraint failed: users.email")).toBe(
      "UNIQUE constraint failed: users.email",
    );
  });
});

describe("topFrames", () => {
  it("keeps the top three frames without line and column", () => {
    const stack = [
      "Error: x",
      "    at a (file.js:10:5)",
      "    at b (file.js:20:7)",
      "    at file.js:30:9",
      "    at d (file.js:40:1)",
    ].join("\n");
    expect(topFrames(stack)).toEqual(["at a (file.js)", "at b (file.js)", "at file.js"]);
    expect(topFrames(undefined)).toEqual([]);
  });

  it("rewrites a leading `at async ` to `at `", () => {
    const stack = [
      "Error: x",
      "    at async runner (file.js:1:2)",
      "    at async file.js:3:4",
    ].join("\n");
    expect(topFrames(stack)).toEqual(["at runner (file.js)", "at file.js"]);
  });
});

describe("errorFingerprint", () => {
  it("is 16 hex chars and ignores numbers in the message", async () => {
    const a = await errorFingerprint(make("article 12 not found"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await errorFingerprint(make("article 99 not found"))).toBe(a);
    expect(await errorFingerprint(make("other failure"))).not.toBe(a);
  });

  it("is the same with or without V8 async frame markers", async () => {
    const asyncStack = STACK_A.replaceAll("    at ", "    at async ");
    expect(await errorFingerprint(make("same", asyncStack))).toBe(
      await errorFingerprint(make("same", STACK_A)),
    );
  });

  it("differs when the error comes from a different place", async () => {
    expect(await errorFingerprint(make("same", STACK_A))).not.toBe(
      await errorFingerprint(make("same", STACK_B)),
    );
  });
});

describe("recordError", () => {
  it("upserts by fingerprint, counting repeats and keeping the first normalized message and path", async () => {
    const first = make("article 5 failed");
    const fp = await errorFingerprint(first);
    await recordError(
      env,
      first,
      "/api/articles/hello-ab12cd/comments/5",
      new Date("2026-10-12T00:00:00.000Z"),
    );
    await recordError(
      env,
      make("article 6 failed"),
      "/api/other",
      new Date("2026-10-12T00:05:00.000Z"),
    );
    const row = await env.DB.prepare(
      "SELECT fingerprint, message, path, count, first_seen, last_seen, acked_at FROM error_events WHERE fingerprint = ?",
    )
      .bind(fp)
      .first();
    expect(row).toEqual({
      fingerprint: fp,
      message: "Error: article {n} failed",
      path: "/api/articles/{slug}/comments/{n}",
      count: 2,
      first_seen: "2026-10-12T00:00:00.000Z",
      last_seen: "2026-10-12T00:05:00.000Z",
      acked_at: null,
    });
  });

  it("truncates long messages to 500 characters", async () => {
    const err = make("x".repeat(3000));
    await recordError(env, err, "/api/x");
    const row = await env.DB.prepare("SELECT message FROM error_events WHERE fingerprint = ?")
      .bind(await errorFingerprint(err))
      .first<{ message: string }>();
    expect(row?.message.length).toBe(500);
  });
});
