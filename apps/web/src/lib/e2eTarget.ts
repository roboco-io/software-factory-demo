// 피드백 E2E는 로컬 서버와 PR 프리뷰에서만 실행한다. 이 환경의 API에는 INTAKE_TOKEN이 없어 유입 이슈가 열리지 않는다.
// 프로덕션에서 실행하면 실제 피드백 이슈가 열리므로, 그 외(프로덕션·별칭·해석 불가)는 건너뛴다.
export function feedbackAllowed(url: string | undefined): boolean {
  if (!url) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return true;
  return /\/pr-preview\/pr-\d+\//.test(parsed.pathname);
}
