declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
  interface Env {
    DB: D1Database;
    JWT_SECRET: string;
    ALLOWED_ORIGINS: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
