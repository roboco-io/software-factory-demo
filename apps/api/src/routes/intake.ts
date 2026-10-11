import { and, asc, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { errorEvents, feedback } from "../db/schema";
import type { AppEnv } from "../env";
import { invalid } from "../lib/errors";
import { requireIntakeToken } from "../middleware/intake";

export const INTAKE_PAGE = 25;
// D1은 쿼리당 바운드 파라미터 100개까지다. 목록당 50개로 제한하므로 한 문장에 최대 50개가 바인딩된다.
export const ACK_MAX = 50;
const FINGERPRINT = /^[0-9a-f]{16}$/;

// 미들웨어는 라우트마다 붙인다. 이 라우터는 "/"에 붙으므로 use("*")를 쓰면 모든 /api 경로에 걸린다.
export const intakeRouter = new Hono<AppEnv>();

function stringList(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > ACK_MAX) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !FINGERPRINT.test(x)) return null;
    out.push(x);
  }
  return out;
}

function idList(v: unknown): number[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > ACK_MAX) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) return null;
    out.push(x);
  }
  return out;
}

intakeRouter.get("/_factory/intake", requireIntakeToken, async (c) => {
  const d = db(c.env);
  const errors = await d
    .select()
    .from(errorEvents)
    .where(or(isNull(errorEvents.ackedAt), gt(errorEvents.lastSeen, errorEvents.ackedAt)))
    .orderBy(asc(errorEvents.lastSeen))
    .limit(INTAKE_PAGE);
  const items = await d
    .select()
    .from(feedback)
    .where(isNull(feedback.ackedAt))
    .orderBy(asc(feedback.id))
    .limit(INTAKE_PAGE);
  return c.json({
    errors: errors.map((e) => ({
      fingerprint: e.fingerprint,
      message: e.message,
      path: e.path,
      count: e.count,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
    })),
    feedback: items.map((f) => ({ id: f.id, body: f.body, path: f.path, createdAt: f.createdAt })),
  });
});

intakeRouter.post("/_factory/intake/ack", requireIntakeToken, async (c) => {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw invalid("body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("body");
  const fps = stringList("errors" in parsed ? parsed.errors : undefined);
  if (fps === null) throw invalid("errors");
  const ids = idList("feedback" in parsed ? parsed.feedback : undefined);
  if (ids === null) throw invalid("feedback");
  const d = db(c.env);
  if (fps.length > 0) {
    // ack 이후 다시 발생하면 last_seen이 acked_at보다 커져 목록에 다시 나온다.
    await d
      .update(errorEvents)
      .set({ ackedAt: sql`${errorEvents.lastSeen}` })
      .where(inArray(errorEvents.fingerprint, fps));
  }
  if (ids.length > 0) {
    await d
      .update(feedback)
      .set({ ackedAt: new Date().toISOString() })
      .where(and(inArray(feedback.id, ids), isNull(feedback.ackedAt)));
  }
  return c.json({ acked: { errors: fps.length, feedback: ids.length } });
});

// 라이브 검증용 오류 주입(판정 후보 4). 토큰이 맞을 때만 의도적 예외를 던지고, onError가 error_events에 기록한다.
intakeRouter.post("/_factory/intake/probe", requireIntakeToken, () => {
  throw new Error("factory intake probe: deliberate error for intake verification");
});
