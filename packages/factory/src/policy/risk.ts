import { readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { parse } from "yaml";
import { z } from "zod";
import { FACTORY_DIR } from "../paths";

export const TIERS = ["T0", "T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

const TierSchema = z.enum(TIERS);
const PolicySchema = z.object({
  default: TierSchema,
  requiredChecks: z.array(z.string().min(1)).min(1),
  rules: z
    .array(z.object({ tier: TierSchema, patterns: z.array(z.string().min(1)).min(1) }))
    .min(1),
});

export type RiskPolicy = z.infer<typeof PolicySchema>;

export interface FileTier {
  file: string;
  tier: Tier;
  pattern: string | null;
}

export interface RiskResult {
  tier: Tier;
  files: FileTier[];
}

/**
 * PR의 변경 파일 한 건. `additions`는 이 파일에서 추가된 줄의 내용(diff의 `+` 접두사 제외)이다.
 * Task 15 runRisk가 봇 implement PR의 `tests/realworld/skip.txt` 추가 줄을 금지할 때 쓴다(F21).
 * 이 Task에서는 타입과 patch 파서만 제공하고 강제는 하지 않는다.
 */
export interface ChangedFile {
  filename: string;
  previousFilename?: string;
  additions: string[];
}

/** unified diff patch에서 추가된 줄의 내용만 뽑는다. `+++` 헤더는 제외한다. */
export function addedLinesFromPatch(patch: string | undefined): string[] {
  if (!patch) return [];
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

export function parseRiskPolicy(text: string): RiskPolicy {
  return PolicySchema.parse(parse(text));
}

export function loadRiskPolicy(file = path.join(FACTORY_DIR, "risk-policy.yml")): RiskPolicy {
  return parseRiskPolicy(readFileSync(file, "utf8"));
}

export function maxTier(a: Tier, b: Tier): Tier {
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function tierOf(file: string, policy: RiskPolicy): FileTier {
  const f = normalizePath(file);
  for (const rule of policy.rules) {
    for (const pattern of rule.patterns) {
      if (picomatch.isMatch(f, pattern, { dot: true }))
        return { file: f, tier: rule.tier, pattern };
    }
  }
  return { file: f, tier: policy.default, pattern: null };
}

export function classifyFiles(files: string[], policy: RiskPolicy): RiskResult {
  const unique = [...new Set(files.map(normalizePath))].filter((f) => f.length > 0);
  const tiers = unique.map((f) => tierOf(f, policy));
  return { tier: tiers.reduce<Tier>((acc, t) => maxTier(acc, t.tier), "T0"), files: tiers };
}
