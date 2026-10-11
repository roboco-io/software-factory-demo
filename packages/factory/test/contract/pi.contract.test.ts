import { ENGINE_KEYS, scrubEnv } from "../../src/agents/env";
import { createPiAdapter } from "../../src/agents/pi";
import { defineContract } from "./cases";

defineContract("pi", () =>
  createPiAdapter({
    model: process.env.PI_MODEL || "deepseek/deepseek-flash",
    env: scrubEnv(process.env, [ENGINE_KEYS.pi]),
  }),
);
