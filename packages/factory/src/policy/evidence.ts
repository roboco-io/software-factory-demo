import picomatch from "picomatch";

// spec 7.1.2의 테스트 파일 정의에 웹 컴포넌트 테스트(.test.tsx)를 더한다.
export const TEST_FILE_PATTERNS: readonly string[] = [
  "apps/*/test/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "apps/web/e2e/**",
];

// evidence-run은 이 경로에 파일을 쓴다. 작업 트리 밖을 가리킬 수 있는 경로는 받지 않는다.
// `-`로 시작하는 세그먼트는 vitest 옵션으로 해석될 수 있으므로 거부한다.
export function isSafeRelativePath(file: string): boolean {
  if (file.length === 0 || file.length > 300) return false;
  // 공백·제어 문자·bidi 문자·비ASCII를 거부하고 안전한 문자만 허용한다(역슬래시 포함 거부).
  if (!/^[A-Za-z0-9._/@+-]+$/.test(file) || file.startsWith("/")) return false;
  return file
    .split("/")
    .every((seg) => seg !== "" && seg !== "." && seg !== ".." && !seg.startsWith("-"));
}

export function isTestFile(file: string): boolean {
  return (
    isSafeRelativePath(file) && picomatch.isMatch(file, [...TEST_FILE_PATTERNS], { dot: true })
  );
}

export type SuiteName = "api" | "web" | "factory";

export interface SuiteRun {
  suite: SuiteName;
  filter: string;
  // 패키지 디렉토리 기준 상대 경로. `pnpm --filter <filter> exec vitest run <targets...>`에 넘긴다.
  targets: string[];
}

export const SUITES: readonly { suite: SuiteName; filter: string; dir: string }[] = [
  { suite: "api", filter: "api", dir: "apps/api/" },
  { suite: "web", filter: "web", dir: "apps/web/" },
  { suite: "factory", filter: "factory", dir: "packages/factory/" },
];

// Playwright E2E는 서버 두 개와 브라우저가 필요해 evidence에서 실행하지 않는다(판정 후보 2).
const E2E_DIR = "apps/web/e2e/";
const RUNNABLE = /\.test\.tsx?$/;

export function planSuites(files: string[]): { runs: SuiteRun[]; unsupported: string[] } {
  const runs = new Map<SuiteName, SuiteRun>();
  const unsupported: string[] = [];
  for (const f of files) {
    if (f.startsWith(E2E_DIR)) {
      unsupported.push(f);
      continue;
    }
    // 도우미 파일(test/helpers.ts 등)은 overlay에 덮어쓰기만 하고 직접 실행하지 않는다.
    if (!RUNNABLE.test(f)) continue;
    const spec = SUITES.find((s) => f.startsWith(s.dir));
    if (!spec) {
      unsupported.push(f);
      continue;
    }
    const run = runs.get(spec.suite) ?? { suite: spec.suite, filter: spec.filter, targets: [] };
    run.targets.push(f.slice(spec.dir.length));
    runs.set(spec.suite, run);
  }
  return { runs: [...runs.values()], unsupported };
}
