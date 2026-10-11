import { sign, verify } from "hono/jwt";

const TTL_SECONDS = 30 * 24 * 3600;

export async function issueToken(
  userId: number,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000);
  return sign({ sub: String(userId), iat, exp: iat + TTL_SECONDS }, secret, "HS256");
}

export async function readToken(
  header: string | undefined,
  secret: string,
): Promise<number | null | "invalid"> {
  if (header === undefined || header === "") return null;
  const match = /^(?:Token|Bearer) (\S+)$/.exec(header);
  if (!match) return "invalid";
  try {
    const payload = await verify(match[1]!, secret, "HS256");
    const id = Number(payload.sub);
    return Number.isInteger(id) && id > 0 ? id : "invalid";
  } catch {
    return "invalid";
  }
}
