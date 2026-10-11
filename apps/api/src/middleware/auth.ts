import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { tokenInvalid, tokenMissing } from "../lib/errors";
import { readToken } from "../lib/token";

export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const r = await readToken(c.req.header("authorization"), c.env.JWT_SECRET);
  c.set("userId", typeof r === "number" ? r : null);
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const r = await readToken(c.req.header("authorization"), c.env.JWT_SECRET);
  if (r === null) throw tokenMissing();
  if (r === "invalid") throw tokenInvalid();
  c.set("userId", r);
  await next();
};

export function authedUserId(c: Context<AppEnv>): number {
  const id = c.get("userId");
  if (id === null) throw tokenMissing();
  return id;
}
