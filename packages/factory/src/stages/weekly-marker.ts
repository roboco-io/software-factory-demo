import { z } from "zod";
import type { Comment, Issue } from "../github/port";
import { readMarker } from "../report/text";
import { CandidateSchema } from "./collect";

// 주간 리포트 이슈 본문·코멘트의 표식 {"week": "YYYY-Www", "candidates": [...]}
export const REPORT_MARKER = "factory:report";

export const ReportMarkerSchema = z.object({
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  candidates: z.array(CandidateSchema).max(20),
});
export type ReportMarker = z.infer<typeof ReportMarkerSchema>;

// 봇이 쓴 이슈 본문과 코멘트 가운데 마지막 표식. 사람이 쓴 표식은 무시한다.
export function latestReportMarker(
  issue: Issue,
  comments: Comment[],
  botLogin: string,
): ReportMarker | null {
  const bodies = [
    ...(issue.author === botLogin ? [issue.body] : []),
    ...comments.filter((c) => c.author === botLogin).map((c) => c.body),
  ];
  for (const body of bodies.reverse()) {
    const marker = readMarker(body, REPORT_MARKER, ReportMarkerSchema);
    if (marker) return marker;
  }
  return null;
}
