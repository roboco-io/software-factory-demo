import { exports } from "cloudflare:workers";

export async function api(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  let body: string | undefined;
  if (init.rawBody !== undefined) {
    body = init.rawBody;
    headers["content-type"] ??= "application/json";
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  if (init.token) headers["authorization"] = `Token ${init.token}`;
  return exports.default.fetch(`https://test.local/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body,
  });
}

let seq = 0;
export async function register(
  name = "u",
): Promise<{ token: string; username: string; email: string }> {
  seq += 1;
  const username = `${name}${Date.now()}${seq}`;
  const email = `${username}@test.com`;
  const res = await api("/users", {
    method: "POST",
    body: { user: { username, email, password: "password123" } },
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const { user } = (await res.json()) as { user: { token: string } };
  return { token: user.token, username, email };
}
