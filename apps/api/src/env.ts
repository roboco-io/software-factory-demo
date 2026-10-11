export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
  ALLOWED_ORIGINS: string;
  // 프로덕션 Worker secret. deploy.yml이 GitHub production environment secret에서 넣는다. 프리뷰·로컬에는 없다.
  INTAKE_TOKEN?: string;
};

export type AppEnv = {
  Bindings: Env;
  Variables: { userId: number | null };
};
