import type { Context } from "hono";
import { blank, invalid } from "./errors";

export async function readWrapped<T>(c: Context, key: string): Promise<Partial<T>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw invalid("body");
  }
  if (typeof parsed !== "object" || parsed === null) throw invalid("body");
  const inner = (parsed as Record<string, unknown>)[key];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) throw invalid("body");
  return inner as Partial<T>;
}

/** 필수 문자열 필드. 없거나 문자열이 아니거나 공백뿐이면 422 "can't be blank". */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw blank(field);
  return value;
}
