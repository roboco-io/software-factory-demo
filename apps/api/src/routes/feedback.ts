import { and, count, eq, gt, gte } from "drizzle-orm";
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
// 요청 본문 상한(문자). 2000자 본문과 경로를 JSON으로 감싸도 충분히 들어가는 크기다.
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

export const feedbackRouter = new Hono<AppEnv>();

// 익명 피드백. Authorization 헤더는 읽지 않고, 본문 텍스트는 로그에 남기지 않는다.
feedbackRouter.post("/feedback", async (c) => {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > REQUEST_MAX) throw tooLong("body", FEEDBACK_BODY_MAX);
  const raw = await c.req.text();
  if (raw.length > REQUEST_MAX) throw tooLong("body", FEEDBACK_BODY_MAX);
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
  const d = db(c.env);
  const since = new Date(now.getTime() - FEEDBACK_WINDOW_MS).toISOString();
  const recent = await d
    .select({ n: count() })
    .from(feedback)
    .where(and(eq(feedback.ipHash, hash), gt(feedback.createdAt, since)))
    .get();
  // 동시에 들어온 요청은 같은 수를 읽을 수 있다. 데모 범위에서 수용한다(README 보안 한계).
  if ((recent?.n ?? 0) >= FEEDBACK_LIMIT) throw rateLimited("feedback");
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const today = await d
    .select({ n: count() })
    .from(feedback)
    .where(gte(feedback.createdAt, dayStart))
    .get();
  if ((today?.n ?? 0) >= FEEDBACK_DAILY_CAP) throw dailyLimited("feedback");
  await d.insert(feedback).values({ body, path, ipHash: hash, createdAt: now.toISOString() });
  return c.json({ feedback: { received: true } }, 201);
});
