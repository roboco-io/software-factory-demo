import type { EngineName } from "./types";

// 에이전트·검사 하위 프로세스에 넘기지 않는 값. 엔진 키는 해당 엔진 어댑터만 keep으로 받는다.
export const SECRET_ENV = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "FACTORY_TOKEN",
  "FACTORY_APP_ID",
  "FACTORY_APP_PRIVATE_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "JWT_SECRET",
  "JWT_SECRET_PREVIEW",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

export const ENGINE_KEYS: Record<EngineName, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "CODEX_API_KEY",
  pi: "DEEPSEEK_API_KEY",
};

export function scrubEnv(
  base: NodeJS.ProcessEnv | Record<string, string | undefined>,
  keep: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    // INPUT_*는 액션 입력(예: App 개인 키), ACTIONS_*는 러너 런타임·OIDC 토큰이다.
    // 목록에 없는 이름도 패턴으로 제거한다(fail-closed).
    const secret =
      (SECRET_ENV as readonly string[]).includes(key) ||
      /^(INPUT_|ACTIONS_|AWS_|CLOUDFLARE_|CF_)/.test(key) ||
      /(TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|API[_-]?KEY|CREDENTIAL)/i.test(key);
    if (secret && !keep.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
