const ITERATIONS = 100_000; // Workers Web Crypto의 PBKDF2 상한
const enc = new TextEncoder();

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function derive(plain: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(plain), "PBKDF2", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const hash = await derive(plain, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > ITERATIONS) return false;
  try {
    const expected = unb64(parts[3]!);
    const actual = new Uint8Array(await derive(plain, unb64(parts[2]!), iterations));
    if (actual.length !== expected.length) return false;
    return crypto.subtle.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
