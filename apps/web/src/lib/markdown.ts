import DOMPurify from "dompurify";
import { marked } from "marked";

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
