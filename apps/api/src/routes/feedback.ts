import { and, count, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { feedback } from "../db/schema";
import type { AppEnv } from "../env";
import { blank, dailyLimited, invalid, rateLimited, tooLong } from "../lib/errors";
import { sha256Hex } from "../lib/hash";

export const FEEDBACK_BODY_MAX = 2000;
export const FEEDBACK_PATH_MAX = 200;
export const FEEDBACK_LIMIT = 3;
export const FEEDBACK_WINDOW_MS = 10 * 60_000;
// 모든 IP를 합친 UTC 하루 상한. 해시를 바꿔가며 보내는 홍수를 막는다.
export const FEEDBACK_DAILY_CAP = 50;
// 요청 본문 상한(바이트). 2000자 본문과 경로를 JSON으로 감싸도 충분히 들어가는 크기다.
const REQUEST_MAX = 16_384;

// spec 7.1.3: IP 원문은 저장하지 않는다. 솔트와 함께 SHA-256한 값만 저장한다.
export function ipHash(ip: string, salt: string): Promise<string> {
  return sha256Hex(`${ip}${salt}`);
}

// 신뢰할 수 없는 JSON에서 {"feedback": {...}} 안쪽 객체만 꺼낸다. 타입 단언을 쓰지 않는다.
function unwrap(json: unknown): { body?: unknown; path?: unknown } {
  if (typeof json !== "object" || json === null) throw invalid("body");
  const inner: unknown = Reflect.get(json, "feedback");
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) throw invalid("body");
  return { body: Reflect.get(inner, "body"), path: Reflect.get(inner, "path") };
}

// 본문을 청크 단위로 읽고 REQUEST_MAX 바이트를 넘으면 즉시 멈춘다. Content-Length가 없거나 거짓이어도 메모리가 제한된다.
async function readCapped(req: Request): Promise<string> {
  const header = req.headers.get("content-length");
  if (header !== null) {
    if (!/^\d+$/.test(header)) throw tooLong("body", FEEDBACK_BODY_MAX);
    if (Number(header) > REQUEST_MAX) throw tooLong("body", FEEDBACK_BODY_MAX);
  }
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > REQUEST_MAX) {
      await reader.cancel();
      throw tooLong("body", FEEDBACK_BODY_MAX);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const feedbackRouter = new Hono<AppEnv>();

// 익명 피드백. Authorization 헤더는 읽지 않고, 본문 텍스트는 로그에 남기지 않는다.
feedbackRouter.post("/feedback", async (c) => {
  const raw = await readCapped(c.req.raw);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid("body");
  }
  const input = unwrap(json);
  const bodyValue = input.body;
  if (typeof bodyValue !== "string") throw invalid("body");
  const body = bodyValue.trim();
  if (body === "") throw blank("body");
  if (body.length > FEEDBACK_BODY_MAX) throw tooLong("body", FEEDBACK_BODY_MAX);
  let path = "/";
  if (input.path !== undefined) {
    if (typeof input.path !== "string") throw invalid("path");
    if (input.path.length > FEEDBACK_PATH_MAX) throw tooLong("path", FEEDBACK_PATH_MAX);
    if (!input.path.startsWith("/") && !input.path.startsWith("#")) throw invalid("path");
    path = input.path;
  }

  const now = new Date();
  // 프리뷰·로컬에는 INTAKE_TOKEN이 없으므로 JWT_SECRET을 솔트로 쓴다.
  const salt = c.env.INTAKE_TOKEN || c.env.JWT_SECRET;
  const hash = await ipHash(c.req.header("cf-connecting-ip") ?? "unknown", salt);
  const since = new Date(now.getTime() - FEEDBACK_WINDOW_MS).toISOString();
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  // 개수 확인과 삽입을 한 문장으로 실행해 동시 요청이 한도를 넘지 못하게 한다.
  const inserted = await c.env.DB.prepare(
    `INSERT INTO feedback (body, path, ip_hash, created_at)
     SELECT ?, ?, ?, ?
     WHERE (SELECT count(*) FROM feedback WHERE ip_hash = ? AND created_at > ?) < ?
       AND (SELECT count(*) FROM feedback WHERE created_at >= ?) < ?`,
  )
    .bind(
      body,
      path,
      hash,
      now.toISOString(),
      hash,
      since,
      FEEDBACK_LIMIT,
      dayStart,
      FEEDBACK_DAILY_CAP,
    )
    .run();
  if (inserted.meta.changes === 0) {
    // 거절 사유를 구분하려고 개수를 다시 센다.
    const d = db(c.env);
    const recent = await d
      .select({ n: count() })
      .from(feedback)
      .where(and(eq(feedback.ipHash, hash), gt(feedback.createdAt, since)))
      .get();
    if ((recent?.n ?? 0) >= FEEDBACK_LIMIT) throw rateLimited("feedback");
    throw dailyLimited("feedback");
  }
  return c.json({ feedback: { received: true } }, 201);
});
