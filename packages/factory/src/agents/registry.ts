import type { AgentsConfig } from "../config/agents";
import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { ENGINE_KEYS, scrubEnv } from "./env";
import { createPiAdapter } from "./pi";
import type { AgentAdapter, EngineName } from "./types";

export function createAdapter(
  engine: EngineName,
  model: string,
  agents: AgentsConfig,
  env: NodeJS.ProcessEnv,
): AgentAdapter {
  // 각 엔진에는 자기 키만 넘긴다. GitHub·Cloudflare 토큰과 다른 엔진 키는 지운다.
  const agentEnv = scrubEnv(env, [ENGINE_KEYS[engine]]);
  switch (engine) {
    case "claude":
      return createClaudeAdapter({ model, env: agentEnv });
    case "codex":
      return createCodexAdapter({ model, env: agentEnv, price: agents.engines.codex.pricePerMTok });
    case "pi":
      return createPiAdapter({ model, env: agentEnv });
  }
}
