import { describe, expect, it } from "vitest";
import { api } from "./helpers";

describe("app", () => {
  it("GET /api/health returns ok", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("unknown route returns 404 in RealWorld error format", async () => {
    const res = await api("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ errors: { route: ["not found"] } });
  });

  it("CORS allows configured origin only", async () => {
    const ok = await api("/health", { headers: { origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const ng = await api("/health", { headers: { origin: "https://evil.example" } });
    expect(ng.headers.get("access-control-allow-origin")).toBeNull();
  });
});
