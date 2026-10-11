import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env";
import { ApiError } from "./lib/errors";
import { readWrapped } from "./lib/body";

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })(c, next);
});

const router = new Hono<AppEnv>();
router.get("/health", (c) => c.json({ status: "ok" }));
router.post("/_echo", async (c) => c.json({ echo: await readWrapped(c, "echo") }));

app.route("/api", router);

app.notFound((c) => c.json({ errors: { route: ["not found"] } }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ errors: err.errors }, err.status);
  console.error(err);
  return c.json({ errors: { server: ["internal error"] } }, 500);
});

export default app;
