import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  ERROR_EVENTS_CAP,
  errorFingerprint,
  normalizeText,
  recordError,
  topFrames,
} from "../src/lib/error-events";

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

describe("normalizeText masking", () => {
  it("masks quoted spans, emails, JWTs and long runs", () => {
    expect(normalizeText(`bad "pw: hunter2" and 'x@y.z' end`)).toBe("bad {str} and {str} end");
    expect(normalizeText("user bob@example.com failed")).toBe("user {email} failed");
    expect(normalizeText("jwt eyJhbGciOi.eyJzdWIiOjF9.sig_n-1 bad")).toBe("jwt {token} bad");
    expect(normalizeText("hash deadbeefdeadbeefdeadbeefdeadbeef x")).toBe("hash {token} x");
    expect(normalizeText("user 0b5e7a3c-1f2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe("user {uuid}");
  });

  it("leaves no raw values from a JSON parse error", () => {
    const out = normalizeText(
      `Unexpected token } in JSON at position 31: {"email":"a@b.co","password":"s3cretvalue"`,
    );
    expect(out).not.toMatch(/a@b|s3cret|password|email"/);
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

  it("strips a line number without a column", () => {
    expect(topFrames("Error: x\n    at a (file.js:10)\n    at file.js:11")).toEqual([
      "at a (file.js)",
      "at file.js",
    ]);
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

  it("gives two different malformed bodies the same fingerprint", async () => {
    const a = await errorFingerprint(make(`Bad JSON: {"email":"a@b.co","password":"one"`));
    const b = await errorFingerprint(make(`Bad JSON: {"email":"c@d.io","password":"two22"`));
    expect(a).toBe(b);
  });

  it("includes the error name and a nostack marker for stackless errors", async () => {
    const t = new TypeError("boom");
    t.stack = undefined;
    const e = new RangeError("boom");
    e.stack = undefined;
    expect(await errorFingerprint(t)).not.toBe(await errorFingerprint(e));
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
      "/api/articles/:slug/comments/:id/ref/5",
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
      path: "/api/articles/:slug/comments/:id/ref/{n}",
      count: 2,
      first_seen: "2026-10-12T00:00:00.000Z",
      last_seen: "2026-10-12T00:05:00.000Z",
      acked_at: null,
    });
  });

  it("truncates long messages to 500 characters", async () => {
    const err = make("word ".repeat(600));
    await recordError(env, err, "/api/x");
    const row = await env.DB.prepare("SELECT message FROM error_events WHERE fingerprint = ?")
      .bind(await errorFingerprint(err))
      .first<{ message: string }>();
    expect(row?.message.length).toBe(500);
  });

  it("never rejects and logs only the fingerprint", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = make("secret-ish message");
    await expect(recordError({ DB: undefined } as never, err, "/x")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-ish");
    spy.mockRestore();
  });

  it("stops inserting new fingerprints at the cap but still upserts existing ones", async () => {
    expect(ERROR_EVENTS_CAP).toBe(500);
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM error_events WHERE acked_at IS NULL OR acked_at < last_seen",
        ).first<{ c: number }>()
      )!.c;
    const existing = make("cap existing");
    await recordError(env, existing, "/p");
    const n = await count();
    await recordError(env, make("cap brand new"), "/p", new Date(), n);
    expect(await count()).toBe(n);
    await recordError(env, existing, "/p", new Date(), n);
    const row = await env.DB.prepare("SELECT count FROM error_events WHERE fingerprint = ?")
      .bind(await errorFingerprint(existing))
      .first<{ count: number }>();
    expect(row?.count).toBe(2);
    await recordError(env, make("cap brand new"), "/p", new Date(), n + 1);
    expect(await count()).toBe(n + 1);
  });

  it("counts only unacked rows toward the cap", async () => {
    await recordError(env, make("cap acked seed"), "/p");
    await env.DB.prepare("UPDATE error_events SET acked_at = last_seen").run();
    const fresh = make("cap after ack");
    await recordError(env, fresh, "/p", new Date(), 1);
    const row = await env.DB.prepare("SELECT count FROM error_events WHERE fingerprint = ?")
      .bind(await errorFingerprint(fresh))
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
    // 이제 미확인 행이 1개이므로 cap 1에서 또 다른 새 fingerprint는 막힌다.
    const blocked = make("cap blocked");
    await recordError(env, blocked, "/p", new Date(), 1);
    expect(
      await env.DB.prepare("SELECT 1 AS x FROM error_events WHERE fingerprint = ?")
        .bind(await errorFingerprint(blocked))
        .first(),
    ).toBeNull();
  });
});
