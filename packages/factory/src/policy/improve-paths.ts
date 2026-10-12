import picomatch from "picomatch";
import { EVAL_DIR, SLUG } from "./eval-case";
import { isSafeRelativePath } from "./evidence";

// improve 역할(팩토리 자기개선)이 바꿀 수 있는 경로. 이 밖의 파일을 바꾸면 결과 전체를 버린다(spec 7.2.3).
export const IMPROVE_PATHS = [
  "AGENTS.md",
  "factory/prompts/**",
  "eslint.config.*",
  "factory/evals/**",
] as const;

const matchImprove = picomatch([...IMPROVE_PATHS], { dot: false });

export function isImprovePath(file: string): boolean {
  return isSafeRelativePath(file) && matchImprove(file);
}

// 변경 파일 가운데 평가 케이스 정의(factory/evals/<slug>/case.yml)의 slug.
// 새로 추가한 case.yml뿐 아니라 기존 case.yml을 수정한 경로도 포함한다. 봇이 기존 케이스를 수정하는 것은
// CI의 eval 체크가 거부하므로 여기서는 구분하지 않는다.
export function addedCaseSlugs(files: string[]): string[] {
  const slugs: string[] = [];
  for (const f of files) {
    if (!isSafeRelativePath(f)) continue;
    const parts = f.split("/");
    if (parts.length !== 4 || `${parts[0]}/${parts[1]}` !== EVAL_DIR || parts[3] !== "case.yml")
      continue;
    const slug = parts[2]!;
    if (SLUG.test(slug) && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}
