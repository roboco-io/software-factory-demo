import { createAdapter } from "./agents/registry";
import { loadAgentsConfig } from "./config/agents";
import { runProcess } from "./exec/process";
import { createGit } from "./git/port";
import { forbiddenGitHub } from "./github/forbidden";
import { createOctokitPort } from "./github/octokit";
import { loadRiskPolicy } from "./policy/risk";
import { createRunStore } from "./runs/store";
import { loadSettings, type StageDeps } from "./stages/deps";
import type { Phase } from "./stages/phased";

export function buildDeps(env: NodeJS.ProcessEnv, phase: Phase): StageDeps {
  const loaded = loadSettings(env);
  const settings = phase === "agent" ? { ...loaded, token: null } : loaded;
  const agents = loadAgentsConfig();
  const gh =
    phase === "agent"
      ? forbiddenGitHub("agent 단계에는 GitHub 토큰이 없다")
      : settings.token
        ? createOctokitPort({
            token: settings.token,
            owner: settings.owner,
            repo: settings.repo,
            excludeRunId: settings.runId,
          })
        : forbiddenGitHub("FACTORY_TOKEN 또는 GITHUB_TOKEN이 없다");
  return {
    gh,
    runs: createRunStore(gh),
    git: createGit(settings.workdir, { name: settings.botLogin, email: settings.botEmail }),
    spawn: runProcess,
    adapterFor: (engine, model) => createAdapter(engine, model, agents, env),
    agents,
    policy: loadRiskPolicy(),
    settings,
    now: () => new Date(),
    log: (msg) => console.error(msg),
  };
}
