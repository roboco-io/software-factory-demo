import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { isSafeRelativePath } from "./evidence";

export const EVAL_DIR = "factory/evals";
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FIXTURE_BYTES = 20 * 1024;
const MAX_CASE_BYTES = 20 * 1024;
const MAX_PROMPT_BYTES = 200 * 1024;

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

// treeRoot 아래 상대 경로의 각 구성요소를 lstat해 symlink·비정규 파일을 거부하고 읽는다.
// PR이 제어하는 트리가 symlink로 러너의 다른 파일을 읽게 만드는 것을 막는다.
function readRegularFile(treeRoot: string, rel: string, maxBytes: number, label: string): string {
  const parts = rel.split("/");
  let cur = treeRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      throw new Error(`${label}이(가) 없다`);
    }
    if (st.isSymbolicLink()) throw new Error(`${label} 경로에 symlink가 있다`);
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory())
      throw new Error(`${label}이(가) 일반 파일이 아니다`);
    if (last && st.size > maxBytes) throw new Error(`${label}이(가) ${maxBytes / 1024}KB를 넘는다`);
  }
  return readFileSync(cur, "utf8");
}

export function loadCases(treeRoot: string): { cases: LoadedCase[]; errors: string[] } {
  const cases: LoadedCase[] = [];
  const errors: string[] = [];
  // factory, factory/evals 가 symlink이면 따라가지 않고 오류로 보고한다. 없으면 케이스가 없는 것이다.
  let dirOk = true;
  for (const rel of ["factory", EVAL_DIR]) {
    try {
      const st = lstatSync(path.join(treeRoot, rel));
      if (st.isSymbolicLink() || !st.isDirectory()) {
        errors.push(`${rel}: 일반 디렉토리가 아니다(symlink 포함)`);
        dirOk = false;
        break;
      }
    } catch {
      dirOk = false;
      break;
    }
  }
  if (!dirOk) return { cases, errors };
  const base = path.join(treeRoot, EVAL_DIR);
  let dirents;
  try {
    dirents = readdirSync(base, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1));
  } catch {
    return { cases, errors };
  }
  for (const e of dirents) {
    const slug = e.name;
    if (e.isSymbolicLink()) {
      errors.push(`${slug}: symlink 디렉토리는 허용되지 않는다`);
      continue;
    }
    if (!e.isDirectory()) continue;
    try {
      if (!SLUG.test(slug)) throw new Error("slug가 규칙에 맞지 않는다");
      const rel = `${EVAL_DIR}/${slug}`;
      const yml = readRegularFile(treeRoot, `${rel}/case.yml`, MAX_CASE_BYTES, "case.yml");
      const spec = EvalCaseSchema.parse(parse(yml));
      const fixtureText =
        spec.kind === "lint"
          ? readRegularFile(treeRoot, `${rel}/${spec.fixture}`, MAX_FIXTURE_BYTES, "fixture")
          : null;
      cases.push({ slug, spec, fixtureText });
    } catch (err) {
      errors.push(`${slug}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
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
    const content = readRegularFile(treeRoot, spec.file, MAX_PROMPT_BYTES, spec.file);
    return normalizeText(content).includes(normalizeText(spec.text));
  } catch {
    return false;
  }
}
