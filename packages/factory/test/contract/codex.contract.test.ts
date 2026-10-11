import { createCodexAdapter } from "../../src/agents/codex";
import { ENGINE_KEYS, scrubEnv } from "../../src/agents/env";
import { defineContract } from "./cases";

defineContract("codex", () =>
  createCodexAdapter({
    model: process.env.CODEX_MODEL || "gpt-6.1-sol",
    env: scrubEnv(process.env, [ENGINE_KEYS.codex]),
    price: null,
  }),
);
