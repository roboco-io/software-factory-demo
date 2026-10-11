import { createClaudeAdapter } from "../../src/agents/claude";
import { ENGINE_KEYS, scrubEnv } from "../../src/agents/env";
import { defineContract } from "./cases";

defineContract("claude", () =>
  createClaudeAdapter({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
    env: scrubEnv(process.env, [ENGINE_KEYS.claude]),
  }),
);
