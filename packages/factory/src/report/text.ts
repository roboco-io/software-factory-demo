import type { z } from "zod";

// 에이전트·이슈 텍스트가 팩토리 표식(HTML 주석)을 열거나 닫지 못하게 한다.
export function sanitize(text: string): string {
  return text.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}

export function writeMarker(name: string, value: unknown): string {
  const json = JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<!-- ${name} ${json} -->`;
}

export function readMarker<T>(body: string, name: string, schema: z.ZodType<T>): T | null {
  const re = new RegExp(`<!-- ${name} (\\{.*?\\}) -->`, "g");
  const last = [...body.matchAll(re)].at(-1);
  if (!last?.[1]) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(last[1]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
