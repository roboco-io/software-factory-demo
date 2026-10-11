import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import * as schema from "./schema";

export const db = (env: Env) => drizzle(env.DB, { schema });
export type Db = ReturnType<typeof db>;
