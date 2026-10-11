import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { HonoRequest } from "hono/request";
import app from "../src/index";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { constantTimeEqual, requireIntakeToken } from "../src/middleware/intake";
import { api } from "./helpers";

const TOKEN = "test-intake-token";
const PROBE_PATH = "/api/_factory/intake/probe";
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

type ErrorRow = { fingerprint: string; message: string; path: string; count: number };
type Pending = {
  errors: (ErrorRow & { firstSeen: string; lastSeen: string })[];
  feedback: { id: number; body: string; path: string; createdAt: string }[];
};

// onError는 기록을 waitUntil로 넘긴다. 응답 뒤에 끝나므로 행이 생길 때까지 기다린다.
async function eventually<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  for (let i = 0; i < 60; i++) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for the error recorder");
}

const probeRow = (minCount: number) =>
  eventually(async () => {
    const row = await env.DB.prepare(
      "SELECT fingerprint, message, path, count FROM error_events WHERE path = ?",
    )
      .bind(PROBE_PATH)
      .first<ErrorRow>();
    return row && row.count >= minCount ? row : null;
  });
const probeCount = async () =>
  (
    await env.DB.prepare("SELECT count FROM error_events WHERE path = ?")
      .bind(PROBE_PATH)
      .first<{ count: number }>()
  )?.count ?? 0;
// 새 probe 한 번이 기록될 때까지 기다린 뒤 그 행을 돌려준다(저장소는 테스트 사이에 공유된다).
const probeAndRecord = async () => {
  const prior = await probeCount();
  await probe();
  return probeRow(prior + 1);
};
const probe = () => api("/_factory/intake/probe", { method: "POST", headers: auth() });
const pending = async (): Promise<Pending> => {
  const res = await api("/_factory/intake", { headers: auth() });
  return res.json<Pending>();
};

