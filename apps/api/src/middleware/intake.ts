import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { ROUTE_NOT_FOUND } from "../lib/errors";

const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// 길이가 같은 두 SHA-256 다이제스트를 바이트마다 XOR해 누적한다. 입력 길이·일치 위치에 따라 비교 시간이 달라지지 않는다.
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 1);
  return diff === 0;
}

// spec 7.1.3: 토큰이 없거나 다르면 알 수 없는 경로와 같은 404(본문·헤더 동일)로 엔드포인트 존재를 드러내지 않는다.
// Worker에 INTAKE_TOKEN이 없으면(프리뷰·로컬) 어떤 요청도 통과하지 못한다.
export const requireIntakeToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.INTAKE_TOKEN ?? "";
  const m = BEARER.exec(c.req.header("authorization") ?? "");
  const presented = m?.[1];
  const ok =
    expected.length > 0 &&
    presented !== undefined &&
    (await constantTimeEqual(presented, expected));
  if (!ok) return c.json(ROUTE_NOT_FOUND, 404);
  await next();
};
