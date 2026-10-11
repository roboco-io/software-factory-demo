import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env";
import { ApiError } from "./lib/errors";
import { deferredRouter } from "./routes/deferred";
import { profilesRouter } from "./routes/profiles";
import { usersRouter } from "./routes/users";

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
router.route("/", deferredRouter);
router.route("/", usersRouter);
router.route("/", profilesRouter);

app.route("/api", router);

app.notFound((c) => c.json({ errors: { route: ["not found"] } }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ errors: err.errors }, err.status);
  const msg = String((err as { cause?: unknown }).cause ?? err.message);
  const unique = /UNIQUE constraint failed: users\.(email|username)/.exec(msg);
  if (unique) return c.json({ errors: { [unique[1]!]: ["has already been taken"] } }, 409);
  console.error(err);
  return c.json({ errors: { server: ["internal error"] } }, 500);
});

export default app;
