// 이 파일의 정의(무개입 완주 판정, 실패 범주 키, 표본 기준)는 packages/factory/src/report/metrics.ts 및
// packages/factory/src/stages/collect.ts(failureEvents)와 같다. 웹 앱이 Node 전용 패키지에 의존하지
// 않도록 코드를 복사했다. 한쪽을 바꾸면 다른 쪽도 같이 바꾼다.
import type { Run } from "./data";

export const MIN_SAMPLE = 5;
const AGENT_ROLES = new Set(["triage", "implement", "review", "fix", "improve"]);
const IGNORED_REASONS = ["risk_t2", "risk_t3", "permission_denied"];
const DAY_MS = 86_400_000;

// ISO 8601 주(월요일 시작, 목요일이 속한 해). UTC 기준.
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// 오래된 주부터.
export function lastWeeks(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(isoWeek(new Date(now.getTime() - i * 7 * DAY_MS)));
  return out;
}

const weekOf = (r: Run) => isoWeek(new Date(r.ts));

// implement 런이 있는 이슈 가운데 deploy 성공 기록이 있고 실패한 런이 없는 이슈의 수.
function completionOf(runs: Run[]): { k: number; n: number } {
  const implemented = new Set(
    runs.filter((r) => r.role === "implement" && r.issue > 0).map((r) => r.issue),
  );
  let k = 0;
  for (const issue of implemented) {
    const mine = runs.filter((r) => r.issue === issue);
    if (mine.some((r) => r.role === "deploy" && r.ok) && mine.every((r) => r.ok)) k++;
  }
  return { k, n: implemented.size };
}

export function weeklyCompletion(
  runs: Run[],
  weeks: string[],
): { week: string; k: number; n: number }[] {
  return weeks.map((week) => ({ week, ...completionOf(runs.filter((r) => weekOf(r) === week)) }));
}

// 런 기록이 처음 있는 주부터 자른다. 축이 너무 짧아지지 않게 마지막 두 주는 남긴다.
export function activeWeeks(runs: Run[], weeks: string[]): string[] {
  const seen = new Set(runs.map(weekOf));
  const first = weeks.findIndex((w) => seen.has(w));
  const start = first < 0 ? weeks.length - 2 : Math.min(first, weeks.length - 2);
  return weeks.slice(Math.max(0, start));
}

export interface Summary {
  deployed: number;
  completion: { k: number; n: number };
  costUsd: number;
  uncostedEngines: string[];
  improvements: number;
}

// 대시보드 상단 요약. completion은 창 전체 기준이다.
export function summary(runs: Run[], improvements: number): Summary {
  const engines = engineSummary(runs);
  return {
    deployed: new Set(runs.filter((r) => r.role === "deploy" && r.ok).map((r) => r.issue)).size,
    completion: completionOf(runs),
    costUsd: engines.reduce((a, e) => a + e.costUsd, 0),
    uncostedEngines: engines.filter((e) => e.costRuns === 0).map((e) => e.engine),
    improvements,
  };
}

export function recentRuns(runs: Run[], count = 10): Run[] {
  return [...runs].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, count);
}

export function engineSummary(
  runs: Run[],
): { engine: string; ok: number; n: number; costUsd: number; costRuns: number }[] {
  // costRuns: 비용이 기록된 런 수. 0이면 그 엔진은 비용을 보고하지 않는다(예: codex).
  const by = new Map<string, { ok: number; n: number; costUsd: number; costRuns: number }>();
  for (const r of runs) {
    if (!AGENT_ROLES.has(r.role) || !r.engine) continue;
    const cur = by.get(r.engine) ?? { ok: 0, n: 0, costUsd: 0, costRuns: 0 };
    by.set(r.engine, {
      ok: cur.ok + (r.ok ? 1 : 0),
      n: cur.n + 1,
      costUsd: cur.costUsd + (r.costUsd ?? 0),
      costRuns: cur.costRuns + (r.costUsd === null ? 0 : 1),
    });
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([engine, v]) => ({ engine, ...v }));
}

function eventKeys(r: Run): string[] {
  if (r.role === "improve") return [];
  const keys: string[] = [];
  if (!r.ok && r.role === "smoke") keys.push("smoke");
  else if (!r.ok && !IGNORED_REASONS.includes(r.failureReason ?? ""))
    keys.push(`run:${r.failureReason ?? "unknown"}`);
  if (r.role === "review") for (const f of r.findings ?? []) keys.push(`review:${f.category}`);
  return keys;
}

// 창 안 전체 건수가 많은 상위 범주의 주별 건수.
export function categoryTrend(
  runs: Run[],
  weeks: string[],
  top = 3,
): { key: string; counts: number[] }[] {
  const byKey = new Map<string, number[]>();
  for (const r of runs) {
    const i = weeks.indexOf(weekOf(r));
    if (i < 0) continue;
    for (const key of eventKeys(r)) {
      const counts = byKey.get(key) ?? weeks.map(() => 0);
      counts[i] = (counts[i] ?? 0) + 1;
      byKey.set(key, counts);
    }
  }
  const sum = (c: number[]) => c.reduce((a, b) => a + b, 0);
  return [...byKey.entries()]
    .sort(([ka, a], [kb, b]) => sum(b) - sum(a) || ka.localeCompare(kb))
    .slice(0, top)
    .map(([key, counts]) => ({ key, counts }));
}
