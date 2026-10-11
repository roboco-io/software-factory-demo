export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
  ALLOWED_ORIGINS: string;
};

export type AppEnv = {
  Bindings: Env;
  Variables: { userId: number | null };
};
