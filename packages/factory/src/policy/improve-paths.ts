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
