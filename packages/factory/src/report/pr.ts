import { z } from "zod";
import { ENGINES } from "../agents/types";
import type { RiskResult } from "../policy/risk";
import { cell, codeCell, demote, inline, readMarker, writeMarker } from "./text";

export const PrMetaSchema = z.object({
  issue: z.number().int().positive(),
  role: z.enum(["implement", "improve"]),
  implementEngine: z.enum(ENGINES),
  implementModel: z.string().min(1),
  round: z.number().int().min(0),
});
export type PrMeta = z.infer<typeof PrMetaSchema>;

export interface PrReport {
  meta: PrMeta;
  summary: string;
  issueTitle: string;
  acceptanceCriteria: string[];
  checks: { name: string; ok: boolean }[];
  preview: string;
  risks: string[];
  risk: RiskResult;
  run: { engine: string; model: string; turns: number; durationMs: number; costUsd?: number };
}

const META = "factory:meta";
const MAX_FILE_ROWS = 50;

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}분 ${s % 60}초`;
}

export function extractRisks(summary: string): string[] {
  return summary
    .split(/\r?\n/)
    .map((l) => /^\s*남은 위험:\s*(.+)$/.exec(l)?.[1]?.trim())
    .filter((l): l is string => Boolean(l));
}

export function renderPrBody(r: PrReport): string {
  const files = r.risk.files
    .slice(0, MAX_FILE_ROWS)
    .map(
      (f) =>
        `| \`${codeCell(f.file)}\` | ${f.tier} | ${f.pattern ? `\`${codeCell(f.pattern)}\`` : "기본 등급"} |`,
    );
  const more =
    r.risk.files.length > MAX_FILE_ROWS ? [`외 ${r.risk.files.length - MAX_FILE_ROWS}개 파일`] : [];
  const cost =
    r.run.costUsd === undefined
      ? "추정 불가"
      : `$${r.run.costUsd.toFixed(2)} (엔진 추정치, 청구 금액 아님)`;
  return [
    "## 요약",
    "",
    (r.summary.trim() ? demote(r.summary.trim()) : "") || "(에이전트 요약 없음)",
    "",
    "## 이유",
    "",
    `Refs #${r.meta.issue} — ${inline(r.issueTitle)}`,
    "",
    "수용 기준:",
    ...(r.acceptanceCriteria.length > 0
      ? r.acceptanceCriteria.map((c) => `- ${inline(c)}`)
      : ["- (트리아지 수용 기준 없음)"]),
    "",
    "## 증거",
    "",
    "| 로컬 검사 | 결과 |",
    "|---|---|",
    ...r.checks.map((c) => `| \`${codeCell(c.name)}\` | ${c.ok ? "통과" : "실패"} |`),
    "",
    "필수 CI 체크(typecheck, lint, unit, realworld-api, e2e, risk-tier, evidence, eval)는 이 PR에서 다시 실행된다. evidence는 연결 이슈가 type:bug일 때 재현 테스트가 수정 전 코드에서 실패하고 이 PR에서 통과하는지 검사한다.",
    `프리뷰: ${inline(r.preview)}`,
    "",
    "## 남은 위험",
    "",
    ...(r.risks.length > 0
      ? r.risks.map((x) => `- ${inline(x)}`)
      : ["- 에이전트가 보고한 남은 위험 없음"]),
    "",
    "## 위험 등급과 근거",
    "",
    `**${r.risk.tier}** — 변경 파일 중 가장 높은 등급이다(factory/risk-policy.yml). 등급을 정한 파일:`,
    "",
    "| 파일 | 등급 | 규칙 |",
    "|---|---|---|",
    ...files,
    ...more,
    "",
    "## 실행 정보",
    "",
    "| 엔진 | 모델 | 턴 | 소요 시간 | 추정 비용 |",
    "|---|---|---|---|---|",
    `| ${cell(r.run.engine)} | ${cell(r.run.model)} | ${r.run.turns} | ${formatDuration(r.run.durationMs)} | ${cost} |`,
    "",
    writeMarker(META, r.meta),
  ].join("\n");
}

export function parsePrMeta(body: string): PrMeta | null {
  return readMarker(body, META, PrMetaSchema);
}

export function replaceMeta(body: string, meta: PrMeta): string {
  const stripped = body.replace(/\n*<!-- factory:meta \{.*?\} -->/g, "");
  return `${stripped}\n\n${writeMarker(META, meta)}`;
}
