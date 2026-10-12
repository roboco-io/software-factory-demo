import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { isSafeRelativePath } from "./evidence";

export const EVAL_DIR = "factory/evals";
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FIXTURE_BYTES = 20 * 1024;

export const EvalCaseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("lint"),
    category: z.string().max(100),
    fixture: z.string().regex(/^[A-Za-z0-9._-]+$/), // 케이스 디렉토리 안의 파일 이름
    asPath: z.string().max(200).refine(isSafeRelativePath), // 이 경로에 있는 것처럼 lint한다
    rule: z.string().max(100), // 위반으로 보고되어야 하는 ruleId
  }),
  z.object({
    kind: z.literal("prompt-contains"),
    category: z.string().max(100),
    file: z.string().refine((f) => f === "AGENTS.md" || /^factory\/prompts\/[a-z-]+\.md$/.test(f)),
    text: z.string().min(10).max(500),
  }),
]);
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export interface LoadedCase {
  slug: string;
  spec: EvalCase;
  fixtureText: string | null;
}

// 보고된 ruleId 목록을 돌려준다. 실제 구현은 ESLint 기반 detector가 맡는다.
export interface Detector {
  lint(treeRoot: string, text: string, asPath: string): Promise<string[]>;
}

export function normalizeText(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function readFixture(dir: string, name: string): string {
  const p = path.join(dir, name);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    throw new Error("fixture 파일이 없다");
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("fixture가 일반 파일이 아니다");
  if (st.size > MAX_FIXTURE_BYTES) throw new Error("fixture가 20KB를 넘는다");
  return readFileSync(p, "utf8");
}

export function loadCases(treeRoot: string): { cases: LoadedCase[]; errors: string[] } {
  const cases: LoadedCase[] = [];
  const errors: string[] = [];
  const base = path.join(treeRoot, EVAL_DIR);
  let entries: string[];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return { cases, errors };
  }
  for (const slug of entries) {
    try {
      if (!SLUG.test(slug)) throw new Error("slug가 규칙에 맞지 않는다");
      const dir = path.join(base, slug);
      const spec = EvalCaseSchema.parse(parse(readFileSync(path.join(dir, "case.yml"), "utf8")));
      const fixtureText = spec.kind === "lint" ? readFixture(dir, spec.fixture) : null;
      cases.push({ slug, spec, fixtureText });
    } catch (e) {
      errors.push(`${slug}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  return { cases, errors };
}

export async function detects(treeRoot: string, c: LoadedCase, d: Detector): Promise<boolean> {
  const { spec } = c;
  if (spec.kind === "lint") {
    const ids = await d.lint(treeRoot, c.fixtureText ?? "", spec.asPath);
    return ids.includes(spec.rule);
  }
  try {
    const content = readFileSync(path.join(treeRoot, spec.file), "utf8");
    return normalizeText(content).includes(normalizeText(spec.text));
  } catch {
    return false;
  }
}
