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
