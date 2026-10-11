import type { SpawnFn } from "./process";

export const CHECK_SCRIPTS = ["typecheck", "lint", "test"] as const;

export interface CheckResult {
  name: string;
  ok: boolean;
  output: string;
}

export interface ChecksOutcome {
  ok: boolean;
  results: CheckResult[];
}

export function tail(s: string, n = 4000): string {
  return s.length <= n ? s : `...(앞부분 생략)\n${s.slice(-n)}`;
}

// 세 검사를 모두 실행한다(fix 에이전트가 실패를 한 번에 보게 하려고).
export async function runChecks(
  spawnFn: SpawnFn,
  cwd: string,
  env: Record<string, string>,
): Promise<ChecksOutcome> {
  const results: CheckResult[] = [];
  for (const script of CHECK_SCRIPTS) {
    const r = await spawnFn("pnpm", [script], { cwd, env });
    results.push({
      name: script,
      ok: r.code === 0,
      output: tail(`${r.stdout}\n${r.stderr}`.trim()),
    });
  }
  return { ok: results.every((r) => r.ok), results };
}

export function formatCheckFailures(results: CheckResult[]): string {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return "(실패한 검사 없음)";
  return failed.map((r) => `### pnpm ${r.name} 실패\n\n\`\`\`\n${r.output}\n\`\`\``).join("\n\n");
}
