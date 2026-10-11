// 피드백 E2E는 실제 이슈를 연다. 로컬 서버와 PR 프리뷰에서만 실행하고, 그 외(프로덕션·별칭·해석 불가)는 건너뛴다.
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
