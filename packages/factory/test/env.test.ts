import { describe, expect, it } from "vitest";
import { ENGINE_KEYS, scrubEnv } from "../src/agents/env";

const base = {
  PATH: "/usr/bin",
  HOME: "/home/runner",
  GITHUB_TOKEN: "ghs_x",
  GH_TOKEN: "ghs_y",
  FACTORY_TOKEN: "ghs_z",
  FACTORY_APP_PRIVATE_KEY: "-----BEGIN",
  "INPUT_PRIVATE-KEY": "-----BEGIN",
  ACTIONS_RUNTIME_TOKEN: "rt",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
  CLOUDFLARE_API_TOKEN: "cf",
  JWT_SECRET_PREVIEW: "jwt",
  ANTHROPIC_API_KEY: "sk-ant",
  CODEX_API_KEY: "sk-codex",
  DEEPSEEK_API_KEY: "sk-ds",
  UNDEFINED_VALUE: undefined,
};

describe("scrubEnv", () => {
  it("removes every GitHub, Actions, Cloudflare and engine secret by default", () => {
    expect(scrubEnv(base)).toEqual({ PATH: "/usr/bin", HOME: "/home/runner" });
  });

  it("keeps only the requested engine key", () => {
    const env = scrubEnv(base, [ENGINE_KEYS.claude]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("removes unlisted secret-like names but keeps ordinary variables", () => {
    const env = scrubEnv({
      NODE_AUTH_TOKEN: "a",
      CLAUDE_CODE_OAUTH_TOKEN: "b",
      GEMINI_API_KEY: "c",
      CF_API_TOKEN: "d",
      AWS_SECRET_ACCESS_KEY: "e",
      PATH: "/usr/bin",
      HOME: "/h",
      CI: "true",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", CI: "true" });
  });

  it("honors keep for pattern-matched names", () => {
    expect(scrubEnv({ GEMINI_API_KEY: "c", PATH: "p" }, ["GEMINI_API_KEY"])).toEqual({
      GEMINI_API_KEY: "c",
      PATH: "p",
    });
  });

  it("maps engines to their key variables", () => {
    expect(ENGINE_KEYS).toEqual({
      claude: "ANTHROPIC_API_KEY",
      codex: "CODEX_API_KEY",
      pi: "DEEPSEEK_API_KEY",
    });
  });
});
