import type { GitHubPort } from "./port";

// agent 단계(토큰 없음)에서 실수로 GitHub를 호출하면 즉시 실패시킨다.
export function forbiddenGitHub(reason: string): GitHubPort {
  return new Proxy({} as GitHubPort, {
    get(_target, prop) {
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
      return () => Promise.reject(new Error(`GitHub API 호출 거부(${String(prop)}): ${reason}`));
    },
  });
}