describe("intake endpoints", () => {
  it("answer exactly like an unknown route when the token is missing, wrong or malformed", async () => {
    const unknown = await api("/nope");
    const expected = {
      status: unknown.status,
      contentType: unknown.headers.get("content-type"),
      body: await unknown.json(),
    };
    const variants: (Record<string, string> | undefined)[] = [
      undefined,
      auth("wrong"),
      auth(`${TOKEN}x`),
      { authorization: `Token ${TOKEN}` },
      { authorization: "Bearer " },
    ];
    const calls = [
      ["GET", "/_factory/intake", undefined],
      ["POST", "/_factory/intake/ack", { errors: [], feedback: [] }],
      ["POST", "/_factory/intake/probe", undefined],
    ] as const;
    for (const headers of variants) {
      for (const [method, path, body] of calls) {
        const res = await api(path, { method, headers, body });
        expect(
          {
            status: res.status,
            contentType: res.headers.get("content-type"),
            body: await res.json(),
          },
          `${method} ${path}`,
        ).toEqual(expected);
      }
    }
  });

  it("let nothing through when the Worker has no INTAKE_TOKEN (preview, local)", async () => {
    const mini = new Hono<AppEnv>().get("/x", requireIntakeToken, (c) => c.text("ok"));
    const base = { DB: env.DB, JWT_SECRET: "x", ALLOWED_ORIGINS: "" };
    for (const authorization of ["Bearer ", "Bearer x", ""]) {
      const res = await mini.request(
        "/x",
        { headers: { authorization } },
        { ...base, INTAKE_TOKEN: "" },
      );
      expect(res.status).toBe(404);
    }
    expect((await mini.request("/x", { headers: auth() }, base)).status).toBe(404);
    const ok = await mini.request("/x", { headers: auth() }, { ...base, INTAKE_TOKEN: TOKEN });
    expect(await ok.text()).toBe("ok");
  });

  it("compares tokens by value", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("records an unhandled error from onError and counts repeats under one fingerprint", async () => {
    const res = await probe();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ errors: { server: ["internal error"] } });
    const first = await probeRow(1);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(first.message).toBe(
      "Error: factory intake probe: deliberate error for intake verification",
    );
    await probe();
    expect((await probeRow(2)).fingerprint).toBe(first.fingerprint);
  });

  it("does not record RealWorld 4xx errors", async () => {
    expect((await api("/articles/ghost-slug")).status).toBe(404);
    expect((await api("/users", { method: "POST", rawBody: "{" })).status).toBe(422);
    await probe();
    await probeRow(1);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM error_events WHERE path <> ?")
      .bind(PROBE_PATH)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("lists pending errors and feedback without ip_hash, acks them, and lists an error again after it recurs", async () => {
    const { fingerprint: fp, count: before } = await probeAndRecord();
    const sent = await api("/feedback", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.50" },
      body: { feedback: { body: "버튼이 안 눌려요", path: "/#/editor" } },
    });
    expect(sent.status).toBe(201);
    const list = await pending();
    expect(list.errors.find((e) => e.fingerprint === fp)).toMatchObject({
      count: before,
      path: PROBE_PATH,
    });
    const item = list.feedback.find((f) => f.body === "버튼이 안 눌려요");
    if (!item) throw new Error("feedback item missing from the list");
    expect(Object.keys(item).sort()).toEqual(["body", "createdAt", "id", "path"]);
    const ack = await api("/_factory/intake/ack", {
      method: "POST",
      headers: auth(),
      body: {
        errors: [
          { fingerprint: fp, lastSeen: list.errors.find((e) => e.fingerprint === fp)!.lastSeen },
        ],
        feedback: [item.id],
      },
    });
    expect(await ack.json()).toEqual({ acked: { errors: 1, feedback: 1 } });
    const after = await pending();
    expect(after.errors.map((e) => e.fingerprint)).not.toContain(fp);
    expect(after.feedback.map((f) => f.id)).not.toContain(item.id);
    await probeAndRecord();
    expect((await pending()).errors.find((e) => e.fingerprint === fp)?.count).toBe(before + 1);
  });

  it("keeps an error pending when it recurred after the client read it (ack carries the lastSeen it read)", async () => {
    const { fingerprint: fp } = await probeAndRecord();
    const read = (await pending()).errors.find((e) => e.fingerprint === fp)!;
    const prior = await probeCount();
    await new Promise((r) => setTimeout(r, 5));
    await probe();
    await probeRow(prior + 1);
    const ack = await api("/_factory/intake/ack", {
      method: "POST",
      headers: auth(),
      body: { errors: [{ fingerprint: fp, lastSeen: read.lastSeen }] },
    });
    expect(ack.status).toBe(200);
    const again = (await pending()).errors.find((e) => e.fingerprint === fp);
    expect(again?.count).toBe(prior + 1);
    expect((again?.lastSeen ?? "") > read.lastSeen).toBe(true);
  });

  it("returns at most 25 feedback items per call", async () => {
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 30 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO feedback (body, path, ip_hash, created_at) VALUES (?, '/', 'h', ?)",
        ).bind(`bulk ${i}`, now),
      ),
    );
    expect((await pending()).feedback).toHaveLength(25);
  });

  it("rejects malformed ack bodies with 422 once the token is valid", async () => {
    for (const body of [
      { errors: ["XYZ"] },
      { errors: ["0".repeat(16)] },
      { errors: [{ fingerprint: "XYZ", lastSeen: "2026-10-12T00:00:00.000Z" }] },
      { errors: [{ fingerprint: "0".repeat(16) }] },
      { errors: [{ fingerprint: "0".repeat(16), lastSeen: 5 }] },
      {
        errors: Array.from({ length: 51 }, () => ({
          fingerprint: "0".repeat(16),
          lastSeen: "2026-10-12T00:00:00.000Z",
        })),
      },
      { feedback: [0] },
      { feedback: ["1"] },
      [1],
    ]) {
      const res = await api("/_factory/intake/ack", { method: "POST", headers: auth(), body });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("still records the error when reading c.req.routePath throws (falls back to {unmatched})", async () => {
    // 같은 fingerprint의 기존 행은 경로를 갱신하지 않으므로 먼저 지운다.
    await env.DB.prepare("DELETE FROM error_events WHERE path = ?").bind(PROBE_PATH).run();
    const spy = vi.spyOn(HonoRequest.prototype, "routePath", "get").mockImplementation(() => {
      throw new Error("routePath unavailable");
    });
    const pendingWork: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void pendingWork.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    try {
      const res = await app.request(
        "/api/_factory/intake/probe",
        { method: "POST", headers: auth() },
        { ...env, INTAKE_TOKEN: TOKEN },
        ctx,
      );
      expect(res.status).toBe(500);
      await Promise.all(pendingWork);
    } finally {
      spy.mockRestore();
    }
    expect(pendingWork).toHaveLength(1);
    const row = await env.DB.prepare("SELECT 1 AS x FROM error_events WHERE path = ?")
      .bind("{unmatched}")
      .first();
    expect(row).not.toBeNull();
  });
});
