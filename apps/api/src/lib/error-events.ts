import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { errorEvents } from "../db/schema";
import type { Env } from "../env";
import { sha256Hex } from "./hash";

export const MESSAGE_MAX = 500;
export const PATH_MAX = 200;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// slugify()(src/lib/slug.ts)가 만드는 형식: 하이픈으로 이은 소문자·숫자 단어 + 6자 접미사.
const SLUG = /\b[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{6}\b/g;
const NUMBER = /\d+/g;

export function normalizeText(s: string): string {
  return s.replace(UUID, "{uuid}").replace(SLUG, "{slug}").replace(NUMBER, "{n}");
}

// 배포마다 번들의 줄·열이 바뀌므로 위치는 지우고 함수·파일만 남긴다.
// V8은 await 뒤의 프레임에 `async`를 붙이므로(`at async f`) 앞의 `async `도 지운다.
export function topFrames(stack: string | undefined, n = 3): string[] {
  return (stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, n)
    .map((l) => l.replace(/^at async /, "at ").replace(/:\d+:\d+(\)?)$/, "$1"));
}

export async function errorFingerprint(err: Error): Promise<string> {
  const head = normalizeText(`${err.name}: ${err.message}`);
  return (await sha256Hex([head, ...topFrames(err.stack)].join("\n"))).slice(0, 16);
}

// spec 7.1.3. 호출하는 쪽(onError)이 ctx.waitUntil로 넘기고 실패를 무시한다.
export async function recordError(
  env: Env,
  err: Error,
  pathname: string,
  now: Date = new Date(),
): Promise<void> {
  const ts = now.toISOString();
  await db(env)
    .insert(errorEvents)
    .values({
      fingerprint: await errorFingerprint(err),
      message: normalizeText(`${err.name}: ${err.message}`).slice(0, MESSAGE_MAX),
      path: normalizeText(pathname).slice(0, PATH_MAX),
      count: 1,
      firstSeen: ts,
      lastSeen: ts,
    })
    .onConflictDoUpdate({
      target: errorEvents.fingerprint,
      set: { count: sql`${errorEvents.count} + 1`, lastSeen: ts },
    });
}
